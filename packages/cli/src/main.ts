import { readFileSync, writeFileSync } from 'node:fs';
import {
  BUNDLE_HEADERS_UNANCHORED,
  HEIGHT_IS_A_CLAIM,
  L2_EXECUTED_LEAF_RESIDUAL,
  verifyCustodyBundle,
  verifyProofBundle,
  verifySatGenealogy,
  type CustodyBundleJson,
  type ProofBundleJson,
  type SatGenealogyBundleJson,
} from '@ordspv/core';
import { classifyBundle, type BundleKind } from './bundlekind.js';
import { writeBundleFile } from './bundlewrite.js';
import { contentResiduals, refusalJson, refusalReport, type RefusalContext } from './notes.js';
import {
  buildProofBundle,
  EsploraBackend,
  OrdResolver,
  parseOrdUri,
  DEFAULT_ANCHOR_SOURCES,
  DEFAULT_ESPLORA,
  fetchCustody,
  fetchSatIdentity,
  normalizeBaseUrl,
  type AttemptInfo,
  type BackendLimitsInit,
  type VerificationMode,
  type WitnessSectionMode,
} from '@ordspv/fetch';

/**
 * ord-resolve: resolve and verify ord: URIs from the command line.
 *
 *   ord-resolve <uri>                          resolve, bytes to stdout
 *   ord-resolve <uri> --out file.png           resolve to a file
 *   ord-resolve <uri> --json                   resolution report as JSON
 *   ord-resolve <uri> --verify none|L1|L2|L3   verification level (default L2)
 *   ord-resolve proof <id> [--level L2|L3]     emit a proof bundle
 *   ord-resolve verify <bundle.json>           verify a proof, custody or sat bundle offline
 *   ord-resolve custody <id> [--bundle FILE]   prove where the inscribed sat is
 *   ord-resolve sat <id> [--max-steps N]       prove which sat it is
 *   ord-resolve parse <uri>                    normalize/inspect a URI
 *
 * Options: --esplora url[,url]   --gateway url[,url]   --anchor-source url[,url]
 *          --witness-section always|when-needed   --timeout-ms N
 */

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
}

// the sentences every surface shares live in core (notes.ts), so the CLI and
// the extension viewer state the same residual in the same words
const RESIDUAL = L2_EXECUTED_LEAF_RESIDUAL;
const HEIGHT_CLAIM = HEIGHT_IS_A_CLAIM;

/**
 * How firmly the envelope is bound to the commit output. A single-leaf taptree
 * proves nothing else was committed by the prevout's author. It does not prove
 * the leaf was executed, since the output is spendable by key path too and the
 * txid commits to neither the witness nor the spend path. Only a wtxid-anchored
 * reveal shows the witness the chain saw.
 */
function envelopeNote(r: {
  controlBlockDepth: number;
  singleLeafTree: boolean;
  singleInputReveal: boolean;
  indexProof: 'wtxid' | 'single-input';
}): string {
  const tree = r.singleLeafTree
    ? 'bound to the commit output, single-leaf taptree'
    : `bound to the commit output, taptree depth ${r.controlBlockDepth} (the author committed other leaves)`;
  const index =
    r.indexProof === 'wtxid'
      ? 'index proven by the block witness commitment'
      : `index pinned by the single input; ${RESIDUAL}`;
  return `${tree}, ${r.singleInputReveal ? 'single-input reveal' : 'multi-input reveal'}, ${index}`;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Flags that carry a value. `parseArgs` cannot tell `--max-steps --json` from a
 * boolean flag, so a value flag left without one would otherwise fall through
 * to its default and run silently at a setting the caller did not ask for.
 */
const VALUE_FLAGS = new Set([
  'esplora',
  'gateway',
  'anchor-source',
  'witness-section',
  'level',
  'max-hops',
  'max-steps',
  'timeout-ms',
  'bundle',
  'verify',
  'out',
]);

/**
 * Which commands consult each value flag. A value flag on any other command
 * is a misplaced flag, refused the way --max-hops outside custody always was:
 * a flag that changes nothing must not be accepted in silence, because the
 * caller believes it changed something. Unknown flags are refused for the
 * same reason, and for a sharper one: parseArgs reads the token after any
 * --name as its value, so a typo like --bundel swallows the filename it was
 * meant to receive and the command runs with neither.
 */
const FLAG_COMMANDS: Record<string, readonly string[]> = {
  'esplora': ['proof', 'custody', 'sat', 'resolve'],
  'gateway': ['resolve'],
  'anchor-source': ['custody', 'sat', 'resolve'],
  'witness-section': ['custody', 'sat'],
  'level': ['proof'],
  'max-hops': ['custody'],
  'max-steps': ['sat', 'verify'],
  'timeout-ms': ['proof', 'custody', 'sat', 'resolve'],
  'bundle': ['custody', 'sat'],
  'verify': ['resolve'],
  'out': ['resolve'],
};

/** Commands with their own dispatch arm; any other first token resolves. */
const COMMANDS = new Set(['parse', 'proof', 'custody', 'sat', 'verify']);

/** A table row as the refusal names it: `the sat and verify commands`. */
function flagCommandList(row: readonly string[]): string {
  if (row.length === 1) return `the ${row[0]} command`;
  return `the ${row.slice(0, -1).join(', ')} and ${row[row.length - 1]} commands`;
}

/**
 * The one transport limit with a flag. The whole-request deadline bounds the
 * caller's own patience against the caller's own link, and the caller is the
 * only one who knows what that link can do. The byte caps and the retry
 * policy stay library-only, deliberately: they bound what an untrusted
 * backend can spend of the caller's memory and time, and raising them from
 * the command line in response to a backend's behaviour weakens a safety
 * property in the wrong direction.
 */
function timeoutLimits(
  flags: Map<string, string | boolean>,
  command: string,
): BackendLimitsInit | undefined {
  const arg = str(flags.get('timeout-ms'));
  if (arg === undefined) return undefined;
  const timeoutMs = Number(arg);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    fail(`${command}: --timeout-ms must be a positive integer`, 2);
  }
  return { timeoutMs };
}

/**
 * Say that the build moved to another backend, and why.
 *
 * A rotation can cost a whole second walk, which on a deep ancestry is
 * thousands of requests and tens of minutes, and a caller watching a terminal
 * cannot tell that from a hang. The first attempt says nothing, since nothing
 * has gone wrong yet.
 */
function reportAttempt(info: AttemptInfo): void {
  if (!info.cause) return;
  console.error(
    `retrying against ${info.baseUrl} (attempt ${info.attempt + 1} of ${info.total}); ` +
      `previous attempt ended with: ${info.cause.message}`,
  );
}

/**
 * Report a failure the same way on all three commands.
 *
 * The failures that are not forgeries carry their own exit code, and the code
 * does not depend on which command raised them: a path outside v1's domain
 * exits 4 whether the caller read a bundle back or resolved the same
 * inscription live. A `--json` caller reads the class on stdout, since a
 * scripted caller has no other discriminator.
 */
function failFrom(
  e: unknown,
  context: RefusalContext,
  command: string,
  json: boolean,
  invalid: (message: string) => string,
): never {
  const refusal = refusalReport(e, context, command);
  if (json) {
    console.log(refusalJson(e, refusal));
    process.exit(refusal ? refusal.code : 1);
  }
  if (refusal) fail(refusal.message, refusal.code);
  fail(invalid((e as Error).message));
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length === 0 || flags.has('help')) {
    console.error(
      [
        'usage:',
        '  ord-resolve <uri> [--verify none|L1|L2|L3] [--out FILE] [--json]',
        '  ord-resolve proof <inscription-id> [--level L2|L3]',
        '  ord-resolve verify <bundle.json> [--json] [--max-steps N]',
        '                                              proof, custody or sat genealogy',
        '      a successful verify prints its JSON report whether or not --json is',
        '      passed; the flag controls the failure channel',
        '  ord-resolve custody <inscription-id> [--json] [--bundle FILE] [--max-hops N]',
        '  ord-resolve sat <inscription-id> [--json] [--bundle FILE] [--max-steps N]',
        '  ord-resolve parse <uri>',
        'options: --esplora url[,url]  --gateway url[,url]  --anchor-source url[,url]',
        '  --witness-section always|when-needed   (custody, sat; default when-needed)',
        '      always pays one raw block request so the reveal carries its wtxid',
        '      proof, which proves the envelope index and the witness the chain ran',
        '  --max-steps N   funding steps the sat walk follows, and the bound the',
        '      verifier reads a genealogy bundle under',
        '  --max-hops N    confirmed transfers the custody walk follows (custody only;',
        '      the custody verifier reads no cap)',
        '  --timeout-ms N  whole-request deadline in milliseconds for each backend',
        '      request; a failing request is retried up to 4 times, each attempt under',
        '      its own deadline (proof, custody, sat, resolve)',
        'exit codes: 0 ok  1 INVALID  2 usage  3 UNPROVEN  4 OUT OF SCOPE',
        '  5 INCOMPLETE   1 is a document that failed verification, 5 is a build',
        '      no configured backend completed, and nothing was verified',
        '  the code does not depend on the command; --json prints the class',
      ].join('\n'),
    );
    process.exit(positional.length === 0 ? 2 : 0);
  }

  // refuse a value flag that swallowed no value before any default can stand
  // in for what the caller left out; '' is the same mistake in a different
  // shape, and the write sites test truthiness, so it would exit 0 having
  // written nothing
  for (const name of VALUE_FLAGS) {
    const v = flags.get(name);
    if (v === true || v === '') fail(`--${name} needs a value`, 2);
  }

  // canonical form on the way in, so a case variant of a serving backend
  // cannot be handed to anchoring as though it were a separate operator
  const esplora = (str(flags.get('esplora'))?.split(',') ?? DEFAULT_ESPLORA).map(normalizeBaseUrl);
  const gateways = str(flags.get('gateway'))?.split(',');
  // header attesters; distinct from --esplora, which serves proofs
  const anchorSources = (
    str(flags.get('anchor-source'))?.split(',') ?? DEFAULT_ANCHOR_SOURCES
  ).map(normalizeBaseUrl);

  const witnessSectionArg = str(flags.get('witness-section')) ?? 'when-needed';
  if (witnessSectionArg !== 'always' && witnessSectionArg !== 'when-needed') {
    fail('--witness-section must be always or when-needed', 2);
  }
  const witnessSection = witnessSectionArg as WitnessSectionMode;

  const [command] = positional;

  // the misplacement table, enforced once the command is known. --json is
  // exempt everywhere: it is boolean, so it can swallow no value, and proof
  // and parse already emit JSON, so its intent is satisfied rather than
  // ignored. --help was consumed by the usage branch above
  const flagCommand = COMMANDS.has(command) ? command : 'resolve';
  for (const name of flags.keys()) {
    if (name === 'json' || name === 'help') continue;
    const row = FLAG_COMMANDS[name];
    if (row === undefined) fail(`unknown flag --${name}`, 2);
    if (!row.includes(flagCommand)) {
      fail(`--${name} applies to ${flagCommandList(row)}`, 2);
    }
  }

  if (command === 'parse') {
    const uri = positional[1] ?? fail('parse: missing uri', 2);
    console.log(JSON.stringify(parseOrdUri(uri), (_, v) => (v instanceof Uint8Array ? undefined : v), 2));
    return;
  }

  if (command === 'proof') {
    const idArg = positional[1] ?? fail('proof: missing inscription id', 2);
    const level = (str(flags.get('level'))?.toUpperCase() ?? 'L2') as 'L2' | 'L3';
    if (level !== 'L2' && level !== 'L3') fail('proof: --level must be L2 or L3', 2);
    const parsed = parseOrdUri(idArg);
    const limits = timeoutLimits(flags, 'proof');
    const errors: string[] = [];
    for (const base of esplora) {
      try {
        const bundle = await buildProofBundle(new EsploraBackend(base, undefined, limits), parsed.id, level);
        console.log(JSON.stringify(bundle, null, 2));
        return;
      } catch (e) {
        errors.push(`${base}: ${(e as Error).message}`);
      }
    }
    fail(`could not build proof:\n${errors.join('\n')}`);
  }

  if (command === 'custody') {
    const idArg = positional[1] ?? fail('custody: missing inscription id', 2);
    const parsed = parseOrdUri(idArg);
    try {
      const maxHopsArg = str(flags.get('max-hops'));
      let maxHops: number | undefined;
      if (maxHopsArg !== undefined) {
        maxHops = Number(maxHopsArg);
        if (!Number.isInteger(maxHops) || maxHops < 1) {
          fail('custody: --max-hops must be a positive integer', 2);
        }
      }
      const res = await fetchCustody(`${parsed.id.txid}i${parsed.id.index}`, {
        esplora,
        anchorSources,
        maxHops,
        witnessSection,
        limits: timeoutLimits(flags, 'custody'),
        onAttempt: reportAttempt,
      });
      if (flags.has('json')) {
        console.log(
          JSON.stringify(
            {
              inscriptionId: res.custody.inscriptionId,
              satpoint: res.custody.satpoint,
              genesis: res.custody.genesis,
              hops: res.custody.hops,
              height: res.custody.height,
              path: res.custody.path,
              controlBlockDepth: res.custody.controlBlockDepth,
              singleLeafTree: res.custody.singleLeafTree,
              singleInputReveal: res.custody.singleInputReveal,
              indexProof: res.custody.indexProof,
              // the same sentence the human branch prints; a scripted caller
              // reads the residual here or nowhere
              note: envelopeNote(res.custody),
              tip: res.tip,
              pendingSpendTxid: res.pendingSpendTxid,
            },
            (_, v) => (typeof v === 'bigint' ? v.toString() : v),
            2,
          ),
        );
      } else {
        const sp = res.custody.satpoint;
        console.log(`inscription ${res.custody.inscriptionId}`);
        console.log(`satpoint    ${sp.txid}:${sp.vout}:${sp.offset} (proven through ${res.custody.hops} hop${res.custody.hops === 1 ? '' : 's'}, last at height ${res.custody.height})`);
        console.log(`envelope    ${envelopeNote(res.custody)}`);
        for (const t of res.tip) console.log(`tip         ${t.source}: ${t.state}${t.detail ? ` (${t.detail})` : ''}`);
        if (res.pendingSpendTxid) console.log(`pending     unconfirmed spend ${res.pendingSpendTxid}`);
      }
      // the satpoint the walk proved is printed; from here a failure is the
      // write's alone, the same order the sat branch keeps
      const bundleOut = str(flags.get('bundle'));
      if (bundleOut) {
        const failure = writeBundleFile('custody', bundleOut, res.bundle);
        if (failure) fail(failure, 1);
        if (!flags.has('json')) console.log(`bundle      ${bundleOut}`);
      }
      return;
    } catch (e) {
      failFrom(e, 'live', 'custody', flags.has('json'), (m) => `custody: ${m}`);
    }
  }

  if (command === 'sat') {
    const idArg = positional[1] ?? fail('sat: missing inscription id', 2);
    const parsed = parseOrdUri(idArg);
    try {
      const maxStepsArg = str(flags.get('max-steps'));
      let maxSteps: number | undefined;
      if (maxStepsArg !== undefined) {
        maxSteps = Number(maxStepsArg);
        if (!Number.isInteger(maxSteps) || maxSteps < 1) {
          fail('sat: --max-steps must be a positive integer', 2);
        }
      }
      const res = await fetchSatIdentity(`${parsed.id.txid}i${parsed.id.index}`, {
        esplora,
        anchorSources,
        maxSteps,
        witnessSection,
        limits: timeoutLimits(flags, 'sat'),
        onAttempt: reportAttempt,
      });
      const bundleOut = str(flags.get('bundle'));
      const { identity } = res;
      if (flags.has('json')) {
        console.log(
          JSON.stringify(
            {
              inscriptionId: identity.inscriptionId,
              sat: identity.sat,
              name: identity.name,
              rarity: identity.rarity,
              coinbaseHeight: identity.coinbaseHeight,
              depth: identity.depth,
              revealPosition: identity.revealPosition,
              controlBlockDepth: identity.controlBlockDepth,
              singleLeafTree: identity.singleLeafTree,
              singleInputReveal: identity.singleInputReveal,
              indexProof: identity.indexProof,
              // the same sentence the human branch prints; a scripted caller
              // reads the residual here or nowhere
              note: envelopeNote(identity),
              headerTrust: res.headerTrust,
            },
            (_, v) => (typeof v === 'bigint' ? v.toString() : v),
            2,
          ),
        );
      } else {
        console.log(`inscription ${identity.inscriptionId}`);
        console.log(`sat         ${identity.sat} (${identity.name}, ${identity.rarity})`);
        console.log(
          `mined       block ${identity.coinbaseHeight}, traced through ${identity.depth} funding tx${identity.depth === 1 ? '' : 's'}`,
        );
        console.log(`envelope    ${envelopeNote(identity)}`);
      }
      // the identity the walk proved is printed; from here a failure is the
      // write's alone, on stderr under its own message, with the exit still
      // nonzero so a script notices the missing file
      if (bundleOut) {
        const failure = writeBundleFile('sat', bundleOut, res.bundle);
        if (failure) fail(failure, 1);
        if (!flags.has('json')) console.log(`bundle      ${bundleOut}`);
      }
      return;
    } catch (e) {
      failFrom(e, 'live', 'sat', flags.has('json'), (m) => `sat: ${m}`);
    }
  }

  if (command === 'verify') {
    const file = positional[1] ?? fail('verify: missing bundle file', 2);
    // a file that cannot be read is a usage failure, and bytes that do not
    // parse are a defective document; neither deserves a stack trace
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      fail(`verify: cannot read ${file}: ${(e as Error).message}`, 2);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      fail(`verify: ${file} is not JSON: ${(e as Error).message}`);
    }
    let kind: BundleKind;
    try {
      kind = classifyBundle(parsed);
    } catch (e) {
      fail(`verify: ${(e as Error).message}`, 2);
    }
    // the verifier's own step bound, raisable for a bundle whose ancestry
    // really is that deep; it bounds work on an untrusted document, so the
    // caller has to ask for the extra work by name
    const verifyMaxStepsArg = str(flags.get('max-steps'));
    let verifyMaxSteps: number | undefined;
    if (verifyMaxStepsArg !== undefined) {
      if (kind !== 'genealogy') {
        fail(`verify: --max-steps applies to sat genealogy bundles, this is a ${kind} bundle`, 2);
      }
      verifyMaxSteps = Number(verifyMaxStepsArg);
      if (!Number.isInteger(verifyMaxSteps) || verifyMaxSteps < 1) {
        fail('verify: --max-steps must be a positive integer', 2);
      }
    }
    const anchorNote =
      `header PoW verified; anchor the block hash against your own chain view; ` +
      `${HEIGHT_CLAIM}`;
    // a bundle whose index rests on anything but a wtxid anchor carries the
    // level 2 residual, and the JSON is the only place a scripted caller sees it
    const indexNote = (indexProof: 'wtxid' | 'single-input'): string =>
      indexProof === 'wtxid' ? anchorNote : `${anchorNote}; ${RESIDUAL}`;
    try {
      if (kind === 'genealogy') {
        const bundle = parsed as SatGenealogyBundleJson;
        const result = verifySatGenealogy(bundle, { maxSteps: verifyMaxSteps });
        console.log(
          JSON.stringify(
            {
              ok: true,
              kind,
              inscriptionId: result.inscriptionId,
              sat: result.sat.toString(),
              name: result.name,
              rarity: result.rarity,
              coinbaseHeight: result.coinbaseHeight,
              depth: result.depth,
              revealPosition: result.revealPosition.toString(),
              controlBlockDepth: result.controlBlockDepth,
              singleLeafTree: result.singleLeafTree,
              singleInputReveal: result.singleInputReveal,
              indexProof: result.indexProof,
              // the two endpoints the bundle proves into headers
              reveal: { height: bundle.reveal.block.height, block: bundle.reveal.block.hash },
              coinbase: { height: bundle.coinbase.block.height, block: bundle.coinbase.block.hash },
              // no anchor is supplied to an offline verification today, so this
              // is false on every bundle. The field exists so a reader is told
              // rather than left to infer it, and a caller that later supplies
              // one has somewhere to read the answer
              anchored: false,
              note: indexNote(result.indexProof),
            },
            null,
            2,
          ),
        );
        console.error(BUNDLE_HEADERS_UNANCHORED);
        return;
      }
      if (kind === 'custody') {
        const result = verifyCustodyBundle(parsed as CustodyBundleJson);
        console.log(
          JSON.stringify(
            {
              ok: true,
              kind,
              inscriptionId: result.inscriptionId,
              // the same object shape the live custody --json emits, so a
              // scripted caller reads one satpoint shape on both surfaces
              satpoint: result.satpoint,
              hops: result.hops,
              height: result.height,
              controlBlockDepth: result.controlBlockDepth,
              singleLeafTree: result.singleLeafTree,
              singleInputReveal: result.singleInputReveal,
              indexProof: result.indexProof,
              anchored: false,
              note: indexNote(result.indexProof),
            },
            (_, v) => (typeof v === 'bigint' ? v.toString() : v),
            2,
          ),
        );
        console.error(BUNDLE_HEADERS_UNANCHORED);
        return;
      }
      const result = verifyProofBundle(parsed as ProofBundleJson);
      // below L3 the content path carries the same executed-leaf residual the
      // other two branches print, and a multi-input reveal there is the one
      // case a gateway can renumber without the inscriber
      const proofNote = [anchorNote, ...contentResiduals(result.level, result.l2)];
      console.log(
        JSON.stringify(
          {
            ok: true,
            kind,
            level: result.level,
            inscriptionId: result.inscriptionId,
            block: result.header.hash,
            height: result.height,
            contentType: result.inscription.contentType,
            contentLength: result.inscription.body?.length ?? 0,
            l2Assurances: result.l2,
            // the same field the other two kinds carry, so a scripted caller
            // reads one answer for every bundle `verify` accepts rather than
            // undefined on one of the three
            anchored: false,
            note: proofNote.join('; '),
          },
          null,
          2,
        ),
      );
      console.error(BUNDLE_HEADERS_UNANCHORED);
      return;
    } catch (e) {
      // four refusals are not claims of forgery: a bundle that cannot prove
      // one fact offline is a different thing from a bundle that contradicts
      // itself, and each gets its own prefix and exit code
      failFrom(e, 'verify', 'verify', flags.has('json'), (m) => `bundle INVALID: ${m}`);
    }
  }

  // default: resolve <uri>
  const uri = command;
  const verifyArg = str(flags.get('verify')) ?? 'L2';
  // case-normalized the way --level is, storing the canonical form
  const verification = (
    verifyArg.toLowerCase() === 'none' ? 'none' : verifyArg.toUpperCase()
  ) as VerificationMode;
  if (!['none', 'L1', 'L2', 'L3'].includes(verification)) fail('--verify must be none|L1|L2|L3', 2);

  const resolver = new OrdResolver({
    esplora,
    anchorSources,
    ordGateways: gateways,
    verification,
    limits: timeoutLimits(flags, 'resolve'),
  });
  try {
    const result = await resolver.resolve(uri);
    // the same residual `verify` prints, on the command that renders bytes:
    // the booleans in `verification.l2` say what was committed, and a
    // multi-input reveal below L3 leaves the numbering open
    const residual = result.verification.l2
      ? contentResiduals(result.verification.level, result.verification.l2)
      : [];
    if (flags.has('json')) {
      console.log(
        JSON.stringify(
          {
            uri: result.uri.canonical,
            contentType: result.contentType,
            contentEncoding: result.contentEncoding,
            decoded: result.decoded,
            bytes: result.body.length,
            viaDelegate: result.viaDelegate,
            metadataJson: result.metadataJson,
            verification: result.verification,
            // a scripted caller reads the residual here or nowhere
            note: residual.length ? residual.join('; ') : undefined,
          },
          null,
          2,
        ),
      );
    }
    const out = str(flags.get('out'));
    if (out) {
      writeFileSync(out, result.body);
      console.error(`wrote ${result.body.length} bytes to ${out} [${result.verification.level}]`);
    } else if (!flags.has('json')) {
      process.stdout.write(result.body);
      console.error(
        `\n[${result.verification.level}] ${result.contentType ?? 'application/octet-stream'} ` +
          `${result.body.length} bytes  block=${result.verification.blockHash ?? '-'}` +
          (residual.length ? `\nresidual: ${residual.join('; ')}` : ''),
      );
    }
  } catch (e) {
    fail((e as Error).message);
  }
}

// every command's classified failures already exited through their own paths;
// whatever reaches here gets one line on stderr, no stack, exit 1
main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
