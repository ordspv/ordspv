import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyBundle, UnknownBundleError } from '../src/bundlekind.js';

/**
 * `ord-resolve verify` used to hand every file to verifyProofBundle, so a
 * genealogy bundle written by `sat --bundle` came back as
 * "Cannot read properties of undefined (reading 'header')". The router reads
 * top-level keys, since `version` is 1 in all three shapes.
 *
 * The CLI has no process-level test harness (main.ts runs on import), so this
 * covers the router itself rather than the three command paths.
 */

const EXTENDED = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/extended');

describe('classifyBundle', () => {
  it('reads every vendored proof bundle as a proof bundle', () => {
    const files = readdirSync(EXTENDED).filter((f) => f.endsWith('.bundle.json'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const parsed: unknown = JSON.parse(readFileSync(join(EXTENDED, f), 'utf8'));
      expect(classifyBundle(parsed)).toBe('proof');
    }
  });

  it('reads a custody bundle by hops + finalSatpoint', () => {
    const custody = {
      version: 1,
      inscriptionId: `${'a'.repeat(64)}i0`,
      hops: [],
      finalSatpoint: `${'a'.repeat(64)}:0:0`,
    };
    expect(classifyBundle(custody)).toBe('custody');
  });

  it('reads a genealogy bundle by claimedSat + funding + coinbase', () => {
    const genealogy = {
      version: 1,
      inscriptionId: `${'b'.repeat(64)}i0`,
      reveal: {},
      funding: [],
      coinbase: {},
      claimedSat: '1252201400444387',
    };
    expect(classifyBundle(genealogy)).toBe('genealogy');
  });

  it('does not route an empty funding list away from genealogy', () => {
    // a reveal funded straight out of a coinbase has funding: [], which is
    // present-but-falsy; the check is presence, not truthiness
    const parsed = { version: 1, reveal: {}, funding: [], coinbase: {}, claimedSat: '0' };
    expect(classifyBundle(parsed)).toBe('genealogy');
  });

  it('names the three shapes and the keys it actually saw', () => {
    const stray = { version: 1, inscriptionId: 'x', somethingElse: true };
    expect(() => classifyBundle(stray)).toThrow(UnknownBundleError);
    expect(() => classifyBundle(stray)).toThrow(/proof bundle \(level, block\)/);
    expect(() => classifyBundle(stray)).toThrow(/custody bundle \(hops, finalSatpoint\)/);
    expect(() => classifyBundle(stray)).toThrow(/genealogy bundle \(claimedSat, funding, coinbase\)/);
    expect(() => classifyBundle(stray)).toThrow(/version, inscriptionId, somethingElse/);
  });

  it('rejects non-objects rather than reporting a property access error', () => {
    expect(() => classifyBundle(null)).toThrow(/not a bundle object/);
    expect(() => classifyBundle([1, 2])).toThrow(/got an array/);
    expect(() => classifyBundle('{}')).toThrow(/got string/);
  });
});
