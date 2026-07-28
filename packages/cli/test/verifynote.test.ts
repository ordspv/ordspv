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
  SatStepLimitError,
  hexToBytes,
  parseTx,
} from '@ordspv/core';
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
 * machine for, so the whole file stays offline. That reaches the unmapped
 * path end to end on both channels; the four mapped classes need a backend
 * serving crafted bytes, so their codes are checked through `verify`, which
 * runs the same reporter, and through the reporter itself.
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

  it('gives custody and sat a JSON refusal channel at the same code', () => {
    for (const command of ['custody', 'sat']) {
      const args = [command, `${'ab'.repeat(32)}i0`, '--esplora', OFFLINE];
      const human = cli(args);
      expect(human.status).toBe(1);
      expect(human.stderr).toMatch(new RegExp(`error: ${command}: `));

      const json = cli([...args, '--json']);
      expect(json.status).toBe(1);
      const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(parsed.ok).toBe(false);
      // no mapping, so the shape is the same and the class is the generic one
      expect(parsed.error).toBe('Error');
      expect(String(parsed.message)).toMatch(/fetch failed/);
      expect(parsed.note).toBeUndefined();
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
