import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  SatFundingIncompleteError,
  SatPositionError,
  SatStepLimitError,
  hexToBytes,
  parseTx,
} from '@ordspv/core';
import {
  CustodyError,
  CustodyHopLimitError,
  SatIdentityError,
  WitnessSectionUnavailableError,
} from '@ordspv/fetch';
import { contentResiduals, refusalJson, refusalReport } from '../src/notes.js';

/**
 * What `ord-resolve verify` tells a reader about the limits of an offline
 * verification. The command is run for real against vendored mainnet bundles,
 * so the note is read off the same code path a user takes.
 *
 * Two things must reach the JSON: the residual that every level below L3
 * carries on the content path, since that is the one path a gateway alone can
 * renumber; and the fact that a printed block height is the serving backend's
 * claim until the caller anchors the hash at that height.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN = join(ROOT, 'packages/cli/src/main.ts');
const EXT = join(ROOT, 'fixtures/extended');

// L2 proof bundles: one whose reveal spends a single input, one whose reveal
// spends three (fixtures/extended/SOURCES.md records their provenance)
const SINGLE_INPUT = '6dc2c16a74dedcae46300b2058ebadc7ca78aea78236459662375c8d7d9804dbi0';
const MULTI_INPUT = '52b4ea10c2518c954c73594e403ccfb2d50044f5a3b09a224dfa3bf06dd1d499i0';

function verify(id: string): Record<string, unknown> {
  const out = execFileSync(
    'npx',
    ['tsx', MAIN, 'verify', join(EXT, `${id}.bundle.json`)],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

describe('ord-resolve verify notes', { timeout: 60_000 }, () => {
  it('prints the L2 residual and the height caveat on a proof bundle', () => {
    const res = verify(SINGLE_INPUT);
    expect(res.ok).toBe(true);
    expect(res.level).toBe('L2');
    const note = String(res.note);
    expect(note).toMatch(/anchor the block hash against your own chain view/);
    expect(note).toMatch(/block heights are the serving backend's claim/);
    expect(note).toMatch(/only a wtxid anchor proves the presented witness/);
    // one input, so nothing to renumber
    expect(note).not.toMatch(/envelope numbering/);
  });

  it('says a proof bundle anchored no header, the way the other two kinds do', () => {
    // the field is how a scripted caller reads it, and it used to be
    // undefined on one of the three kinds `verify` accepts
    const r = spawnSync('npx', ['tsx', MAIN, 'verify', join(EXT, `${SINGLE_INPUT}.bundle.json`)], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.kind).toBe('proof');
    expect(parsed.anchored).toBe(false);
    expect(r.stderr).toMatch(/no header in this bundle was anchored/);
  });

  it('adds the numbering warning when the reveal spends several inputs', () => {
    const res = verify(MULTI_INPUT);
    expect(res.ok).toBe(true);
    expect((res.l2Assurances as { singleInputReveal: boolean }).singleInputReveal).toBe(false);
    const note = String(res.note);
    expect(note).toMatch(/only a wtxid anchor proves the presented witness/);
    expect(note).toMatch(/envelope numbering is not proven at L2/);
    expect(note).toMatch(/block heights are the serving backend's claim/);
  });
});

/**
 * What `ord-resolve verify` calls a bundle it could not verify. Three refusals
 * are not claims of forgery, and this command is where that distinction is
 * read, so each gets its own prefix and its own exit code.
 *
 * The custody bundles here are assembled offline from the same vendored
 * mainnet proof bundles, so their headers are real and clear the default
 * proof-of-work floor the command applies.
 */
describe('ord-resolve verify refusals', { timeout: 60_000 }, () => {
  const TMP = mkdtempSync(join(tmpdir(), 'ordspv-verify-'));

  function fixture(id: string): Record<string, any> {
    return JSON.parse(readFileSync(join(EXT, `${id}.bundle.json`), 'utf8'));
  }

  /** hop 0 of a custody bundle, taken from a proof bundle's reveal */
  function revealHop(b: Record<string, any>, prevTxs: string[]): Record<string, unknown> {
    return {
      block: b.block,
      tx: { hex: b.reveal.hex, pos: b.reveal.pos, txidBranch: b.reveal.txidBranch },
      prevTxs,
    };
  }

  function write(name: string, bundle: unknown): string {
    const path = join(TMP, name);
    writeFileSync(path, JSON.stringify(bundle));
    return path;
  }

  function run(path: string): { status: number; stderr: string; stdout: string } {
    const r = spawnSync('npx', ['tsx', MAIN, 'verify', path], { cwd: ROOT, encoding: 'utf8' });
    return { status: r.status ?? -1, stderr: r.stderr, stdout: r.stdout };
  }

  it('reports an unprovable envelope numbering as UNPROVEN offline, exit 3', () => {
    const b = fixture(MULTI_INPUT);
    const path = write('unproven.json', {
      version: 1,
      inscriptionId: b.inscriptionId,
      hops: [revealHop(b, [])],
      finalSatpoint: `${parseTx(hexToBytes(b.reveal.hex)).txid}:0:0`,
    });
    const r = run(path);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/bundle UNPROVEN offline:/);
    expect(r.stderr).toMatch(/carries no witness section/);
    expect(r.stderr).toMatch(/--witness-section always/);
    expect(r.stderr).not.toMatch(/bundle INVALID/);
  });

  it('reports a path outside v1 as OUT OF SCOPE, exit 4', () => {
    const b = fixture(SINGLE_INPUT);
    // a coinbase in the path: true of the chain, and beyond what v1 follows
    const coinbaseHex =
      '01000000' + '01' + '00'.repeat(32) + 'ffffffff' + '04' + '03abcdef' + 'ffffffff' +
      '01' + '0000000000000000' + '01' + '51' + '00000000';
    const path = write('outofscope.json', {
      version: 1,
      inscriptionId: b.inscriptionId,
      hops: [
        revealHop(b, [b.commit.hex]),
        { block: b.block, tx: { hex: coinbaseHex, pos: 0, txidBranch: [] }, prevTxs: [] },
      ],
      finalSatpoint: `${parseTx(hexToBytes(b.reveal.hex)).txid}:0:0`,
    });
    const r = run(path);
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/bundle OUT OF SCOPE:/);
    expect(r.stderr).toMatch(/does not track sats through fees/);
    expect(r.stderr).toMatch(/well formed/);
  });

  it('still calls a corrupted bundle INVALID, exit 1', () => {
    const b = fixture(SINGLE_INPUT);
    // one flipped hex digit in the reveal: the txid no longer matches the id
    const last = b.reveal.hex.slice(-1);
    const broken = {
      ...b,
      reveal: { ...b.reveal, hex: b.reveal.hex.slice(0, -1) + (last === '1' ? '2' : '1') },
    };
    const r = run(write('invalid.json', broken));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bundle INVALID:/);
  });

  it('exits 2 on a bundle it cannot classify', () => {
    const r = run(write('nonsense.json', { version: 1 }));
    expect(r.status).toBe(2);
  });

  it('reports an unreadable file as usage and non-JSON bytes as a bad document', () => {
    // both used to reach main().catch and print a stack trace at exit 1. A
    // file that cannot be read is a usage failure, and bytes that do not
    // parse are a document failure; each is one line with no stack trace
    const missing = run(join(TMP, 'absent.json'));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/error: verify: cannot read .*absent\.json/);
    expect(missing.stderr).not.toMatch(/\n\s+at /);

    const garbagePath = join(TMP, 'garbage.json');
    writeFileSync(garbagePath, 'not a bundle {{{');
    const garbage = run(garbagePath);
    expect(garbage.status).toBe(1);
    expect(garbage.stderr).toMatch(/error: verify: .*garbage\.json is not JSON/);
    expect(garbage.stderr).not.toMatch(/\n\s+at /);
  });
});

/**
 * The classifier and the note builder the two commands share, exercised
 * directly. `resolve` reads live backends, so its two output modes cannot be
 * driven offline; what both commands compute is checked here instead.
 */
describe('shared CLI notes', () => {
  it('classifies each refusal with its own prefix and exit code', () => {
    expect(refusalReport(new CoinbaseHeightUnprovenError('height x'), 'verify')).toMatchObject({
      message: expect.stringMatching(/^bundle UNPROVEN offline: height x\./),
      code: 3,
    });
    expect(refusalReport(new EnvelopeIndexUnprovenError('numbering x'), 'verify')).toMatchObject({
      message: expect.stringMatching(/^bundle UNPROVEN offline: numbering x\..*--witness-section always/s),
      code: 3,
    });
    expect(refusalReport(new CustodyUnsupportedError('fees x'), 'verify')).toMatchObject({
      message: expect.stringMatching(/^bundle OUT OF SCOPE: fees x\./),
      code: 4,
    });
    // anything else is the caller's `bundle INVALID` at exit 1
    expect(refusalReport(new Error('merkle proof does not match'), 'verify')).toBeUndefined();
  });

  it('derives the JSON channel from the same object the human channel prints', () => {
    // one report serves both channels, so they cannot disagree about the
    // code, the class name, or the note; the JSON message is the error's own
    // message, which the report carries as `detail`
    const e = new CustodyUnsupportedError('fees x');
    const report = refusalReport(e, 'live', 'custody');
    expect(report?.detail).toBe('fees x');
    expect(report?.message).toBe(`custody OUT OF SCOPE: fees x. ${report?.note}`);
    expect(JSON.parse(refusalJson(e, report))).toEqual({
      ok: false,
      error: report?.name,
      message: report?.detail,
      note: report?.note,
    });
  });

  it('carries the executed-leaf residual below L3 and the numbering one on multi-input', () => {
    expect(contentResiduals('L3', { singleInputReveal: false })).toEqual([]);
    const single = contentResiduals('L2', { singleInputReveal: true });
    expect(single).toHaveLength(1);
    expect(single[0]).toMatch(/only a wtxid anchor proves the presented witness/);
    const multi = contentResiduals('L2', { singleInputReveal: false });
    expect(multi).toHaveLength(2);
    expect(multi[0]).toMatch(/only a wtxid anchor proves the presented witness/);
    expect(multi[1]).toMatch(/envelope numbering is not proven at L2/);
  });
});

/**
 * A refusal has to survive the command it was raised under. The class-to-code
 * mapping is one table, so a path outside v1's domain exits 4 whether the
 * caller read a bundle back or resolved the same inscription live, and a
 * `--json` caller reads the class rather than parsing a sentence.
 *
 * The live commands are driven with a backend URL no request can leave the
 * machine for, so the whole file stays offline. That reaches the
 * build-completed-nothing path end to end on both channels; the mapped refusal
 * classes need a backend serving crafted bytes, so their codes are checked
 * through `verify`, which runs the same reporter, and through the reporter
 * itself.
 */
describe('refusals across commands', { timeout: 60_000 }, () => {
  const TMP = mkdtempSync(join(tmpdir(), 'ordspv-refusal-'));
  // undici rejects the scheme outright, so no name is looked up and no socket
  // is opened; the CLI sees a backend that failed
  const OFFLINE = 'file:///dev/null';

  function cli(args: string[]): { status: number; stderr: string; stdout: string } {
    const r = spawnSync('npx', ['tsx', MAIN, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { status: r.status ?? -1, stderr: r.stderr, stdout: r.stdout };
  }

  /** a genealogy bundle whose only readable fact is its step count */
  function deepGenealogy(): string {
    const path = join(TMP, 'deep.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        inscriptionId: `${'ab'.repeat(32)}i0`,
        reveal: {},
        funding: [{}, {}],
        coinbase: {},
        claimedSat: '1',
      }),
    );
    return path;
  }

  /**
   * A one-hop custody bundle over the same mainnet reveal the proof fixtures
   * carry: the reveal hop is the proof bundle's own block, transaction and
   * merkle branch, with the commit as its prev tx. Verification runs for real,
   * PoW floor included, and nothing is fetched.
   */
  function custodyFromProofFixture(): string {
    const proof = JSON.parse(
      readFileSync(join(EXT, `${SINGLE_INPUT}.bundle.json`), 'utf8'),
    ) as Record<string, never>;
    const path = join(TMP, 'custody.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        inscriptionId: proof.inscriptionId,
        hops: [{ block: proof.block, tx: proof.reveal, prevTxs: [(proof.commit as never)['hex']] }],
        finalSatpoint: `${SINGLE_INPUT.replace(/i\d+$/, '')}:0:0`,
      }),
    );
    return path;
  }

  it('says an offline verification anchored no header, on both channels', () => {
    // every header here rests on proof of work alone. A hop hash is something
    // any reader can check against any chain view, so saying so is the whole
    // remedy, and the reader has to be told rather than left to infer it
    const r = cli(['verify', custodyFromProofFixture()]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('custody');
    expect(parsed.anchored).toBe(false);
    expect(r.stderr).toMatch(/no header in this bundle was anchored/);
    expect(r.stderr).toMatch(/holds only against your own chain view/);
  });

  it('reports the verifier step cap as UNPROVEN at exit 3 on both channels', () => {
    const path = deepGenealogy();
    const human = cli(['verify', path, '--max-steps', '1']);
    expect(human.status).toBe(3);
    expect(human.stderr).toMatch(/bundle UNPROVEN offline: genealogy has 2 steps, verifier cap is 1/);
    expect(human.stderr).toMatch(/--max-steps N raises it/);

    const json = cli(['verify', path, '--max-steps', '1', '--json']);
    expect(json.status).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: 'SatStepLimitError',
      message: 'genealogy has 2 steps, verifier cap is 1',
      note: expect.stringMatching(/--max-steps N raises it/),
    });
  });

  it('reads the same bundle past the cap when the flag raises it', () => {
    // the raised cap gets past the step check and the bundle fails on its own
    // contents, which is the point: refusing to read is not a verdict
    const r = cli(['verify', deepGenealogy(), '--max-steps', '5']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bundle INVALID:/);
  });

  it('rejects --max-steps on a bundle it does not bound, exit 2', () => {
    const r = cli(['verify', join(EXT, `${SINGLE_INPUT}.bundle.json`), '--max-steps', '5']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--max-steps applies to sat genealogy bundles/);
  });

  it('reports an invalid uri to parse as one line, no stack, exit 1', () => {
    // an uncaught failure used to reach main().catch and print a stack
    // trace; every command's final catch is one gentle line now, with each
    // command's own classified paths untouched
    const r = cli(['parse', 'not-a-uri']);
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toMatch(/^error: /);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('reports a build no backend completed as INCOMPLETE at exit 5, both channels', () => {
    // a total outage is not a forged document, and exit 1 said it was. Nothing
    // was verified here, which is what code 5 means
    for (const command of ['custody', 'sat']) {
      const args = [command, `${'ab'.repeat(32)}i0`, '--esplora', OFFLINE];
      const human = cli(args);
      expect(human.status).toBe(5);
      expect(human.stderr).toMatch(new RegExp(`error: ${command} INCOMPLETE: `));
      expect(human.stderr).toMatch(/No configured backend produced an answer this build could stand on/);
      expect(human.stderr).toMatch(/--esplora names others/);

      const json = cli([...args, '--json']);
      expect(json.status).toBe(5);
      const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe(command === 'custody' ? 'CustodyError' : 'SatIdentityError');
      expect(String(parsed.message)).toMatch(/fetch failed/);
      expect(String(parsed.note)).toMatch(/the causes above name what each one did/);
    }
  });

  it('does not tell a caller whose backends both refused that neither answered', () => {
    // both configured backends answered and both refused, for different domain
    // reasons, so the loop has no one class to report and reaches BUILD_FAILED.
    // Driving that pair through the CLI needs backends serving crafted reveal
    // witnesses, which this file has no way to run offline; the fetch suite
    // drives the loop (satbuilder.test.ts, refusals of unlike classes) and the
    // sentence it produces is checked here at the reporter both commands share
    const causes =
      `build failed:\n` +
      `https://a.test: inscription is unbound at reveal\n` +
      `https://b.test: position beyond the transaction's total input sats`;
    for (const command of ['custody', 'sat']) {
      const e =
        command === 'custody'
          ? new CustodyError('BUILD_FAILED', causes)
          : new SatIdentityError('BUILD_FAILED', causes);
      const report = refusalReport(e, 'live', command);
      expect(report?.code).toBe(5);
      expect(report?.note).toMatch(/No configured backend produced an answer this build could stand on/);
      expect(report?.note).toMatch(/the causes above name what each one did/);
      expect(report?.note).not.toMatch(/produced a usable answer/);
      // the causes are in the message the human channel prints ahead of the note
      const message = String(report?.message);
      expect(message).toMatch(/https:\/\/a\.test: inscription is unbound at reveal/);
      expect(message).toMatch(/https:\/\/b\.test: position beyond/);
      expect(message.indexOf('https://b.test')).toBeLessThan(
        message.indexOf('the causes above name what each one did'),
      );
      expect(JSON.parse(refusalJson(e, report))).toMatchObject({ ok: false, error: e.name });
    }
  });

  it('separates an anchoring shortfall and a failed verification from a forgery', () => {
    // reaching HEADER_TRUST and VERIFY_FAILED through the live commands needs a
    // backend serving crafted bytes, which this file has no way to run offline,
    // so the two codes are checked at the reporter both commands share
    for (const make of [
      (code: 'HEADER_TRUST' | 'VERIFY_FAILED') => new CustodyError(code, 'why'),
      (code: 'HEADER_TRUST' | 'VERIFY_FAILED') => new SatIdentityError(code, 'why'),
    ]) {
      for (const command of ['custody', 'sat']) {
        const trust = make('HEADER_TRUST');
        const report = refusalReport(trust, 'live', command);
        expect(report?.code).toBe(3);
        expect(report?.message).toMatch(new RegExp(`^${command} UNPROVEN: why\\.`));
        expect(report?.note).toMatch(/--anchor-source names others/);
        expect(JSON.parse(refusalJson(trust, report))).toMatchObject({
          ok: false,
          error: trust.name,
        });

        // a bundle that failed verification keeps meaning exit 1
        const failed = make('VERIFY_FAILED');
        expect(refusalReport(failed, 'live', command)).toBeUndefined();
        // and the JSON says which class it was rather than the literal Error
        expect(JSON.parse(refusalJson(failed, undefined))).toMatchObject({
          error: failed.name,
        });
      }
    }
  });

  it('maps each class to one exit code whichever command reports it', () => {
    const cases = [
      [new CoinbaseHeightUnprovenError('height x'), 3],
      [new EnvelopeIndexUnprovenError('numbering x'), 3],
      [new SatStepLimitError('depth x'), 3],
      [new CustodyUnsupportedError('fees x'), 4],
    ] as const;
    for (const [error, code] of cases) {
      const asVerify = refusalReport(error, 'verify');
      const asLive = refusalReport(error, 'live', 'custody');
      expect(asVerify?.code).toBe(code);
      // the code is the class's, not the command's
      expect(asLive?.code).toBe(code);
      expect(asVerify?.name).toBe(error.name);
      expect(asLive?.name).toBe(error.name);
      expect(asVerify?.message).toMatch(/^bundle (UNPROVEN offline|OUT OF SCOPE): /);
      expect(asLive?.message).toMatch(/^custody (UNPROVEN|OUT OF SCOPE): /);
    }
    expect(refusalReport(new Error('merkle proof does not match'), 'live', 'sat')).toBeUndefined();
  });

  it('reports a refusal only some backends reached as unproven, not as out of scope', () => {
    // a domain refusal from the one backend that answered says nothing about
    // the chain, so it cannot carry the code that means the path really does
    // leave what v1 proves
    const partial = Object.assign(new CustodyUnsupportedError('fees x'), { unanimous: false });
    const live = refusalReport(partial, 'live', 'sat');
    expect(live?.code).toBe(3);
    expect(live?.message).toMatch(/^sat UNPROVEN: fees x\./);
    expect(live?.note).toMatch(/--esplora names others/);
    expect(JSON.parse(refusalJson(partial, live))).toMatchObject({
      ok: false,
      error: 'CustodyUnsupportedError',
      note: expect.stringMatching(/--esplora names others/),
    });

    // and the unanimous refusal keeps the code and the sentence it had
    const all = Object.assign(new CustodyUnsupportedError('fees x'), { unanimous: true });
    expect(refusalReport(all, 'live', 'sat')).toMatchObject({
      code: 4,
      message: expect.stringMatching(/^sat OUT OF SCOPE: fees x\. The path is well formed/),
    });
    // a verifier raises the class with no marker at all, and that is proven
    expect(refusalReport(new CustodyUnsupportedError('fees x'), 'verify')?.code).toBe(4);
  });

  it('reports the custody hop cap as UNPROVEN at exit 3, naming --max-hops', () => {
    // reaching the class live needs a backend serving a 65-transfer chain,
    // which this file has no way to run offline; the fetch suite drives the
    // loop and the code and the note are checked here at the reporter both
    // channels read. Both unanimity states report the same category, since
    // the cap is the walk's own bound rather than a claim about the chain
    for (const unanimous of [true, false]) {
      const e = Object.assign(
        new CustodyHopLimitError('custody path exceeds 64 confirmed transfers', 64, 65),
        { unanimous },
      );
      const report = refusalReport(e, 'live', 'custody');
      expect(report?.code).toBe(3);
      expect(report?.message).toMatch(
        /^custody UNPROVEN: custody path exceeds 64 confirmed transfers\./,
      );
      expect(report?.note).toMatch(/--max-hops N raises it/);
      expect(JSON.parse(refusalJson(e, report))).toMatchObject({
        ok: false,
        error: 'CustodyHopLimitError',
        note: expect.stringMatching(/--max-hops N raises it/),
      });
    }
  });

  it('rejects --max-hops on a command other than custody, exit 2', () => {
    // the flag bounds the custody walk alone; misplaced it is refused the way
    // verify refuses --max-steps on a bundle it does not bound, before any
    // command runs, so neither call below touches the network
    const p = cli(['parse', 'not-consulted', '--max-hops', '5']);
    expect(p.status).toBe(2);
    expect(p.stderr).toMatch(/--max-hops applies to the custody command/);

    // --esplora keeps the call off the network even if the guard regresses
    const s = cli(['sat', `${'ab'.repeat(32)}i0`, '--max-hops', '5', '--esplora', OFFLINE]);
    expect(s.status).toBe(2);
    expect(s.stderr).toMatch(/--max-hops applies to the custody command/);
  });

  it('gives the witness-section refusal its own unproven code on both channels', () => {
    for (const unanimous of [true, false]) {
      const e = Object.assign(new WitnessSectionUnavailableError('no raw block'), { unanimous });
      const report = refusalReport(e, 'live', 'custody');
      expect(report?.code).toBe(3);
      expect(report?.message).toMatch(/^custody UNPROVEN: no raw block\./);
      expect(JSON.parse(refusalJson(e, report))).toMatchObject({
        ok: false,
        error: 'WitnessSectionUnavailableError',
      });
    }
  });

  it('reports a build-time position refusal as UNPROVEN and a verifier-raised one as INVALID', () => {
    // the phase decides what the class means. A build loop read the pointer
    // and the envelope input out of a served reveal witness, which the id's
    // txid does not commit to, so exit 1 said a document had failed
    // verification when nothing had been verified at all
    for (const unanimous of [true, false]) {
      const e = Object.assign(new SatPositionError('position 5000 beyond the input sats'), {
        unanimous,
      });
      const live = refusalReport(e, 'live', 'sat');
      expect(live?.code).toBe(3);
      expect(live?.message).toMatch(/^sat UNPROVEN: position 5000 beyond the input sats\./);
      expect(live?.note).toMatch(/txid does not commit to/);
      expect(live?.note).toMatch(/--esplora names others/);
      // the remedy reaches the scripted caller too, which read no note at all
      expect(JSON.parse(refusalJson(e, live))).toEqual({
        ok: false,
        error: 'SatPositionError',
        message: 'position 5000 beyond the input sats',
        note: expect.stringMatching(/txid does not commit to/),
      });
    }

    // a verifier raises it about a bundle whose pointer the bundle itself
    // bound, which is a forgery and keeps exit 1
    const forged = new SatPositionError('offset 9 outside output 0 value 5');
    const asVerify = refusalReport(forged, 'verify');
    expect(asVerify?.code).toBe(1);
    expect(asVerify?.message).toMatch(/^bundle INVALID: offset 9 outside output 0 value 5\./);
    expect(asVerify?.note).toMatch(/document contradicts itself/);
  });

  it('tells an under-supplied bundle it is unproven, never that it contradicts itself', () => {
    // the fourth condition SatPositionError once covered: a funding step's
    // prev txs stop short of the position. No pointer is involved and the
    // honest remedy is a rebuild carrying the missing entries, so the class
    // and the note split from the three genuine self-contradictions
    const incomplete = new SatFundingIncompleteError(
      'position 1200 not reached by prev txs for inputs 0..0; more are needed',
    );
    const report = refusalReport(incomplete, 'verify');
    expect(report?.code).toBe(3);
    expect(report?.message).toMatch(/^bundle UNPROVEN offline: position 1200 not reached/);
    expect(report?.note).toMatch(/did not carry enough funding prev txs/);
    expect(report?.note).toMatch(/sat --bundle/);
    expect(report?.note).not.toMatch(/contradicts itself/);
    expect(JSON.parse(refusalJson(incomplete, report))).toMatchObject({
      ok: false,
      error: 'SatFundingIncompleteError',
    });
  });

  it('carries the partial-answer sentence on every non-unanimous class', () => {
    for (const e of [
      new EnvelopeIndexUnprovenError('numbering x'),
      new SatStepLimitError('depth x'),
      new WitnessSectionUnavailableError('no raw block'),
    ]) {
      const report = refusalReport(Object.assign(e, { unanimous: false }), 'live', 'sat');
      expect(report?.code).toBe(3);
      expect(report?.note).toMatch(/--esplora names others/);
    }
  });

  it('emits one JSON shape for a mapped and an unmapped failure', () => {
    const mapped = new CustodyUnsupportedError('fees x');
    expect(JSON.parse(refusalJson(mapped, refusalReport(mapped, 'live', 'sat')))).toEqual({
      ok: false,
      error: 'CustodyUnsupportedError',
      message: 'fees x',
      note: expect.stringMatching(/leaves what v1 proves/),
    });
    const plain = new Error('merkle proof does not match');
    expect(JSON.parse(refusalJson(plain, undefined))).toEqual({
      ok: false,
      error: 'Error',
      message: 'merkle proof does not match',
    });
    // one line, so a caller reads it off stdout without a parser
    expect(refusalJson(plain, undefined)).not.toMatch(/\n/);
  });
});
