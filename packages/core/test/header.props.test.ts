/**
 * Property tests for block headers: packages/core/src/header.ts
 *
 *   6. HEADER TARGETS   a header whose hash does not meet its own target is
 *                       rejected, and nBits expansion rejects negative and
 *                       over-large exponents
 *
 * The second half matters more than it looks. `checkProofOfWork` compares a
 * header against the target the header itself declares, so it is a consistency
 * check rather than a cost check, since a bundle picks its own headers.
 * `checkPowLimit` is the floor that makes fabrication cost anything at all, so
 * its arithmetic is on the trust boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  parseHeader,
  bitsToTarget,
  targetToBits,
  checkProofOfWork,
  checkPowLimit,
  verifyHeaderChain,
  MAINNET_CHAIN_PARAMS,
} from '@ordspv/core';
import { rng, randBytes, randInt, rejects } from './gen.js';

/** An 80-byte header with the given bits and nonce; not necessarily valid PoW. */
function header(bits: number, nonce: number, merkleRoot: Uint8Array = new Uint8Array(32)): Uint8Array {
  const h = new Uint8Array(80);
  const view = new DataView(h.buffer);
  view.setInt32(0, 4, true);
  h.set(merkleRoot, 36);
  view.setUint32(68, 1_700_000_000, true);
  view.setUint32(72, bits, true);
  view.setUint32(76, nonce, true);
  return h;
}

/** Search for a nonce whose header meets `bits`. Regtest targets take ~1 try. */
function mine(bits: number, merkleRoot: Uint8Array): Uint8Array {
  for (let nonce = 0; nonce < 2_000_000; nonce++) {
    const h = header(bits, nonce, merkleRoot);
    if (checkProofOfWork(parseHeader(h))) return h;
  }
  throw new Error(`could not mine at bits 0x${bits.toString(16)}`);
}

const REGTEST_BITS = 0x207fffff;

describe('header: proof of work against the header\'s own target', () => {
  it('rejects a header whose hash does not meet its declared target', () => {
    const r = rng(0x11117777);
    // Mine at the easiest possible target, then re-declare a hard one. The hash
    // changes with bits, so re-check: what must hold is that a header declaring
    // mainnet difficulty almost never satisfies it by luck.
    let failures = 0;
    const trials = 64;
    for (let i = 0; i < trials; i++) {
      const h = header(MAINNET_CHAIN_PARAMS.powLimitBits, randInt(r, 0, 0xffffffff), randBytes(r, 32));
      if (!checkProofOfWork(parseHeader(h))) failures++;
    }
    // A random header meets difficulty-1 with probability ~2^-32; 64 random
    // headers all failing is the expected and required outcome.
    expect(failures, 'random headers must not satisfy a difficulty-1 target').toBe(trials);
  });

  it('accepts a header that does meet its declared target', () => {
    const r = rng(0x22228888);
    const h = mine(REGTEST_BITS, randBytes(r, 32));
    expect(checkProofOfWork(parseHeader(h))).toBe(true);
  });

  it('parseHeader requires exactly 80 bytes', () => {
    const r = rng(0x33339999);
    for (const n of [0, 1, 79, 81, 160]) {
      expect(rejects(() => parseHeader(randBytes(r, n))), `${n}-byte header`).toBe(true);
    }
  });
});

describe('header: nBits expansion', () => {
  it('rejects a negative encoding (the 0x00800000 sign bit)', () => {
    // Any bits value with the mantissa sign bit set encodes a negative target,
    // which has no meaning as a difficulty and must not silently become one.
    for (const bits of [0x01800000, 0x02800000, 0x1d800000, 0x03ff0000, 0x20ffffff]) {
      expect(
        rejects(() => bitsToTarget(bits)),
        `bits 0x${bits.toString(16)} sets the sign bit and must be rejected`,
      ).toBe(true);
    }
  });

  it('rejects an over-large exponent (target overflow past 256 bits)', () => {
    // exponent 35 with mantissa 1 is 1 << 256: the smallest clean overflow.
    for (const bits of [0x23000001, 0x24000001, 0xff000001, 0xfd7fffff]) {
      expect(
        rejects(() => bitsToTarget(bits)),
        `bits 0x${bits.toString(16)} overflows 256 bits and must be rejected`,
      ).toBe(true);
    }
  });

  it('round-trips every target it accepts, through targetToBits', () => {
    // Consensus does its retarget comparisons in compact form, so precision
    // loss is expected; what must hold is that re-expanding a compacted target
    // is stable: compact(expand(compact(t))) == compact(t).
    const r = rng(0x44440000);
    for (let i = 0; i < 400; i++) {
      const exponent = randInt(r, 3, 32);
      const mantissa = randInt(r, 1, 0x7fffff);
      const bits = ((exponent << 24) | mantissa) >>> 0;
      let target: bigint;
      try {
        target = bitsToTarget(bits);
      } catch {
        continue;   // rejected encodings are covered by the tests above
      }
      const again = targetToBits(target);
      expect(bitsToTarget(again), `bits 0x${bits.toString(16)} did not round-trip`).toBe(target);
    }
  });

  it('targetToBits rejects a negative target', () => {
    expect(rejects(() => targetToBits(-1n))).toBe(true);
  });
});

describe('header: the proof-of-work floor', () => {
  it('rejects a header easier than the mainnet limit', () => {
    const r = rng(0x55550000);
    const h = parseHeader(mine(REGTEST_BITS, randBytes(r, 32)));
    // Regtest's target is far easier than mainnet's difficulty-1 floor.
    expect(rejects(() => checkPowLimit(h, undefined)), 'regtest header against the mainnet floor').toBe(true);
  });

  it('accepts the same header when the floor is set for that chain, and when disabled', () => {
    const r = rng(0x66660000);
    const h = parseHeader(mine(REGTEST_BITS, randBytes(r, 32)));
    expect(rejects(() => checkPowLimit(h, REGTEST_BITS)), 'regtest header against the regtest floor').toBe(false);
    expect(rejects(() => checkPowLimit(h, null)), 'floor disabled').toBe(false);
  });
});

describe('header: chain linkage', () => {
  it('rejects a chain whose links do not match', () => {
    const r = rng(0x77770000);
    const a = parseHeader(mine(REGTEST_BITS, randBytes(r, 32)));
    const b = parseHeader(mine(REGTEST_BITS, randBytes(r, 32)));
    // b.prevBlock is all zeros, not a.hash, so the pair must not link.
    expect(rejects(() => verifyHeaderChain([a, b])), 'unlinked pair').toBe(true);
  });

  it('accepts a single valid header', () => {
    const r = rng(0x88880000);
    const a = parseHeader(mine(REGTEST_BITS, randBytes(r, 32)));
    expect(rejects(() => verifyHeaderChain([a])), 'single valid header').toBe(false);
  });
});
