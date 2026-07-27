import { readFileSync, writeFileSync } from 'node:fs';
import {
  formatSatpoint,
  verifyCustodyBundle,
  verifyProofBundle,
  verifySatGenealogy,
  type CustodyBundleJson,
  type ProofBundleJson,
  type SatGenealogyBundleJson,
} from '@ordspv/core';
import { classifyBundle, type BundleKind } from './bundlekind.js';
import {
  buildProofBundle,
  EsploraBackend,
  OrdResolver,
  parseOrdUri,
  DEFAULT_ANCHOR_SOURCES,
  DEFAULT_ESPLORA,
  fetchCustody,
  fetchSatIdentity,
  type VerificationMode,
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
 *   ord-resolve custody <id>                   prove where the inscribed sat is
 *   ord-resolve sat <id> [--max-steps N]       prove which sat it is
 *   ord-resolve parse <uri>                    normalize/inspect a URI
 *
 * Options: --esplora url[,url]   --gateway url[,url]   --anchor-source url[,url]
 */

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
}

/**
 * How firmly the envelope is bound to the commit output. A single-leaf taptree
 * proves nothing else was committed; a deeper one leaves the author able to
 * present another leaf they committed, which is the L2 residual.
 */
function envelopeNote(r: { controlBlockDepth: number; singleLeafTree: boolean }): string {
  return r.singleLeafTree
    ? 'bound to the commit output, single-leaf taptree'
    : `bound to the commit output, taptree depth ${r.controlBlockDepth} (the author committed other leaves)`;
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

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length === 0 || flags.has('help')) {
    console.error(
      [
        'usage:',
        '  ord-resolve <uri> [--verify none|L1|L2|L3] [--out FILE] [--json]',
        '  ord-resolve proof <inscription-id> [--level L2|L3]',
        '  ord-resolve verify <bundle.json>            proof, custody or sat genealogy',
        '  ord-resolve custody <inscription-id> [--json]',
        '  ord-resolve sat <inscription-id> [--json] [--bundle FILE] [--max-steps N]',
        '  ord-resolve parse <uri>',
        'options: --esplora url[,url]  --gateway url[,url]  --anchor-source url[,url]',
      ].join('\n'),
    );
    process.exit(positional.length === 0 ? 2 : 0);
  }

  const esplora = str(flags.get('esplora'))?.split(',') ?? DEFAULT_ESPLORA;
  const gateways = str(flags.get('gateway'))?.split(',');
  // header attesters; distinct from --esplora, which serves proofs
  const anchorSources = str(flags.get('anchor-source'))?.split(',') ?? DEFAULT_ANCHOR_SOURCES;

  const [command] = positional;

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
    const errors: string[] = [];
    for (const base of esplora) {
      try {
        const bundle = await buildProofBundle(new EsploraBackend(base), parsed.id, level);
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
      const res = await fetchCustody(`${parsed.id.txid}i${parsed.id.index}`, {
        esplora,
        anchorSources,
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
      return;
    } catch (e) {
      fail(`custody: ${(e as Error).message}`);
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
      });
      const bundleOut = str(flags.get('bundle'));
      if (bundleOut) writeFileSync(bundleOut, JSON.stringify(res.bundle, null, 2));
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
        if (bundleOut) console.log(`bundle      ${bundleOut}`);
      }
      return;
    } catch (e) {
      fail(`sat: ${(e as Error).message}`);
    }
  }

  if (command === 'verify') {
    const file = positional[1] ?? fail('verify: missing bundle file', 2);
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    let kind: BundleKind;
    try {
      kind = classifyBundle(parsed);
    } catch (e) {
      fail(`verify: ${(e as Error).message}`, 2);
    }
    const anchorNote = 'header PoW verified; anchor the block hash against your own chain view';
    try {
      if (kind === 'genealogy') {
        const bundle = parsed as SatGenealogyBundleJson;
        const result = verifySatGenealogy(bundle);
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
              // the two endpoints the bundle proves into headers
              reveal: { height: bundle.reveal.block.height, block: bundle.reveal.block.hash },
              coinbase: { height: bundle.coinbase.block.height, block: bundle.coinbase.block.hash },
              note: anchorNote,
            },
            null,
            2,
          ),
        );
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
              satpoint: formatSatpoint(result.satpoint),
              hops: result.hops,
              height: result.height,
              controlBlockDepth: result.controlBlockDepth,
              singleLeafTree: result.singleLeafTree,
              note: anchorNote,
            },
            (_, v) => (typeof v === 'bigint' ? v.toString() : v),
            2,
          ),
        );
        return;
      }
      const result = verifyProofBundle(parsed as ProofBundleJson);
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
            note: anchorNote,
          },
          null,
          2,
        ),
      );
      return;
    } catch (e) {
      fail(`bundle INVALID: ${(e as Error).message}`);
    }
  }

  // default: resolve <uri>
  const uri = command;
  const verification = (str(flags.get('verify')) ?? 'L2') as VerificationMode;
  if (!['none', 'L1', 'L2', 'L3'].includes(verification)) fail('--verify must be none|L1|L2|L3', 2);

  const resolver = new OrdResolver({ esplora, anchorSources, ordGateways: gateways, verification });
  try {
    const result = await resolver.resolve(uri);
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
          `${result.body.length} bytes  block=${result.verification.blockHash ?? '-'}`,
      );
    }
  } catch (e) {
    fail((e as Error).message);
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
