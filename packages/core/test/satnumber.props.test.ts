/**
 * Property tests for the ordinal arithmetic: packages/core/src/satnumber.ts
 *
 *    9. SUBSIDY LADDER    consecutive block starts differ by exactly that
 *                         block's subsidy, at every halving and past the end
 *   10. SAT BIJECTION     (height, offset) and sat number invert each other
 *                         over the whole sat space
 *   11. RARITY            rarity is exactly the periodic events, so a block
 *                         holds one non-common sat and it is the first
 *   12. NAME BIJECTION    the reversed bijective base-26 name inverts
 *   13. POSITION          output space and input space are one flattened
 *                         space, and a position round-trips through both
 *   14. TERMINAL          the coinbase rule numbers subsidy positions and
 *                         refuses the fee tail, and BIP34 heights read back
 *
 * The arithmetic is pure and total, so these run over drawn values rather than
 * chosen ones. What they protect is the number itself: a sat number, its name
 * and its rarity are the whole answer `ord-resolve sat` gives, and an
 * arithmetic slip anywhere in this file is a wrong answer rather than a
 * refusal.
 */

import { describe, it, expect } from 'vitest';
import {
  subsidySats,
  firstSatOfBlock,
  satToHeight,
  satRarity,
  satName,
  outputSpacePosition,
  containingInput,
  coinbaseSatAt,
  bip34Height,
  CustodyUnsupportedError,
  SatPositionError,
  SatFundingIncompleteError,
  EPOCH_BLOCKS,
  CYCLE_BLOCKS,
  DIFFCHANGE_BLOCKS,
  TOTAL_SATS,
  LAST_SAT,
  type SatRarity,
} from '@ordspv/core';
import {
  randInt,
  randBigInt,
  rejects,
  forEachCase,
  buildLegacyTx,
  buildCoinbaseTx,
  randomFundedTx,
} from './gen.js';

/** Heights past this have no subsidy at all; the cumulative sum goes flat. */
const FINAL_EPOCH_HEIGHT = 33 * EPOCH_BLOCKS; // 6_930_000
const LAST_MINED_HEIGHT = FINAL_EPOCH_HEIGHT - 1;

/** Every halving edge, both sides, plus the cycle and the far end. */
const BOUNDARY_HEIGHTS = [
  0,
  1,
  2,
  DIFFCHANGE_BLOCKS - 1,
  DIFFCHANGE_BLOCKS,
  EPOCH_BLOCKS - 1,
  EPOCH_BLOCKS,
  EPOCH_BLOCKS + 1,
  CYCLE_BLOCKS - 1,
  CYCLE_BLOCKS,
  CYCLE_BLOCKS + 1,
  LAST_MINED_HEIGHT - 1,
  LAST_MINED_HEIGHT,
  FINAL_EPOCH_HEIGHT,
  FINAL_EPOCH_HEIGHT + 1,
  FINAL_EPOCH_HEIGHT + 100_000,
  ...Array.from({ length: 34 }, (_, e) => e * EPOCH_BLOCKS),
  ...Array.from({ length: 34 }, (_, e) => e * EPOCH_BLOCKS - 1).filter((h) => h >= 0),
];

// ---------------------------------------------------------------------------
// 9. SUBSIDY LADDER
// ---------------------------------------------------------------------------

describe('subsidy and cumulative sum cohere', () => {
  it('firstSatOfBlock(h + 1) - firstSatOfBlock(h) is subsidySats(h), at every boundary', () => {
    for (const h of BOUNDARY_HEIGHTS) {
      expect(firstSatOfBlock(h + 1) - firstSatOfBlock(h), `height ${h}`).toBe(subsidySats(h));
    }
  });

  it('the same holds for drawn heights, mined and past the end', () => {
    forEachCase(0x5a70_0001, 300, (r) => {
      const h = randInt(r, 0, FINAL_EPOCH_HEIGHT + 500_000);
      expect(firstSatOfBlock(h + 1) - firstSatOfBlock(h), `height ${h}`).toBe(subsidySats(h));
    });
  });

  it('the subsidy is the initial one halved per epoch, and zero from epoch 33', () => {
    forEachCase(0x5a70_0002, 200, (r) => {
      const h = randInt(r, 0, FINAL_EPOCH_HEIGHT + 500_000);
      const epoch = Math.floor(h / EPOCH_BLOCKS);
      const expected = epoch >= 33 ? 0n : 5_000_000_000n >> BigInt(epoch);
      expect(subsidySats(h), `height ${h} (epoch ${epoch})`).toBe(expected);
    });
    // the last epoch that pays anything pays one sat a block
    expect(subsidySats(LAST_MINED_HEIGHT)).toBe(1n);
    expect(subsidySats(FINAL_EPOCH_HEIGHT)).toBe(0n);
  });

  it('the cumulative sum is monotone, and flat once the subsidy is zero', () => {
    let previous = -1n;
    for (const h of [...BOUNDARY_HEIGHTS].sort((a, b) => a - b)) {
      const start = firstSatOfBlock(h);
      expect(start >= previous, `height ${h} went backwards`).toBe(true);
      previous = start;
    }
    expect(firstSatOfBlock(FINAL_EPOCH_HEIGHT)).toBe(TOTAL_SATS);
    expect(firstSatOfBlock(FINAL_EPOCH_HEIGHT + 1)).toBe(TOTAL_SATS);
    expect(firstSatOfBlock(FINAL_EPOCH_HEIGHT + 1_000_000)).toBe(TOTAL_SATS);
    expect(TOTAL_SATS).toBe(2_099_999_997_690_000n);
    expect(LAST_SAT).toBe(TOTAL_SATS - 1n);
  });
});

// ---------------------------------------------------------------------------
// 10. SAT BIJECTION
// ---------------------------------------------------------------------------

describe('height and offset round-trip through the sat number', () => {
  it('satToHeight inverts firstSatOfBlock + offset for drawn heights', () => {
    forEachCase(0x5a70_0010, 400, (r) => {
      const h = randInt(r, 0, LAST_MINED_HEIGHT);
      const subsidy = subsidySats(h);
      expect(subsidy > 0n, `height ${h} must still pay a subsidy`).toBe(true);
      const offset = randBigInt(r, 0n, subsidy - 1n);
      const sat = firstSatOfBlock(h) + offset;
      expect(satToHeight(sat), `sat ${sat} from height ${h} offset ${offset}`).toEqual({
        height: h,
        offset,
      });
    });
  });

  it('and the boundary heights, at both edges of their subsidy range', () => {
    for (const h of BOUNDARY_HEIGHTS.filter((x) => x <= LAST_MINED_HEIGHT)) {
      const subsidy = subsidySats(h);
      for (const offset of [0n, subsidy / 2n, subsidy - 1n]) {
        const sat = firstSatOfBlock(h) + offset;
        expect(satToHeight(sat), `height ${h} offset ${offset}`).toEqual({ height: h, offset });
      }
    }
  });

  it('every sat in the space folds back to the block that mined it', () => {
    forEachCase(0x5a70_0011, 400, (r) => {
      const sat = randBigInt(r, 0n, LAST_SAT);
      const { height, offset } = satToHeight(sat);
      expect(firstSatOfBlock(height) + offset, `sat ${sat}`).toBe(sat);
      expect(offset < subsidySats(height), `sat ${sat} offset ${offset} past the subsidy`).toBe(true);
      expect(offset >= 0n, `sat ${sat} negative offset`).toBe(true);
    });
    // the two ends, which no draw is guaranteed to hit
    expect(satToHeight(0n)).toEqual({ height: 0, offset: 0n });
    expect(satToHeight(LAST_SAT)).toEqual({ height: LAST_MINED_HEIGHT, offset: 0n });
    expect(satToHeight(TOTAL_SATS - 2n)).toEqual({ height: LAST_MINED_HEIGHT - 1, offset: 0n });
  });

  it('accepts both range edges and refuses either side of them', () => {
    expect(() => satToHeight(0n)).not.toThrow();
    expect(() => satToHeight(LAST_SAT)).not.toThrow();
    expect(rejects(() => satToHeight(-1n)), 'sat -1').toBe(true);
    expect(rejects(() => satToHeight(TOTAL_SATS)), 'sat TOTAL_SATS').toBe(true);
    expect(rejects(() => satToHeight(TOTAL_SATS * 2n)), 'sat far past the end').toBe(true);
    expect(satName(0n)).toBeTypeOf('string');
    expect(satName(LAST_SAT)).toBeTypeOf('string');
    expect(rejects(() => satName(-1n)), 'name of sat -1').toBe(true);
    expect(rejects(() => satName(TOTAL_SATS)), 'name of sat TOTAL_SATS').toBe(true);
    expect(rejects(() => satRarity(-1n)), 'rarity of sat -1').toBe(true);
    expect(rejects(() => satRarity(TOTAL_SATS)), 'rarity of sat TOTAL_SATS').toBe(true);
  });

  it('refuses heights that are negative, fractional or not a number at all', () => {
    // Number.isInteger(NaN) is false, so the one guard covers all three. The
    // point of pinning it is that a height arrives from a server's JSON, and a
    // fractional height that silently floored would move the sat number.
    for (const bad of [-1, -0.5, 0.5, 1.5, NaN, Infinity, -Infinity]) {
      expect(rejects(() => subsidySats(bad)), `subsidySats(${bad})`).toBe(true);
      expect(rejects(() => firstSatOfBlock(bad)), `firstSatOfBlock(${bad})`).toBe(true);
    }
    forEachCase(0x5a70_0012, 100, (r) => {
      const fractional = randInt(r, 0, 800_000) + r() * 0.9 + 0.05;
      expect(rejects(() => subsidySats(fractional)), `subsidySats(${fractional})`).toBe(true);
      expect(rejects(() => firstSatOfBlock(fractional)), `firstSatOfBlock(${fractional})`).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 11. RARITY
// ---------------------------------------------------------------------------

/** The periodic events, stated from the height rather than from the sat. */
function expectedRarityOfBlockStart(h: number): SatRarity {
  if (h === 0) return 'mythic';
  if (h % CYCLE_BLOCKS === 0) return 'legendary';
  if (h % EPOCH_BLOCKS === 0) return 'epic';
  if (h % DIFFCHANGE_BLOCKS === 0) return 'rare';
  return 'uncommon';
}

describe('rarity is exactly the periodic events', () => {
  it('a block start carries the rarity its height says, for drawn heights', () => {
    forEachCase(0x5a70_0020, 300, (r) => {
      // uniform draws almost never land on an epoch or cycle start, so the
      // draw is over multiples as often as over arbitrary heights
      const h = [
        randInt(r, 1, LAST_MINED_HEIGHT),
        randInt(r, 1, 3437) * DIFFCHANGE_BLOCKS,
        randInt(r, 1, 32) * EPOCH_BLOCKS,
        randInt(r, 1, 5) * CYCLE_BLOCKS,
      ][randInt(r, 0, 3)];
      expect(satRarity(firstSatOfBlock(h)), `height ${h}`).toBe(expectedRarityOfBlockStart(h));
    });
  });

  it('every other sat in the block is common', () => {
    forEachCase(0x5a70_0021, 300, (r) => {
      const h = randInt(r, 0, LAST_MINED_HEIGHT);
      const subsidy = subsidySats(h);
      if (subsidy < 2n) return; // epoch 32 blocks hold their first sat and nothing else
      const k = randBigInt(r, 1n, subsidy - 1n);
      expect(satRarity(firstSatOfBlock(h) + k), `height ${h} offset ${k}`).toBe('common');
    });
  });

  it('a whole block holds exactly one non-common sat, and it is the first', () => {
    // Late epochs pay few enough sats to scan a block exhaustively: epoch 27
    // pays 37 sats a block, epoch 32 pays one. Earlier blocks pay billions, so
    // the drawn-sample test above is the only reachable form there.
    for (const h of [27 * EPOCH_BLOCKS, 27 * EPOCH_BLOCKS + 1, 30 * EPOCH_BLOCKS + 5, LAST_MINED_HEIGHT]) {
      const subsidy = subsidySats(h);
      expect(subsidy > 0n && subsidy < 64n, `height ${h} subsidy ${subsidy} is scannable`).toBe(true);
      const start = firstSatOfBlock(h);
      const rarities: SatRarity[] = [];
      for (let k = 0n; k < subsidy; k++) rarities.push(satRarity(start + k));
      expect(rarities.filter((x) => x !== 'common').length, `height ${h}`).toBe(1);
      expect(rarities[0], `height ${h} first sat`).toBe(expectedRarityOfBlockStart(h));
      // and the block's last sat is the one before the next block's first
      expect(satToHeight(start + subsidy - 1n).height, `height ${h} last sat`).toBe(h);
      if (h < LAST_MINED_HEIGHT) {
        expect(satToHeight(start + subsidy).height, `height ${h} next block`).toBe(h + 1);
      } else {
        // there is no next block: this is the last sat the chain ever mines
        expect(start + subsidy).toBe(TOTAL_SATS);
      }
    }
  });

  it('sat 0 is mythic and nothing else is', () => {
    expect(satRarity(0n)).toBe('mythic');
    forEachCase(0x5a70_0022, 300, (r) => {
      const sat = randBigInt(r, 1n, LAST_SAT);
      expect(satRarity(sat), `sat ${sat}`).not.toBe('mythic');
    });
    // the block-start draw is where a second mythic could hide, since sat 0 is
    // a block start too
    for (const h of [1, DIFFCHANGE_BLOCKS, EPOCH_BLOCKS, CYCLE_BLOCKS, 2 * CYCLE_BLOCKS]) {
      expect(satRarity(firstSatOfBlock(h)), `height ${h}`).not.toBe('mythic');
    }
  });
});

// ---------------------------------------------------------------------------
// 12. NAME BIJECTION
// ---------------------------------------------------------------------------

/**
 * The inverse of satName: fold the name back through bijective base-26 and
 * subtract from the top of the space. Written here rather than shipped,
 * because a shipped inverse would share the encoder's mistakes.
 */
function satFromName(name: string): bigint {
  let x = 0n;
  for (const ch of name) {
    const digit = BigInt(ch.charCodeAt(0) - 97);
    x = x * 26n + digit + 1n;
  }
  return LAST_SAT - x + 1n;
}

describe('the ordinal name is a bijection', () => {
  it('matches the two documented anchors', () => {
    expect(satName(LAST_SAT)).toBe('a');
    expect(satName(0n)).toBe('nvtdijuwxlp');
    expect(satFromName('a')).toBe(LAST_SAT);
    expect(satFromName('nvtdijuwxlp')).toBe(0n);
  });

  it('round-trips through the inverse for drawn sats and both edges', () => {
    for (const sat of [0n, 1n, 25n, 26n, 27n, LAST_SAT, LAST_SAT - 1n, LAST_SAT - 26n]) {
      expect(satFromName(satName(sat)), `sat ${sat}`).toBe(sat);
    }
    forEachCase(0x5a70_0030, 400, (r) => {
      const sat = randBigInt(r, 0n, LAST_SAT);
      const name = satName(sat);
      expect(/^[a-z]{1,11}$/.test(name), `sat ${sat} name ${name}`).toBe(true);
      expect(satFromName(name), `sat ${sat} name ${name}`).toBe(sat);
    });
  });

  it('is injective over a drawn sample, including neighbours', () => {
    const seen = new Map<string, bigint>();
    forEachCase(0x5a70_0031, 200, (r) => {
      const base = randBigInt(r, 1n, LAST_SAT - 1n);
      for (const sat of [base - 1n, base, base + 1n]) {
        const name = satName(sat);
        const clash = seen.get(name);
        expect(clash === undefined || clash === sat, `name ${name} shared by ${clash} and ${sat}`).toBe(
          true,
        );
        seen.set(name, sat);
      }
    });
    expect(seen.size, 'the sample must be large enough to mean something').toBeGreaterThan(500);
  });

  it('names shorten as the sat number rises, which is what the reversal is for', () => {
    // not a rhetorical flourish: the encoding runs off the TOP of the space, so
    // a missed reversal shows up here as names growing the wrong way
    expect(satName(0n).length).toBe(11);
    expect(satName(LAST_SAT).length).toBe(1);
    forEachCase(0x5a70_0032, 100, (r) => {
      const a = randBigInt(r, 0n, LAST_SAT);
      const b = randBigInt(r, 0n, LAST_SAT);
      const [low, high] = a < b ? [a, b] : [b, a];
      expect(satName(low).length >= satName(high).length, `sats ${low} and ${high}`).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 13. POSITION: output space and input space are one flattened space
// ---------------------------------------------------------------------------

describe('output space and input space are inverse views of one position', () => {
  it('outputSpacePosition is the prefix sum of the outputs before it', () => {
    forEachCase(0x5a70_0040, 200, (r) => {
      const funded = randomFundedTx(r, { outputs: randInt(r, 1, 5) });
      const vout = randInt(r, 0, funded.outputValues.length - 1);
      const value = funded.outputValues[vout];
      const offset = randBigInt(r, 0n, value - 1n);
      let expected = offset;
      for (let i = 0; i < vout; i++) expected += funded.outputValues[i];
      expect(outputSpacePosition(funded.tx, vout, offset), `vout ${vout} offset ${offset}`).toBe(
        expected,
      );
    });
  });

  it('containingInput inverts the input-side prefix sum', () => {
    forEachCase(0x5a70_0041, 200, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 5) });
      const values = funded.inputValues;
      const input = randInt(r, 0, values.length - 1);
      const offsetInFunding = randBigInt(r, 0n, values[input] - 1n);
      let position = offsetInFunding;
      for (let i = 0; i < input; i++) position += values[i];
      expect(containingInput(funded.tx, values, position), `input ${input}`).toEqual({
        input,
        offsetInFunding,
      });
      // and back the other way, from a drawn position
      const drawn = randBigInt(r, 0n, values.reduce((s, v) => s + v, 0n) - 1n);
      const step = containingInput(funded.tx, values, drawn);
      let rebuilt = step.offsetInFunding;
      for (let i = 0; i < step.input; i++) rebuilt += values[i];
      expect(rebuilt, `position ${drawn} did not survive the decomposition`).toBe(drawn);
      expect(step.offsetInFunding < values[step.input], `position ${drawn} offset past its input`).toBe(
        true,
      );
    });
  });

  it('the same position names the same slot in both spaces, on a zero-fee transaction', () => {
    // outputs are a prefix slice of the concatenated inputs, so a transaction
    // whose outputs mirror its inputs must decode a position to the same index
    // and the same offset on either side. This is the conservation law the
    // backward walk rests on.
    forEachCase(0x5a70_0042, 200, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 5), outputs: 1 });
      const values = funded.inputValues;
      const mirror = buildLegacyTx(
        funded.tx.inputs.map((inp) => ({ txid: inp.prevTxid, vout: inp.vout })),
        values,
      );
      const slot = randInt(r, 0, values.length - 1);
      const offset = randBigInt(r, 0n, values[slot] - 1n);
      const position = outputSpacePosition(mirror.tx, slot, offset);
      expect(containingInput(mirror.tx, values, position), `slot ${slot} offset ${offset}`).toEqual({
        input: slot,
        offsetInFunding: offset,
      });
    });
  });

  it('refuses positions outside the space, by the class that says which fact it is', () => {
    forEachCase(0x5a70_0043, 100, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 2, 4), outputs: randInt(r, 1, 3) });
      const values = funded.inputValues;
      const lastVout = funded.outputValues.length - 1;
      // an offset at its output's value has left that output
      expect(
        rejects(() => outputSpacePosition(funded.tx, lastVout, funded.outputValues[lastVout])),
        'offset at the output value',
      ).toBe(true);
      expect(() => outputSpacePosition(funded.tx, lastVout, funded.outputValues[lastVout])).toThrow(
        SatPositionError,
      );
      expect(() => outputSpacePosition(funded.tx, lastVout + 1, 0n)).toThrow(SatPositionError);
      expect(() => outputSpacePosition(funded.tx, 0, -1n)).toThrow(SatPositionError);

      const totalIn = values.reduce((s, v) => s + v, 0n);
      // past every input sat the transaction has: the document contradicts itself
      expect(() => containingInput(funded.tx, values, totalIn)).toThrow(SatPositionError);
      expect(() => containingInput(funded.tx, values, totalIn + 1_000n)).toThrow(SatPositionError);
      // values that stop short while inputs remain: nothing contradicts itself,
      // the prev txs supplied just cannot say which input funded it
      const short = values.slice(0, values.length - 1);
      const shortTotal = short.reduce((s, v) => s + v, 0n);
      expect(() => containingInput(funded.tx, short, shortTotal)).toThrow(SatFundingIncompleteError);
      expect(() => containingInput(funded.tx, short, shortTotal)).toThrow(/more are needed/);
    });
  });

  it('a zero-value output occupies no position at all', () => {
    let zeroOutputsSeen = 0;
    forEachCase(0x5a70_0044, 60, (r) => {
      const funded = randomFundedTx(r, { inputs: 1, outputs: 3, zeroOutputs: true, fee: 0n });
      for (let vout = 0; vout < funded.outputValues.length; vout++) {
        if (funded.outputValues[vout] !== 0n) continue;
        zeroOutputsSeen++;
        // no offset at all is inside a zero-value output, so it is skipped
        // rather than being a slot a satpoint could name
        expect(() => outputSpacePosition(funded.tx, vout, 0n)).toThrow(SatPositionError);
      }
    });
    expect(zeroOutputsSeen, 'the draw must actually produce zero-value outputs').toBeGreaterThan(0);
    // and the fixed case, so the property holds whatever the draw does
    const built = buildLegacyTx([{ txid: '11'.repeat(32), vout: 0 }], [0n, 100n]);
    expect(() => outputSpacePosition(built.tx, 0, 0n)).toThrow(SatPositionError);
    expect(outputSpacePosition(built.tx, 1, 0n)).toBe(0n);
    expect(outputSpacePosition(built.tx, 1, 99n)).toBe(99n);
  });
});

// ---------------------------------------------------------------------------
// 14. TERMINAL: the coinbase rule and the BIP34 height
// ---------------------------------------------------------------------------

describe('coinbaseSatAt numbers subsidy positions and refuses the fee tail', () => {
  it('a position inside the subsidy is the block start plus the position', () => {
    forEachCase(0x5a70_0050, 200, (r) => {
      const height = randInt(r, 0, LAST_MINED_HEIGHT);
      const subsidy = subsidySats(height);
      const position = randBigInt(r, 0n, subsidy - 1n);
      const coinbase = buildCoinbaseTx([subsidy]);
      const sat = coinbaseSatAt(coinbase.tx, position, height);
      expect(sat, `height ${height} position ${position}`).toBe(firstSatOfBlock(height) + position);
      // and the sat it produced belongs to that block
      expect(satToHeight(sat), `height ${height} position ${position}`).toEqual({
        height,
        offset: position,
      });
    });
  });

  it('the boundary is the subsidy itself: one before numbers, the subsidy refuses', () => {
    for (const height of [0, 1, 209_999, 210_000, 500_000, 840_000, LAST_MINED_HEIGHT]) {
      const subsidy = subsidySats(height);
      const coinbase = buildCoinbaseTx([subsidy + 1_000n]);
      expect(coinbaseSatAt(coinbase.tx, subsidy - 1n, height), `height ${height}`).toBe(
        firstSatOfBlock(height) + subsidy - 1n,
      );
      for (const past of [subsidy, subsidy + 1n, subsidy + 999n]) {
        expect(() => coinbaseSatAt(coinbase.tx, past, height), `height ${height} position ${past}`)
          .toThrow(CustodyUnsupportedError);
      }
      try {
        coinbaseSatAt(coinbase.tx, subsidy, height);
        expect.unreachable('the fee tail must refuse');
      } catch (e) {
        expect((e as CustodyUnsupportedError).height, `height ${height} on the error`).toBe(height);
        expect((e as Error).message).toMatch(/fee sats in block/);
      }
    }
  });

  it('a block past the last subsidy has no position it can number', () => {
    const coinbase = buildCoinbaseTx([5_000n]);
    for (const height of [FINAL_EPOCH_HEIGHT, FINAL_EPOCH_HEIGHT + 1, FINAL_EPOCH_HEIGHT + 100_000]) {
      expect(() => coinbaseSatAt(coinbase.tx, 0n, height), `height ${height}`).toThrow(
        CustodyUnsupportedError,
      );
    }
  });

  it('refuses a transaction that is not a coinbase, before any arithmetic', () => {
    forEachCase(0x5a70_0051, 40, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 3) });
      expect(() => coinbaseSatAt(funded.tx, 0n, 100_000)).toThrow(/not a coinbase/);
      // the refusal is a plain Error: this is a malformed document, not an
      // ancestry that leaves v1's domain
      expect(() => coinbaseSatAt(funded.tx, 0n, 100_000)).not.toThrow(CustodyUnsupportedError);
    });
  });
});

/** BIP34's height push: CScriptNum little-endian, with a sign byte when needed. */
function minimalHeightPush(height: number): Uint8Array {
  const bytes: number[] = [];
  let left = height;
  while (left > 0) {
    bytes.push(left & 0xff);
    left = Math.floor(left / 256);
  }
  if (bytes.length === 0) bytes.push(0);
  else if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return new Uint8Array([bytes.length, ...bytes]);
}

describe('bip34Height reads the coinbase height push', () => {
  it('reads back the minimal push of a drawn height', () => {
    forEachCase(0x5a70_0060, 300, (r) => {
      const height = [
        randInt(r, 230_000, 1_200_000),
        randInt(r, 1, 0xff),
        randInt(r, 0x80, 0x8000), // needs the sign byte at one width or the next
        randInt(r, 0x7f_0000, 0x81_0000),
        randInt(r, 0, 0xffffff),
      ][randInt(r, 0, 4)];
      const coinbase = buildCoinbaseTx([1n], minimalHeightPush(height));
      expect(bip34Height(coinbase.tx), `height ${height}`).toBe(height);
    });
  });

  it('reads the fixed cases the boundary rule turns on', () => {
    for (const height of [230_000, 230_632, 500_000, 767_430, 840_000, 8_388_608, 8_388_607]) {
      const coinbase = buildCoinbaseTx([1n], minimalHeightPush(height));
      expect(bip34Height(coinbase.tx), `height ${height}`).toBe(height);
    }
  });

  it('returns undefined for a scriptSig that carries no readable push', () => {
    const cases: [string, Uint8Array][] = [
      ['empty scriptSig', new Uint8Array(0)],
      ['one byte', new Uint8Array([0x03])],
      ['zero-length push', new Uint8Array([0x00, 0x11])],
      ['truncated push', new Uint8Array([0x04, 0x70, 0x82])],
      ['truncated by one', new Uint8Array([0x03, 0x70, 0x82])],
      ['push too wide', new Uint8Array([0x09, 1, 2, 3, 4, 5, 6, 7, 8, 9])],
      ['an opcode, not a push', new Uint8Array([0x51])],
      ['a 20-byte push', new Uint8Array([0x14, ...new Array(20).fill(0xab)])],
      ['eight bytes past a safe integer', new Uint8Array([0x08, 0, 0, 0, 0, 0, 0, 0, 0xff])],
    ];
    for (const [label, scriptSig] of cases) {
      const coinbase = buildCoinbaseTx([1n], scriptSig);
      expect(bip34Height(coinbase.tx), label).toBeUndefined();
    }
  });

  it('reads a non-minimal push as the height it encodes, which is what it is', () => {
    // The reader is a decoder and not a consensus check: it takes the push
    // width the script declares and folds those bytes little-endian. A padded
    // push therefore reads back as the same height rather than being refused.
    // Consensus requires the minimal form at and above the boundary, so no
    // block on the chain carries a padded one, and the height a padded push
    // yields is the height it encodes either way. The verifier's own check is
    // the comparison against the claimed height, which this does not weaken.
    forEachCase(0x5a70_0061, 100, (r) => {
      const height = randInt(r, 230_000, 1_200_000);
      const minimal = minimalHeightPush(height);
      const width = minimal[0];
      const padding = randInt(r, 1, 8 - width);
      const padded = new Uint8Array([width + padding, ...minimal.slice(1), ...new Array(padding).fill(0)]);
      const coinbase = buildCoinbaseTx([1n], padded);
      expect(bip34Height(coinbase.tx), `height ${height} padded by ${padding}`).toBe(height);
    });
  });

  it('reads the trailing script the real coinbase carries after the height', () => {
    // a real coinbase pushes the height and then whatever the miner wants
    forEachCase(0x5a70_0062, 100, (r) => {
      const height = randInt(r, 230_000, 1_200_000);
      const tail = Array.from({ length: randInt(r, 0, 40) }, () => randInt(r, 0, 255));
      const coinbase = buildCoinbaseTx([1n], new Uint8Array([...minimalHeightPush(height), ...tail]));
      expect(bip34Height(coinbase.tx), `height ${height} with ${tail.length} trailing bytes`).toBe(
        height,
      );
    });
  });
});
