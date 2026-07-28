import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
