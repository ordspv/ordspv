/**
 * Property tests for the custody arithmetic: packages/core/src/custody.ts
 *
 *   15. SATPOINT         parse and format round-trip on values, and the
 *                        grammar admits nothing outside it
 *   16. TRANSFER         a spend conserves the sat's absolute position, over
 *                        one transaction and over a chain of them
 *   17. GENESIS          the reveal's rules fire in a fixed precedence, and
 *                        the order never varies with what else is true
 *   18. PROVEN VALUES    input values are a prefix of one another, and a prev
 *                        tx list is refused rather than narrowed
 *   19. INVERSES         the forward walk and the backward walk close on each
 *                        other over a chain of spends
 *
 * This is the sat's location, which is the whole answer `ord-resolve custody`
 * gives. The arithmetic runs on values a bundle proves, so a slip here puts an
 * inscription on an output it never reached with every hash still folding.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSatpoint,
  formatSatpoint,
  transferSatpoint,
  genesisSatpoint,
  provenInputValues,
  checkPrevTxCount,
  outputSpacePosition,
  containingInput,
  CustodyUnsupportedError,
  type Inscription,
  type Satpoint,
} from '@ordspv/core';
import {
  randInt,
  randBigInt,
  randTxid,
  rejects,
  pick,
  forEachCase,
  buildLegacyTx,
  buildCoinbaseTx,
  randomFundedTx,
  partition,
  type BuiltTx,
  type FundedTx,
} from './gen.js';

/** An inscription record carrying the fields the arithmetic reads. */
function inscription(partial: Partial<Inscription>): Inscription {
  return {
    index: 0,
    input: 0,
    parents: [],
    unboundByEvenField: false,
    flags: {
      incompleteField: false,
      duplicateField: false,
      unrecognizedEvenField: false,
      pushnum: false,
      stutter: false,
    },
    ...partial,
  };
}

const totalOf = (values: bigint[]): bigint => values.reduce((sum, v) => sum + v, 0n);

/** Where an absolute output-space position lands, or undefined for the fee. */
function decompose(values: bigint[], position: bigint): { vout: number; offset: bigint } | undefined {
  let left = position;
  for (let vout = 0; vout < values.length; vout++) {
    if (left < values[vout]) return { vout, offset: left };
    left -= values[vout];
  }
  return undefined;
}

/** The satpoint naming input `j`'s funding outpoint, at `offset` into it. */
function trackedInput(funded: FundedTx, j: number, offset: bigint): Satpoint {
  return { txid: funded.tx.inputs[j].prevTxid, vout: funded.tx.inputs[j].vout, offset };
}

// ---------------------------------------------------------------------------
// 15. SATPOINT
// ---------------------------------------------------------------------------

describe('satpoint parse and format round-trip', () => {
  it('parse inverts format on values, for drawn satpoints', () => {
    forEachCase(0xc05d_0001, 300, (r) => {
      const sp: Satpoint = {
        txid: randTxid(r),
        // vout is a JS number in the record and a decimal run in the string;
        // draw it across the whole 32-bit outpoint range
        vout: pick(r, [0, 1, 2, randInt(r, 0, 1000), randInt(r, 0, 0xffffffff), 0xffffffff]),
        offset: pick(r, [0n, 1n, randBigInt(r, 0n, 2_100_000_000_000_000n), 546n]),
      };
      const s = formatSatpoint(sp);
      expect(parseSatpoint(s), `satpoint ${s}`).toEqual(sp);
      // and the string is canonical, so it survives the round trip too
      expect(formatSatpoint(parseSatpoint(s)), `satpoint ${s}`).toBe(s);
    });
  });

  it('normalises an uppercase txid to lowercase and changes nothing else', () => {
    forEachCase(0xc05d_0002, 100, (r) => {
      const txid = randTxid(r);
      const vout = randInt(r, 0, 5000);
      const offset = randBigInt(r, 0n, 100_000n);
      const upper = `${txid.toUpperCase()}:${vout}:${offset}`;
      expect(parseSatpoint(upper), `satpoint ${upper}`).toEqual({ txid, vout, offset });
    });
  });

  it('is an identity on values and not on strings', () => {
    // the grammar's \d+ admits leading zeros, so a padded satpoint parses to
    // the same location and formats back shorter. The bundle check that reads
    // this compares the parsed VALUES against the recomputed ones, which is
    // why the direction that holds is the one that matters
    const txid = randTxid(() => 0.5);
    const padded = `${txid}:007:0042`;
    const sp = parseSatpoint(padded);
    expect(sp).toEqual({ txid, vout: 7, offset: 42n });
    expect(formatSatpoint(sp)).toBe(`${txid}:7:42`);
    expect(parseSatpoint(formatSatpoint(sp))).toEqual(sp);
    // the one padded form that is already canonical
    expect(parseSatpoint(`${txid}:0:0`)).toEqual({ txid, vout: 0, offset: 0n });
  });

  it('refuses everything outside the grammar', () => {
    const good = randTxid(() => 0.25);
    const bad: [string, string][] = [
      ['empty', ''],
      ['txid alone', good],
      ['no offset', `${good}:0`],
      ['empty vout', `${good}::0`],
      ['empty offset', `${good}:0:`],
      ['extra segment', `${good}:0:0:0`],
      ['63-char txid', `${good.slice(0, 63)}:0:0`],
      ['65-char txid', `${good}a:0:0`],
      ['non-hex txid', `${'z'.repeat(64)}:0:0`],
      ['negative vout', `${good}:-1:0`],
      ['negative offset', `${good}:0:-1`],
      ['plus-signed vout', `${good}:+1:0`],
      ['fractional offset', `${good}:0:1.5`],
      ['hex offset', `${good}:0:0x10`],
      ['trailing text', `${good}:0:0x`],
      ['trailing space', `${good}:0:0 `],
      ['leading space', ` ${good}:0:0`],
      ['inner space', `${good}:0: 0`],
      ['newline', `${good}:0:0\n`],
      ['inscription id, not a satpoint', `${good}i0`],
      ['dots for colons', `${good}.0.0`],
    ];
    for (const [label, s] of bad) {
      expect(rejects(() => parseSatpoint(s)), `${label}: ${JSON.stringify(s)}`).toBe(true);
    }
  });

  it('refuses drawn corruptions of a valid satpoint', () => {
    forEachCase(0xc05d_0003, 200, (r) => {
      const txid = randTxid(r);
      const s = `${txid}:${randInt(r, 0, 1000)}:${randBigInt(r, 0n, 100_000n)}`;
      const broken = pick(r, [
        s.slice(1), // txid one short
        `a${s}`, // txid one long
        s.replace(':', ''), // first colon gone
        s.replace(/:(\d+)$/, ':$1x'), // junk after the offset
        `${s.slice(0, randInt(r, 0, 63))}g${s.slice(randInt(r, 0, 63) + 1)}`, // non-hex in the txid
        s.replace(/^(.{64}):/, '$1;'), // wrong separator
      ]);
      // the mutations above all leave the grammar; assert that rather than
      // assuming it, so a generator that stopped mutating cannot pass silently
      expect(/^[0-9a-fA-F]{64}:\d+:\d+$/.test(broken), `still valid: ${broken}`).toBe(false);
      expect(rejects(() => parseSatpoint(broken)), `corruption ${JSON.stringify(broken)}`).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 16. TRANSFER
// ---------------------------------------------------------------------------

describe('a spend conserves the sat position', () => {
  it('maps an input-space position to the same position in output space', () => {
    forEachCase(0xc05d_0010, 250, (r) => {
      const funded = randomFundedTx(r, {
        inputs: randInt(r, 1, 4),
        outputs: randInt(r, 1, 4),
        // a zero-value output occupies no sat space, so the walk must step
        // over it rather than land on it
        zeroOutputs: randInt(r, 0, 2) === 0,
      });
      const values = funded.inputValues;
      const j = randInt(r, 0, values.length - 1);
      const offset = randBigInt(r, 0n, values[j] - 1n);
      let position = offset;
      for (let i = 0; i < j; i++) position += values[i];
      const from = trackedInput(funded, j, offset);

      if (position >= totalOf(funded.outputValues)) {
        // the sat left the output space; that is the fee refusal, not an answer
        expect(() => transferSatpoint(funded.tx, values, from), `position ${position}`).toThrow(
          CustodyUnsupportedError,
        );
        return;
      }
      const sp = transferSatpoint(funded.tx, values, from);
      expect(sp.txid, `input ${j} offset ${offset}`).toBe(funded.tx.txid);
      expect(outputSpacePosition(funded.tx, sp.vout, sp.offset), `input ${j} offset ${offset}`).toBe(
        position,
      );
      expect(sp, `input ${j} offset ${offset}`).toEqual({
        txid: funded.tx.txid,
        ...decompose(funded.outputValues, position),
      });
    });
  });

  it('pins both sides of the fee boundary', () => {
    forEachCase(0xc05d_0011, 150, (r) => {
      const value = randBigInt(r, 1_000n, 1_000_000n);
      const fee = randBigInt(r, 1n, 500n);
      const prev = buildLegacyTx([{ txid: randTxid(r), vout: 0 }], [value]);
      const outputs = partition(r, value - fee, randInt(r, 1, 4));
      const spend = buildLegacyTx([{ txid: prev.tx.txid, vout: 0 }], outputs);
      const totalOut = totalOf(outputs);
      const from = (offset: bigint): Satpoint => ({ txid: prev.tx.txid, vout: 0, offset });

      const last = transferSatpoint(spend.tx, [value], from(totalOut - 1n));
      expect(last.vout, `fee ${fee}`).toBe(outputs.length - 1);
      expect(last.offset, `fee ${fee}`).toBe(outputs[outputs.length - 1] - 1n);
      expect(() => transferSatpoint(spend.tx, [value], from(totalOut)), `fee ${fee}`).toThrow(
        CustodyUnsupportedError,
      );
      // the height the caller passes travels on the refusal, so a report can
      // say where the path left v1's domain
      try {
        transferSatpoint(spend.tx, [value], from(totalOut), 812_345);
        expect.unreachable('a position in the fee must refuse');
      } catch (e) {
        expect((e as CustodyUnsupportedError).height).toBe(812_345);
        expect((e as Error).message).toContain(spend.tx.txid);
      }
    });
  });

  it('survives composition through a chain of spends', () => {
    forEachCase(0xc05d_0012, 60, (r) => {
      // zero fee throughout: every position stays inside the output space, so
      // the chain is about the arithmetic composing rather than about refusals
      let funded = randomFundedTx(r, { inputs: randInt(r, 1, 3), outputs: randInt(r, 1, 3), fee: 0n });
      const start = randBigInt(r, 0n, funded.inputValues[0] - 1n);
      let sp = transferSatpoint(funded.tx, funded.inputValues, trackedInput(funded, 0, start));
      expect(outputSpacePosition(funded.tx, sp.vout, sp.offset), 'first hop').toBe(start);

      const steps = randInt(r, 2, 5);
      for (let step = 0; step < steps; step++) {
        const spentValue = funded.outputValues[sp.vout];
        const next = randomFundedTx(r, {
          inputs: randInt(r, 1, 3),
          outputs: randInt(r, 1, 3),
          fee: 0n,
          spends: { hex: funded.hex, txid: funded.tx.txid, vout: sp.vout, value: spentValue },
        });
        // the sat enters `next` through input 0, which spends the tracked output
        const expectedPosition = sp.offset;
        const moved = transferSatpoint(next.tx, next.inputValues, sp);
        expect(moved.txid, `step ${step}`).toBe(next.tx.txid);
        expect(outputSpacePosition(next.tx, moved.vout, moved.offset), `step ${step}`).toBe(
          expectedPosition,
        );
        // the invariant every hop must keep: the sat sits inside its output
        expect(moved.offset < next.outputValues[moved.vout], `step ${step} offset outside`).toBe(true);
        funded = next;
        sp = moved;
      }
      expect(steps).toBeGreaterThan(1);
    });
  });

  it('names the transaction and the satpoint when the spend is not there', () => {
    forEachCase(0xc05d_0013, 100, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 3) });
      const stranger: Satpoint = { txid: randTxid(r), vout: randInt(r, 0, 3), offset: 0n };
      expect(() => transferSatpoint(funded.tx, funded.inputValues, stranger)).toThrow(
        new RegExp(`${funded.tx.txid} does not spend ${stranger.txid}:${stranger.vout}`),
      );
      // the right transaction at the wrong vout is the same refusal: an
      // outpoint is the pair, and the pair is what the input names
      const wrongVout = trackedInput(funded, 0, 0n);
      wrongVout.vout += 1;
      expect(() => transferSatpoint(funded.tx, funded.inputValues, wrongVout)).toThrow(
        /does not spend/,
      );
    });
  });

  it('asks for the input values it needs rather than reading past them', () => {
    forEachCase(0xc05d_0014, 60, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 2, 4) });
      const j = funded.inputValues.length - 1;
      const from = trackedInput(funded, j, 0n);
      expect(() => transferSatpoint(funded.tx, funded.inputValues.slice(0, j), from)).toThrow(
        new RegExp(`need input values for inputs 0\\.\\.${j}`),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 17. GENESIS
// ---------------------------------------------------------------------------

type GenesisOutcome =
  | 'coinbase'
  | 'input-out-of-range'
  | 'values-too-short'
  | 'unbound'
  | 'fee'
  | { vout: number; offset: bigint };

/**
 * The precedence genesisSatpoint applies, restated from the source order at
 * custody.ts:336-376. The test draws conditions independently and asserts the
 * function agrees with this table, so an ordering change shows up as a
 * disagreement rather than as a differently-shaped answer.
 */
function expectedGenesis(
  inputCount: number,
  isCoinbase: boolean,
  insc: Inscription,
  values: bigint[],
  outputValues: bigint[],
): GenesisOutcome {
  if (isCoinbase) return 'coinbase';
  if (insc.input >= inputCount) return 'input-out-of-range';
  if (values.length < insc.input + 1) return 'values-too-short';
  if (insc.unboundByEvenField || values[insc.input] === 0n) return 'unbound';
  const totalOut = totalOf(outputValues);
  if (insc.pointer !== undefined && insc.pointer < totalOut) {
    return decompose(outputValues, insc.pointer)!;
  }
  let position = 0n;
  for (let i = 0; i < insc.input; i++) position += values[i];
  return decompose(outputValues, position) ?? 'fee';
}

describe('the genesis rules fire in one precedence order', () => {
  it('agrees with the precedence table whichever conditions hold', () => {
    const counts = new Map<string, number>();
    forEachCase(0xc05d_0020, 400, (r) => {
      const inputCount = randInt(r, 1, 4);
      const funded = randomFundedTx(r, {
        inputs: inputCount,
        outputs: randInt(r, 1, 3),
        // a fee big enough that the default position lands past the outputs
        // some of the time, which is the branch that refuses
        fee: randInt(r, 0, 2) === 0 ? undefined : 0n,
      });
      const isCoinbase = randInt(r, 0, 5) === 0;
      const tx = isCoinbase ? buildCoinbaseTx(funded.outputValues).tx : funded.tx;
      const effectiveInputs = isCoinbase ? 1 : inputCount;

      const insc = inscription({
        input: randInt(r, 0, 5) === 0 ? inputCount + randInt(r, 0, 2) : randInt(r, 0, inputCount - 1),
        unboundByEvenField: randInt(r, 0, 4) === 0,
        pointer:
          randInt(r, 0, 1) === 0
            ? undefined
            : pick(r, [
                0n,
                randBigInt(r, 0n, totalOf(funded.outputValues)),
                totalOf(funded.outputValues),
                totalOf(funded.outputValues) + randBigInt(r, 1n, 1000n),
              ]),
      });
      let values = [...funded.inputValues];
      if (randInt(r, 0, 4) === 0) values = values.slice(0, Math.max(0, insc.input));
      if (values.length > insc.input && randInt(r, 0, 4) === 0) values[insc.input] = 0n;

      const expected = expectedGenesis(effectiveInputs, isCoinbase, insc, values, funded.outputValues);
      counts.set(
        typeof expected === 'string' ? expected : 'satpoint',
        (counts.get(typeof expected === 'string' ? expected : 'satpoint') ?? 0) + 1,
      );
      const detail = `input ${insc.input}/${effectiveInputs}, values ${values.length}, pointer ${insc.pointer}, unbound ${insc.unboundByEvenField}`;

      if (expected === 'coinbase') {
        expect(() => genesisSatpoint(tx, insc, values), detail).toThrow(/cannot carry inscriptions/);
      } else if (expected === 'input-out-of-range') {
        expect(() => genesisSatpoint(tx, insc, values), detail).toThrow(
          new RegExp(`envelope input ${insc.input} out of range`),
        );
      } else if (expected === 'values-too-short') {
        expect(() => genesisSatpoint(tx, insc, values), detail).toThrow(/need input values for inputs/);
      } else if (expected === 'unbound') {
        expect(() => genesisSatpoint(tx, insc, values), detail).toThrow(CustodyUnsupportedError);
        expect(() => genesisSatpoint(tx, insc, values), detail).toThrow(/unbound at reveal/);
      } else if (expected === 'fee') {
        expect(() => genesisSatpoint(tx, insc, values), detail).toThrow(CustodyUnsupportedError);
        expect(() => genesisSatpoint(tx, insc, values), detail).toThrow(/bound to fee sats/);
      } else {
        expect(genesisSatpoint(tx, insc, values), detail).toEqual({ txid: tx.txid, ...expected });
      }
    });
    // every branch of the table must actually have been drawn, or the
    // agreement above is agreement about nothing
    for (const branch of ['coinbase', 'input-out-of-range', 'values-too-short', 'unbound', 'fee', 'satpoint']) {
      expect(counts.get(branch) ?? 0, `branch ${branch} was never drawn`).toBeGreaterThan(0);
    }
  });

  it('a pointer inside the output space wins over the envelope input position', () => {
    forEachCase(0xc05d_0021, 150, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 2, 4), outputs: randInt(r, 2, 4), fee: 0n });
      const k = randInt(r, 1, funded.inputValues.length - 1);
      const totalOut = totalOf(funded.outputValues);
      const pointer = randBigInt(r, 0n, totalOut - 1n);
      const withPointer = genesisSatpoint(funded.tx, inscription({ input: k, pointer }), funded.inputValues);
      expect(outputSpacePosition(funded.tx, withPointer.vout, withPointer.offset), `pointer ${pointer}`)
        .toBe(pointer);

      // and without it the position is the sum of the inputs before k
      let position = 0n;
      for (let i = 0; i < k; i++) position += funded.inputValues[i];
      const without = genesisSatpoint(funded.tx, inscription({ input: k }), funded.inputValues);
      expect(outputSpacePosition(funded.tx, without.vout, without.offset), `input ${k}`).toBe(position);
    });
  });

  it('a pointer at or past the total output sats is ignored', () => {
    forEachCase(0xc05d_0022, 150, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 3), outputs: randInt(r, 1, 3), fee: 0n });
      const totalOut = totalOf(funded.outputValues);
      const k = randInt(r, 0, funded.inputValues.length - 1);
      const ignored = pick(r, [totalOut, totalOut + 1n, totalOut * 2n, totalOut + 1_000_000n]);
      const withPointer = genesisSatpoint(
        funded.tx,
        inscription({ input: k, pointer: ignored }),
        funded.inputValues,
      );
      const without = genesisSatpoint(funded.tx, inscription({ input: k }), funded.inputValues);
      expect(withPointer, `pointer ${ignored} of ${totalOut}`).toEqual(without);
    });
  });

  it('an unbound inscription is refused whatever the pointer says', () => {
    forEachCase(0xc05d_0023, 150, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 3), outputs: randInt(r, 1, 3), fee: 0n });
      const k = randInt(r, 0, funded.inputValues.length - 1);
      const totalOut = totalOf(funded.outputValues);
      const pointer = pick(r, [undefined, 0n, randBigInt(r, 0n, totalOut - 1n), totalOut + 5n]);
      const height = randInt(r, 1, 900_000);

      const zeroValues = [...funded.inputValues];
      zeroValues[k] = 0n;
      for (const [label, insc, values] of [
        ['zero-value envelope input', inscription({ input: k, pointer }), zeroValues],
        [
          'unrecognized even field',
          inscription({ input: k, pointer, unboundByEvenField: true }),
          funded.inputValues,
        ],
      ] as [string, Inscription, bigint[]][]) {
        try {
          genesisSatpoint(funded.tx, insc, values, height);
          expect.unreachable(`${label} with pointer ${pointer} must refuse`);
        } catch (e) {
          expect(e, label).toBeInstanceOf(CustodyUnsupportedError);
          expect((e as Error).message, label).toMatch(/unbound at reveal/);
          expect((e as CustodyUnsupportedError).height, label).toBe(height);
        }
      }
    });
  });

  it('carries the height on the fee refusal, so a report can say where', () => {
    forEachCase(0xc05d_0024, 60, (r) => {
      // every input funds sats the outputs do not carry, so the last input's
      // first sat is past the output space
      const inputs = randInt(r, 2, 4);
      const funded = randomFundedTx(r, { inputs, outputs: 1, fee: 0n });
      const shrunk = buildLegacyTx(
        funded.tx.inputs.map((inp) => ({ txid: inp.prevTxid, vout: inp.vout })),
        [funded.inputValues[0]],
      );
      const height = randInt(r, 1, 900_000);
      try {
        genesisSatpoint(shrunk.tx, inscription({ input: inputs - 1 }), funded.inputValues, height);
        expect.unreachable('a genesis in the fee must refuse');
      } catch (e) {
        expect(e).toBeInstanceOf(CustodyUnsupportedError);
        expect((e as Error).message).toMatch(/bound to fee sats at reveal/);
        expect((e as CustodyUnsupportedError).height).toBe(height);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 18. PROVEN VALUES
// ---------------------------------------------------------------------------

describe('input values are proven from the transactions that funded them', () => {
  it('reads each input value out of the prev tx the input names', () => {
    forEachCase(0xc05d_0030, 200, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 5) });
      const upTo = randInt(r, 0, funded.inputValues.length - 1);
      expect(provenInputValues(funded.tx, funded.prevTxsHex, upTo), `upTo ${upTo}`).toEqual(
        funded.inputValues.slice(0, upTo + 1),
      );
    });
  });

  it('the values for one upTo are a prefix of the values for any larger one', () => {
    forEachCase(0xc05d_0031, 150, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 2, 5) });
      const last = funded.inputValues.length - 1;
      const full = provenInputValues(funded.tx, funded.prevTxsHex, last);
      for (let upTo = 0; upTo <= last; upTo++) {
        expect(provenInputValues(funded.tx, funded.prevTxsHex, upTo), `upTo ${upTo}`).toEqual(
          full.slice(0, upTo + 1),
        );
      }
    });
  });

  it('entries past upTo are not read, which is the documented carve-out', () => {
    // custody reads inputs 0..upTo because later ones cannot move the
    // position; a genealogy verifier uses every entry, which is why the count
    // check refuses a surplus rather than this function ignoring one
    forEachCase(0xc05d_0032, 100, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 2, 4) });
      const upTo = randInt(r, 0, funded.inputValues.length - 2);
      const before = provenInputValues(funded.tx, funded.prevTxsHex, upTo);
      const tampered = [...funded.prevTxsHex];
      tampered[funded.prevTxsHex.length - 1] = buildLegacyTx(
        [{ txid: randTxid(r), vout: 0 }],
        [1n],
      ).hex;
      expect(provenInputValues(funded.tx, tampered, upTo), `upTo ${upTo}`).toEqual(before);
      // and the same tampering IS read once upTo reaches it
      const lastIndex = funded.prevTxsHex.length - 1;
      expect(() => provenInputValues(funded.tx, tampered, lastIndex)).toThrow(/hashes to/);
    });
  });

  it('refuses an index past the inputs and a list that stops short', () => {
    forEachCase(0xc05d_0033, 100, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 4) });
      const n = funded.inputValues.length;
      expect(() => provenInputValues(funded.tx, funded.prevTxsHex, n)).toThrow(
        new RegExp(`input index ${n} out of range`),
      );
      expect(() => provenInputValues(funded.tx, funded.prevTxsHex, n + 5)).toThrow(/out of range/);
      const upTo = n - 1;
      expect(() => provenInputValues(funded.tx, funded.prevTxsHex.slice(0, upTo), upTo)).toThrow(
        new RegExp(`need prev txs for inputs 0\\.\\.${upTo}, got ${upTo}`),
      );
      expect(() => provenInputValues(funded.tx, [], 0)).toThrow(/need prev txs/);
    });
  });

  it('refuses a prev tx that is not the transaction the input names', () => {
    forEachCase(0xc05d_0034, 150, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 2, 4) });
      const i = randInt(r, 0, funded.inputValues.length - 1);
      const swapped = [...funded.prevTxsHex];
      const other = buildLegacyTx([{ txid: randTxid(r), vout: 0 }], [999n]);
      swapped[i] = other.hex;
      expect(() => provenInputValues(funded.tx, swapped, funded.inputValues.length - 1), `input ${i}`)
        .toThrow(new RegExp(`prev tx ${i} hashes to ${other.tx.txid}`));

      // two honest prev txs in the wrong order is the same refusal
      if (funded.inputValues.length >= 2) {
        const reordered = [...funded.prevTxsHex];
        [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
        expect(() => provenInputValues(funded.tx, reordered, 1)).toThrow(/hashes to/);
      }
    });
  });

  it('refuses a prev tx with no output at the index the input spends', () => {
    forEachCase(0xc05d_0035, 60, (r) => {
      // one input spending a high vout of its funder, with the funder rebuilt
      // to carry fewer outputs than that
      const prevOutputs = partition(r, randBigInt(r, 10n, 100_000n), 3);
      const prev = buildLegacyTx([{ txid: randTxid(r), vout: 0 }], prevOutputs);
      const spend = buildLegacyTx([{ txid: prev.tx.txid, vout: 2 }], [prevOutputs[2] - 1n]);
      expect(provenInputValues(spend.tx, [prev.hex], 0)).toEqual([prevOutputs[2]]);

      const shortPrev = buildLegacyTx(
        [{ txid: prev.tx.inputs[0].prevTxid, vout: prev.tx.inputs[0].vout }],
        prevOutputs.slice(0, 2),
      );
      // the shortened funder is a different transaction, so the hash check is
      // what fires; a funder that keeps its txid cannot lose an output
      expect(() => provenInputValues(spend.tx, [shortPrev.hex], 0)).toThrow(/hashes to/);
      // reaching the no-output message needs the input to name a vout the
      // named transaction does not have
      const beyond = buildLegacyTx([{ txid: prev.tx.txid, vout: 7 }], [1n]);
      expect(() => provenInputValues(beyond.tx, [prev.hex], 0)).toThrow(/has no output 7/);
    });
  });

  it('refuses an entry that does not parse, and names the entry', () => {
    forEachCase(0xc05d_0036, 100, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 3) });
      const i = randInt(r, 0, funded.inputValues.length - 1);
      const broken = [...funded.prevTxsHex];
      broken[i] = pick(r, [
        '',
        'zz',
        funded.prevTxsHex[i].slice(0, randInt(r, 1, funded.prevTxsHex[i].length - 1)),
        `${funded.prevTxsHex[i]}00`,
      ]);
      expect(() => provenInputValues(funded.tx, broken, funded.inputValues.length - 1), `entry ${i}`)
        .toThrow(new RegExp(`prev tx ${i}: cannot parse`));
    });
  });
});

describe('the prev tx count is checked against the inputs', () => {
  it('admits any list up to the input count and refuses a longer one', () => {
    forEachCase(0xc05d_0040, 150, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 4) });
      const n = funded.tx.inputs.length;
      for (let len = 0; len <= n; len++) {
        expect(
          rejects(() => checkPrevTxCount(funded.tx, funded.prevTxsHex.slice(0, len), 'hop')),
          `length ${len} of ${n}`,
        ).toBe(false);
      }
      const surplus = [...funded.prevTxsHex, funded.prevTxsHex[0]];
      expect(() => checkPrevTxCount(funded.tx, surplus, 'hop')).toThrow(
        new RegExp(`hop: ${n + 1} prev txs supplied for ${n} input`),
      );
      expect(() => checkPrevTxCount(funded.tx, surplus, 'hop')).toThrow(
        /corresponds to no input/,
      );
    });
  });

  it('refuses a prevTxs that is not a list at all', () => {
    const funded = randomFundedTx(() => 0.5, { inputs: 2 });
    for (const value of [undefined, null, 'aa', 7, {}, new Set()]) {
      expect(
        () => checkPrevTxCount(funded.tx, value as unknown as string[], 'hop'),
        `prevTxs = ${String(value)}`,
      ).toThrow(/hop: prevTxs is not a list/);
    }
  });
});

// ---------------------------------------------------------------------------
// 19. FORWARD AND BACKWARD
// ---------------------------------------------------------------------------

describe('the forward walk and the backward walk are inverses', () => {
  it('a sat walked forward through a chain of spends walks back to where it started', () => {
    // Forward is custody's transferSatpoint. Backward is the pair the
    // genealogy verifier steps with, outputSpacePosition then containingInput
    // (satnumber.ts:507-515). They are the same arithmetic read in opposite
    // directions, so a chain walked one way and back must close.
    forEachCase(0xc05d_0060, 40, (r) => {
      const chain: FundedTx[] = [];
      const forward: Satpoint[] = [];

      const first = randomFundedTx(r, { inputs: randInt(r, 1, 3), outputs: randInt(r, 1, 3), fee: 0n });
      const startInput = randInt(r, 0, first.inputValues.length - 1);
      const startOffset = randBigInt(r, 0n, first.inputValues[startInput] - 1n);
      chain.push(first);
      forward.push(transferSatpoint(first.tx, first.inputValues, trackedInput(first, startInput, startOffset)));

      const steps = randInt(r, 1, 4);
      for (let step = 0; step < steps; step++) {
        const previous = chain[chain.length - 1];
        const at = forward[forward.length - 1];
        const next = randomFundedTx(r, {
          inputs: randInt(r, 1, 3),
          outputs: randInt(r, 1, 3),
          fee: 0n,
          spends: {
            hex: previous.hex,
            txid: previous.tx.txid,
            vout: at.vout,
            value: previous.outputValues[at.vout],
          },
        });
        chain.push(next);
        forward.push(transferSatpoint(next.tx, next.inputValues, at));
      }

      // walk back down the chain the way the genealogy verifier does
      let vout = forward[forward.length - 1].vout;
      let offset = forward[forward.length - 1].offset;
      for (let i = chain.length - 1; i >= 0; i--) {
        const tx = chain[i];
        const position = outputSpacePosition(tx.tx, vout, offset);
        const back = containingInput(tx.tx, tx.inputValues, position);
        const expectedTxid = tx.tx.inputs[back.input].prevTxid;
        if (i > 0) {
          // the input it names must be the one that spent the previous hop's
          // tracked output, at the same offset the forward walk left there
          expect(expectedTxid, `step ${i}`).toBe(chain[i - 1].tx.txid);
          expect(tx.tx.inputs[back.input].vout, `step ${i}`).toBe(forward[i - 1].vout);
          expect(back.offsetInFunding, `step ${i}`).toBe(forward[i - 1].offset);
          vout = forward[i - 1].vout;
          offset = forward[i - 1].offset;
        } else {
          // and the bottom of the chain is the input and offset it started at
          expect(back.input, 'start input').toBe(startInput);
          expect(back.offsetInFunding, 'start offset').toBe(startOffset);
        }
      }
      expect(chain.length).toBe(steps + 1);
    });
  });
});

/** kept so the fixture builders stay honest about what they produce */
function assertBuilt(built: BuiltTx): void {
  expect(built.tx.txid).toMatch(/^[0-9a-f]{64}$/);
}

describe('the generated fixtures are what the properties assume', () => {
  it('a funded transaction proves every input value it claims', () => {
    forEachCase(0xc05d_0050, 60, (r) => {
      const funded = randomFundedTx(r, { inputs: randInt(r, 1, 5), outputs: randInt(r, 1, 4) });
      assertBuilt(funded);
      expect(funded.prevTxsHex).toHaveLength(funded.tx.inputs.length);
      expect(provenInputValues(funded.tx, funded.prevTxsHex, funded.tx.inputs.length - 1)).toEqual(
        funded.inputValues,
      );
      expect(totalOf(funded.outputValues) <= totalOf(funded.inputValues), 'outputs exceed inputs').toBe(
        true,
      );
    });
  });
});
