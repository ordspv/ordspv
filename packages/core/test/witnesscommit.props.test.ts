/**
 * Property tests for the witness commitment: packages/core/src/witnesscommit.ts
 *
 *   5. WITNESS COMMITMENT   content whose bytes are not committed by the
 *                           coinbase witness commitment does not verify,
 *                           since the txid does not commit to witness data
 *
 * This is the property the whole L2/L3 distinction rests on. An inscription's
 * payload lives in a taproot script inside the reveal's WITNESS. A txid is
 * SHA256d over the stripped serialization, which excludes witness data
 * entirely, so a txid-only proof pins which transaction was mined and says
 * nothing about what its witness contained. The tests below construct exactly
 * that: two transactions with identical txids and different witnesses.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTx,
  serializeStripped,
  serializeFull,
  sha256d,
  bytesEqual,
  bytesToHex,
  concatBytes,
  hexToBytes,
  computeWitnessRootFromWtxids,
  computeWitnessCommitment,
  verifyWitnessCommitment,
  findWitnessCommitment,
  witnessReservedValue,
  ZERO32,
} from '@ordspv/core';
import { rng, randBytes, rejects } from './gen.js';

/** A one-in, one-out transaction carrying `witness` on its single input. */
function txWith(witness: Uint8Array[], scriptPubKey: Uint8Array) {
  return parseTx(
    serializeFull({
      version: 2,
      inputs: [
        {
          prevTxidLE: new Uint8Array(32).fill(7),
          prevTxid: '07'.repeat(32),
          vout: 0,
          scriptSig: new Uint8Array(),
          sequence: 0xffffffff,
          witness,
        },
      ],
      outputs: [{ value: 1000n, scriptPubKey }],
      locktime: 0,
    }),
  );
}

/** A coinbase committing to `witnessRoot` with the given reserved value. */
function coinbaseCommitting(witnessRoot: Uint8Array, reserved: Uint8Array) {
  const commitment = computeWitnessCommitment(witnessRoot, reserved);
  return parseTx(
    serializeFull({
      version: 1,
      inputs: [
        {
          prevTxidLE: new Uint8Array(32),
          prevTxid: '0'.repeat(64),
          vout: 0xffffffff,
          scriptSig: new Uint8Array([0x03, 0x01, 0x02, 0x03]),
          sequence: 0xffffffff,
          witness: [reserved],
        },
      ],
      outputs: [
        { value: 312_500_000n, scriptPubKey: new Uint8Array([0x51]) },
        { value: 0n, scriptPubKey: concatBytes(hexToBytes('6a24aa21a9ed'), commitment) },
      ],
      locktime: 0,
    }),
  );
}

describe('witness commitment: the txid does not commit to witness data', () => {
  it('two transactions with different witnesses share one txid', () => {
    const r = rng(0x1a2b3c);
    const spk = randBytes(r, 22);
    const honest = txWith([randBytes(r, 64), randBytes(r, 33)], spk);
    const swapped = txWith([randBytes(r, 64), randBytes(r, 33)], spk);

    expect(honest.txid, 'the stripped serialization is identical, so the txid must be')
      .toBe(swapped.txid);
    expect(honest.wtxid, 'the witness differs, so the wtxid must differ')
      .not.toBe(swapped.wtxid);
    expect(bytesEqual(honest.strippedRaw, swapped.strippedRaw)).toBe(true);
    expect(bytesEqual(honest.raw, swapped.raw)).toBe(false);
  });

  it('only the committed witness verifies against the coinbase commitment', () => {
    const r = rng(0x5150abc);
    const spk = randBytes(r, 22);
    const committed = txWith([randBytes(r, 64), randBytes(r, 33)], spk);
    const substituted = txWith([randBytes(r, 64), randBytes(r, 33)], spk);
    const reserved = randBytes(r, 32);

    // A two-transaction block: coinbase (wtxid zeroed) plus the committed tx.
    const witnessRoot = computeWitnessRootFromWtxids([ZERO32, committed.wtxidLE]);
    const coinbase = coinbaseCommitting(witnessRoot, reserved);

    // The honest witness verifies.
    expect(rejects(() => verifyWitnessCommitment(coinbase, witnessRoot)),
           'the committed witness root must verify').toBe(false);

    // The substituted witness, same txid with different witness bytes, does not.
    const forgedRoot = computeWitnessRootFromWtxids([ZERO32, substituted.wtxidLE]);
    expect(bytesEqual(forgedRoot, witnessRoot),
           'a different witness must produce a different witness root').toBe(false);
    expect(rejects(() => verifyWitnessCommitment(coinbase, forgedRoot)),
           'a witness root the coinbase does not commit to must be rejected').toBe(true);
  });

  it('any mutation of the witness root is rejected', () => {
    const r = rng(0x9f9f0001);
    const tx = txWith([randBytes(r, 64)], randBytes(r, 22));
    const reserved = randBytes(r, 32);
    const witnessRoot = computeWitnessRootFromWtxids([ZERO32, tx.wtxidLE]);
    const coinbase = coinbaseCommitting(witnessRoot, reserved);

    for (let i = 0; i < 32; i++) {
      const tampered = witnessRoot.slice();
      tampered[i] ^= 0xff;
      expect(rejects(() => verifyWitnessCommitment(coinbase, tampered)),
             `flipping byte ${i} of the witness root must be rejected`).toBe(true);
    }
  });
});

describe('witness commitment: coinbase shape', () => {
  it('rejects a coinbase with no commitment output', () => {
    const r = rng(0xabcd0001);
    const bare = parseTx(
      serializeFull({
        version: 1,
        inputs: [
          {
            prevTxidLE: new Uint8Array(32),
            prevTxid: '0'.repeat(64),
            vout: 0xffffffff,
            scriptSig: new Uint8Array([0x03, 0x01, 0x02, 0x03]),
            sequence: 0xffffffff,
            witness: [randBytes(r, 32)],
          },
        ],
        outputs: [{ value: 1n, scriptPubKey: new Uint8Array([0x51]) }],
        locktime: 0,
      }),
    );
    expect(findWitnessCommitment(bare), 'no commitment output present').toBeUndefined();
    expect(rejects(() => verifyWitnessCommitment(bare, randBytes(r, 32))),
           'a coinbase with no commitment must be rejected').toBe(true);
  });

  it('requires the reserved value to be exactly one 32-byte item', () => {
    const r = rng(0xdcba0001);
    const mk = (witness: Uint8Array[]) =>
      parseTx(
        serializeFull({
          version: 1,
          inputs: [
            {
              prevTxidLE: new Uint8Array(32),
              prevTxid: '0'.repeat(64),
              vout: 0xffffffff,
              scriptSig: new Uint8Array([0x03, 0x01, 0x02, 0x03]),
              sequence: 0xffffffff,
              witness,
            },
          ],
          outputs: [{ value: 1n, scriptPubKey: new Uint8Array([0x51]) }],
          locktime: 0,
        }),
      );

    expect(rejects(() => witnessReservedValue(mk([randBytes(r, 31)]))), '31 bytes').toBe(true);
    expect(rejects(() => witnessReservedValue(mk([randBytes(r, 33)]))), '33 bytes').toBe(true);
    expect(rejects(() => witnessReservedValue(mk([randBytes(r, 32), randBytes(r, 32)]))), 'two items').toBe(true);
    expect(rejects(() => witnessReservedValue(mk([randBytes(r, 32)]))), 'exactly one 32-byte item').toBe(false);
  });

  it('non-coinbase transactions are refused outright', () => {
    const r = rng(0x1234abcd);
    const ordinary = txWith([randBytes(r, 64)], randBytes(r, 22));
    expect(rejects(() => findWitnessCommitment(ordinary)),
           'findWitnessCommitment on a non-coinbase').toBe(true);
  });

  it('takes the highest-index commitment output, per BIP-141', () => {
    const r = rng(0xfeed0001);
    const reserved = randBytes(r, 32);
    const rootA = randBytes(r, 32);
    const rootB = randBytes(r, 32);
    const commitA = computeWitnessCommitment(rootA, reserved);
    const commitB = computeWitnessCommitment(rootB, reserved);

    const cb = parseTx(
      serializeFull({
        version: 1,
        inputs: [
          {
            prevTxidLE: new Uint8Array(32),
            prevTxid: '0'.repeat(64),
            vout: 0xffffffff,
            scriptSig: new Uint8Array([0x03, 0x01, 0x02, 0x03]),
            sequence: 0xffffffff,
            witness: [reserved],
          },
        ],
        outputs: [
          { value: 0n, scriptPubKey: concatBytes(hexToBytes('6a24aa21a9ed'), commitA) },
          { value: 0n, scriptPubKey: concatBytes(hexToBytes('6a24aa21a9ed'), commitB) },
        ],
        locktime: 0,
      }),
    );

    expect(bytesToHex(findWitnessCommitment(cb)!), 'the later output wins')
      .toBe(bytesToHex(commitB));
    expect(rejects(() => verifyWitnessCommitment(cb, rootB)), 'root B verifies').toBe(false);
    expect(rejects(() => verifyWitnessCommitment(cb, rootA)), 'root A must not').toBe(true);
  });
});

describe('witness commitment: the witness merkle tree', () => {
  it('zeroes the coinbase wtxid, per BIP-141', () => {
    const r = rng(0x0b0b0001);
    const a = randBytes(r, 32);
    const b = randBytes(r, 32);
    // Whatever the caller passes at index 0 is replaced by 32 zero bytes, so
    // two lists differing only there must give the same root.
    expect(
      bytesEqual(computeWitnessRootFromWtxids([a, b]), computeWitnessRootFromWtxids([ZERO32, b])),
      'index 0 must be substituted with zeros',
    ).toBe(true);
  });

  it('rejects an empty wtxid list', () => {
    expect(rejects(() => computeWitnessRootFromWtxids([])), 'empty list').toBe(true);
  });
});
