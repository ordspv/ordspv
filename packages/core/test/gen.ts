/**
 * Seeded deterministic generators for the property tests beside this file.
 *
 * `fast-check` is not a dependency of this repository and none was added for
 * these, so the generators are written by hand. Every one takes an explicit
 * seed and every test fixes its seeds, so a failure reproduces exactly from the
 * printed seed rather than "sometimes".
 */

/** mulberry32: small, fast, and deterministic across engines. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

export function randBytes(r: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = randInt(r, 0, 255);
  return out;
}

/**
 * Distinct 32-byte leaves.
 *
 * Distinctness is required, not cosmetic: `computeMerkleRoot` deliberately
 * rejects a level whose final two nodes are equal (the CVE-2012-2459 mutation
 * check), so a generator that could emit duplicates would make honest trees
 * throw and the property under test would never be reached.
 */
export function distinctLeaves(r: () => number, count: number): Uint8Array[] {
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  while (out.length < count) {
    const b = randBytes(r, 32);
    const k = b.join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

/** ceil(log2(n)), the independent expectation for a branch's length. */
export function expectedHeight(leafCount: number): number {
  let h = 0;
  let w = leafCount;
  while (w > 1) {
    w = Math.ceil(w / 2);
    h++;
  }
  return h;
}

/** Run `body` over a spread of tree sizes, reporting the size that failed. */
export function forEachTreeSize(
  sizes: number[],
  body: (size: number, seed: number) => void,
): void {
  for (const [i, size] of sizes.entries()) {
    const seed = 0x5eed_0000 + i * 7919 + size;
    try {
      body(size, seed);
    } catch (err) {
      (err as Error).message = `[tree size ${size}, seed 0x${seed.toString(16)}] ${(err as Error).message}`;
      throw err;
    }
  }
}

/**
 * Tree sizes worth covering: every small size (where odd/even level shapes
 * differ most), both sides of each power of two, and a few larger ones.
 */
export const TREE_SIZES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 129, 256, 257,
];

/** A byte array that differs from `b` in exactly one position. */
export function mutateOne(r: () => number, b: Uint8Array): Uint8Array {
  const out = b.slice();
  const i = randInt(r, 0, out.length - 1);
  out[i] = (out[i] + 1 + randInt(r, 0, 254)) & 0xff;
  return out;
}

/** Did `fn` reject, either by throwing or by returning a non-matching root? */
export function rejects(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
