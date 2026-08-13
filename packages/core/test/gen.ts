/**
 * Seeded deterministic generators for the property tests beside this file.
 *
 * `fast-check` is not a dependency of this repository and none was added for
 * these, so the generators are written by hand. Every one takes an explicit
 * seed and every test fixes its seeds, so a failure reproduces exactly from the
 * printed seed rather than "sometimes".
 */

import { bytesToHex, hexToBytes, parseTx, type ParsedTx } from '@ordspv/core';

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

/** Uniform-ish bigint in [lo, hi]; built from 32-bit draws so sat-sized ranges work. */
export function randBigInt(r: () => number, lo: bigint, hi: bigint): bigint {
  if (hi < lo) throw new Error(`randBigInt: empty range ${lo}..${hi}`);
  const span = hi - lo + 1n;
  let bits = 0n;
  let magnitude = 1n;
  while (magnitude < span) {
    bits = bits * 0x1_0000_0000n + BigInt(randInt(r, 0, 0xffffffff));
    magnitude *= 0x1_0000_0000n;
  }
  return lo + (bits % span);
}

export function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[randInt(r, 0, xs.length - 1)];
}

/** A display-order txid: 32 random bytes as hex. */
export function randTxid(r: () => number): string {
  return bytesToHex(randBytes(r, 32));
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

/** The same single-byte mutation over a hex string. */
export function mutateHex(r: () => number, hex: string): string {
  return bytesToHex(mutateOne(r, hexToBytes(hex)));
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

/**
 * Run `body` over `count` independently seeded cases, reporting the seed that
 * failed. Each case gets its own generator, so a counterexample reproduces on
 * its own from the printed seed rather than by replaying the ones before it.
 */
export function forEachCase(
  base: number,
  count: number,
  body: (r: () => number, index: number) => void,
): void {
  for (let index = 0; index < count; index++) {
    const seed = (base + index * 7919) >>> 0;
    try {
      body(rng(seed), index);
    } catch (err) {
      (err as Error).message = `[case ${index}, seed 0x${seed.toString(16)}] ${(err as Error).message}`;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic transactions
//
// The sat arithmetic reads input values, output values and outpoints, and
// reads no witness at all, so legacy serialization carries everything these
// properties need. Values are what the arithmetic is about, so they are drawn
// rather than fixed, and every draw comes back with the prev txs that prove it.
// ---------------------------------------------------------------------------

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function varint(n: number): Uint8Array {
  if (n <= 0xfc) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >> 8]);
  throw new Error(`test varint only supports counts up to 0xffff, got ${n}`);
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface BuiltTx {
  hex: string;
  tx: ParsedTx;
}

export interface Outpoint {
  txid: string;
  vout: number;
  scriptSig?: Uint8Array;
}

/** A legacy (no-witness) transaction over explicit outpoints and output values. */
export function buildLegacyTx(inputs: Outpoint[], outputValues: bigint[]): BuiltTx {
  const parts: Uint8Array[] = [u32le(2), varint(inputs.length)];
  for (const input of inputs) {
    const scriptSig = input.scriptSig ?? new Uint8Array([0x51]);
    parts.push(
      hexToBytes(input.txid).reverse(),
      u32le(input.vout),
      varint(scriptSig.length),
      scriptSig,
      u32le(0xffffffff),
    );
  }
  parts.push(varint(outputValues.length));
  for (const value of outputValues) {
    parts.push(u64le(value), varint(1), new Uint8Array([0x51]));
  }
  parts.push(u32le(0));
  const raw = cat(...parts);
  return { hex: bytesToHex(raw), tx: parseTx(raw) };
}

/** A coinbase: one input spending the null outpoint, scriptSig as given. */
export function buildCoinbaseTx(outputValues: bigint[], scriptSig?: Uint8Array): BuiltTx {
  return buildLegacyTx([{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig }], outputValues);
}

/** Split `total` into `parts` values, each at least `least`. */
export function partition(r: () => number, total: bigint, parts: number, least = 1n): bigint[] {
  const floor = least * BigInt(parts);
  if (total < floor) throw new Error(`cannot split ${total} into ${parts} parts of >= ${least}`);
  const out: bigint[] = [];
  let left = total;
  for (let i = 0; i < parts - 1; i++) {
    const reserve = least * BigInt(parts - 1 - i);
    out.push(randBigInt(r, least, left - reserve));
    left -= out[i];
  }
  out.push(left);
  return out;
}

export interface FundedTx extends BuiltTx {
  /** the transactions this one's inputs spend, aligned to the inputs */
  prevs: BuiltTx[];
  /** what a bundle carries: prevs[i] as hex */
  prevTxsHex: string[];
  /** proven value of each input */
  inputValues: bigint[];
  /** value of each output */
  outputValues: bigint[];
}

/**
 * A transaction whose every input is funded by a generated prev tx, so
 * `provenInputValues` can prove the values the arithmetic then uses.
 * `spends` pins input 0 to an existing output, which is how a chain of these
 * is composed; `fee` is the sats the outputs do not carry.
 */
export function randomFundedTx(
  r: () => number,
  opts: {
    inputs?: number;
    outputs?: number;
    spends?: { hex: string; txid: string; vout: number; value: bigint };
    fee?: bigint;
    /** give some outputs zero sats, which occupy no sat space at all */
    zeroOutputs?: boolean;
  } = {},
): FundedTx {
  const inputCount = opts.inputs ?? randInt(r, 1, 4);
  const outputCount = opts.outputs ?? randInt(r, 1, 4);
  const prevs: BuiltTx[] = [];
  const outpoints: Outpoint[] = [];
  const inputValues: bigint[] = [];
  for (let i = 0; i < inputCount; i++) {
    if (i === 0 && opts.spends) {
      prevs.push({ hex: opts.spends.hex, tx: parseTx(hexToBytes(opts.spends.hex)) });
      outpoints.push({ txid: opts.spends.txid, vout: opts.spends.vout });
      inputValues.push(opts.spends.value);
      continue;
    }
    // the funder carries several outputs so the spent vout is not always 0
    const values = partition(r, randBigInt(r, 3n, 1_000_000n), randInt(r, 1, 3));
    const prev = buildLegacyTx([{ txid: randTxid(r), vout: randInt(r, 0, 3) }], values);
    const vout = randInt(r, 0, values.length - 1);
    prevs.push(prev);
    outpoints.push({ txid: prev.tx.txid, vout });
    inputValues.push(values[vout]);
  }
  const totalIn = inputValues.reduce((sum, v) => sum + v, 0n);
  // zero-value outputs are drawn as a subset rather than left to chance: a
  // uniform draw over a million sats reaches zero once in a million cases, and
  // skipping them is exactly what the position arithmetic has to get right
  const zeroSlots = new Set<number>();
  if (opts.zeroOutputs) {
    for (let i = 0; i < outputCount; i++) if (randInt(r, 0, 2) === 0) zeroSlots.add(i);
    if (zeroSlots.size === outputCount) zeroSlots.delete(randInt(r, 0, outputCount - 1));
  }
  const funded = outputCount - zeroSlots.size;
  const maxFee = totalIn - BigInt(funded);
  const fee = opts.fee ?? randBigInt(r, 0n, maxFee < 0n ? 0n : maxFee / 4n);
  const shares = partition(r, totalIn - fee, funded);
  const outputValues: bigint[] = [];
  let share = 0;
  for (let i = 0; i < outputCount; i++) {
    outputValues.push(zeroSlots.has(i) ? 0n : shares[share++]);
  }
  const built = buildLegacyTx(outpoints, outputValues);
  return {
    ...built,
    prevs,
    prevTxsHex: prevs.map((p) => p.hex),
    inputValues,
    outputValues,
  };
}
