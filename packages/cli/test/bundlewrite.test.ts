import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeBundleFile } from '../src/bundlewrite.js';

/**
 * The write half of `sat --bundle` and `custody --bundle`. No offline seam
 * can run either command's successful walk, since the proof-of-work floor
 * has no CLI override and the synthetic fixtures are regtest-difficulty, so
 * the print-then-write order is enforced by placement in main.ts, with the
 * catch around the write alone, and the write failure's shape is tested here
 * at the helper both commands call.
 */
describe('writeBundleFile', () => {
  it('reports a missing directory as the write failure, not a walk failure', () => {
    const path = join(tmpdir(), 'ord-no-such-dir', 'deeper', 'x.json');
    const failure = writeBundleFile('sat', path, { version: 1 });
    expect(failure).toMatch(/^sat: cannot write bundle to /);
    expect(failure).toContain(path);
    expect(failure).toMatch(/ENOENT/);
  });

  it('carries the command prefix the caller passes', () => {
    const path = join(tmpdir(), 'ord-no-such-dir', 'deeper', 'x.json');
    expect(writeBundleFile('custody', path, {})).toMatch(/^custody: cannot write bundle to /);
  });

  it('returns nothing when the write lands, and the file round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ord-bundlewrite-'));
    const path = join(dir, 'x.json');
    expect(writeBundleFile('sat', path, { version: 1, hops: [] })).toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, hops: [] });
  });
});
