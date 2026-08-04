import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Offline verify consults the compiled-in checkpoints. A bundle's claimed
 * heights are not committed by its headers, so before this check a bundle
 * relabelled to a checkpoint height with a real header from another height
 * verified at exit 0; SPEC-VERIFICATION section 4 makes checkpoint
 * consultation a MUST where one applies. The check fires only when a claimed
 * height equals a checkpoint height: a mismatch is refused, a match still
 * verifies, and every other height is untouched (the rest of the suite runs
 * bundles at non-checkpoint heights throughout).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN = join(ROOT, 'packages/cli/src/main.ts');
const EXT = join(ROOT, 'fixtures/extended');
const INSC0 = join(ROOT, 'fixtures/insc0');

const SINGLE_INPUT = '6dc2c16a74dedcae46300b2058ebadc7ca78aea78236459662375c8d7d9804dbi0';

const TMP = mkdtempSync(join(tmpdir(), 'ordspv-checkpoint-'));

function fixture(id: string): Record<string, any> {
  return JSON.parse(readFileSync(join(EXT, `${id}.bundle.json`), 'utf8'));
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

describe('verify consults the compiled-in checkpoints', { timeout: 60_000 }, () => {
  it('refuses a proof bundle relabelled to a checkpoint height, exit 1', () => {
    const b = fixture(SINGLE_INPUT);
    // the real block sits at 819367; the header is untouched, so only the
    // claimed height lies, which is exactly what a checkpoint pins
    const relabelled = { ...b, block: { ...b.block, height: 824544 } };
    const r = run(write('relabelled-proof.json', relabelled));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bundle INVALID:/);
    expect(r.stderr).toMatch(/at height 824544 contradicts checkpoint/);
  });

  it('refuses a custody hop relabelled to a checkpoint height, exit 1', () => {
    const b = fixture(SINGLE_INPUT);
    const path = write('relabelled-custody.json', {
      version: 1,
      inscriptionId: b.inscriptionId,
      hops: [
        {
          block: { ...b.block, height: 824544 },
          tx: { hex: b.reveal.hex, pos: b.reveal.pos, txidBranch: b.reveal.txidBranch },
          prevTxs: [b.commit.hex],
        },
      ],
      finalSatpoint: `${SINGLE_INPUT.replace(/i\d+$/, '')}:0:0`,
    });
    const r = run(path);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/at height 824544 contradicts checkpoint/);
  });

  it('verifies a proof bundle at a genuine checkpoint height with the matching header', () => {
    // inscription 0's block IS the 767430 checkpoint, and every byte here is
    // vendored mainnet data, so the hash comparison runs against the real pin
    const merkleProof = JSON.parse(readFileSync(join(INSC0, 'merkle-proof.json'), 'utf8')) as {
      merkle: string[];
      pos: number;
    };
    const expectedJson = JSON.parse(readFileSync(join(INSC0, 'expected.json'), 'utf8')) as {
      revealTxid: string;
      blockHash: string;
      blockHeight: number;
    };
    const bundle = {
      version: 1,
      inscriptionId: `${expectedJson.revealTxid}i0`,
      level: 'L2',
      block: {
        height: expectedJson.blockHeight,
        hash: expectedJson.blockHash,
        header: readFileSync(join(INSC0, 'header-767430.hex'), 'utf8').trim(),
        // block 767430; consistent with the 12-node branch depth
        txCount: 2332,
      },
      reveal: {
        hex: readFileSync(join(INSC0, 'reveal.hex'), 'utf8').trim(),
        pos: merkleProof.pos,
        txidBranch: merkleProof.merkle,
      },
      commit: { hex: readFileSync(join(INSC0, 'commit.hex'), 'utf8').trim() },
    };
    const r = run(write('insc0-proof.json', bundle));
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.height).toBe(767430);
  });

  it('leaves a non-checkpoint height unaffected', () => {
    // the untouched fixture at 819367 keeps verifying at exit 0 with the
    // checkpoints consulted; no checkpoint speaks at that height
    const r = run(join(EXT, `${SINGLE_INPUT}.bundle.json`));
    expect(r.status).toBe(0);
  });
});
