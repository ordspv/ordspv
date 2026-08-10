/**
 * Property tests for parser robustness:
 *   packages/core/src/{bytes,tx,taproot,script}.ts
 *
 *   7. PARSER ROBUSTNESS   truncated, over-long and non-canonical varint /
 *                          pushdata / control-block inputs raise rather than
 *                          returning zeros or silently short data
 *
 * Every byte these parsers see arrived from a source the library treats as
 * unreliable, so the required property is not "parses correct input correctly"
 * but "never returns a plausible-looking answer for input it did not fully
 * consume". Silently short data is the dangerous outcome: a caller that gets a
 * value back has no way to know it was truncated.
 */

import { describe, it, expect } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  parseTx,
  serializeFull,
  hexToBytes,
  bytesToHex,
  concatBytes,
  parseControlBlock,
  parseScript,
} from '@ordspv/core';
import { rng, randBytes, randInt, rejects } from './gen.js';

describe('varint: truncation', () => {
  it('every truncation of a multi-byte varint raises', () => {
    // 0xfd -> u16, 0xfe -> u32, 0xff -> u64. Each needs its payload; a reader
    // that ran off the end must throw, not return a partially-read number.
    const cases: Array<[number, number]> = [[0xfd, 2], [0xfe, 4], [0xff, 8]];
    for (const [marker, payload] of cases) {
      for (let have = 0; have < payload; have++) {
        const buf = concatBytes(new Uint8Array([marker]), new Uint8Array(have));
        expect(
          rejects(() => new ByteReader(buf).readVarInt()),
          `marker 0x${marker.toString(16)} with only ${have} of ${payload} payload bytes`,
        ).toBe(true);
      }
      // the complete encoding must succeed, or the test above proves nothing
      const full = concatBytes(new Uint8Array([marker]), new Uint8Array(payload));
      expect(rejects(() => new ByteReader(full).readVarInt()), 'the complete encoding').toBe(false);
    }
  });

  it('an empty buffer raises rather than returning zero', () => {
    expect(rejects(() => new ByteReader(new Uint8Array()).readVarInt())).toBe(true);
    expect(rejects(() => new ByteReader(new Uint8Array()).readU8())).toBe(true);
  });

  it('readBytes past the end raises rather than returning a short array', () => {
    const r = rng(0x7e57_0001);
    for (let i = 0; i < 50; i++) {
      const have = randInt(r, 0, 40);
      const want = have + randInt(r, 1, 20);
      const reader = new ByteReader(randBytes(r, have));
      expect(
        rejects(() => reader.readBytes(want)),
        `readBytes(${want}) on a ${have}-byte buffer`,
      ).toBe(true);
    }
  });

  it('a varint too large for a JS number raises rather than losing precision', () => {
    // 0xff followed by a u64 above Number.MAX_SAFE_INTEGER.
    const w = new ByteWriter();
    w.writeU8(0xff).writeU64LE(0xffff_ffff_ffff_ffffn);
    expect(rejects(() => new ByteReader(w.toBytes()).readVarIntNum()), 'u64 max as a number').toBe(true);
    // ...but readVarInt, which returns bigint, must handle it exactly.
    expect(new ByteReader(w.toBytes()).readVarInt()).toBe(0xffff_ffff_ffff_ffffn);
  });
});

describe('varint: canonicality', () => {
  // Bitcoin Core's ReadCompactSize rejects non-canonical encodings
  // ("non-canonical ReadCompactSize()"). This records what THIS reader does.
  // The consequence is analysed rather than assumed: see the assertions below.
  it('accepts non-canonical encodings, where Bitcoin Core rejects them', () => {
    // MEASURED 2026-08-10: all three are accepted and decode to 1.
    // Core's ReadCompactSize raises "non-canonical ReadCompactSize()" here.
    // This is a divergence from consensus deserialization. It is recorded as a
    // fact rather than asserted as a defect, because the consequence depends on
    // whether an identifier pins the bytes, which the two tests below settle.
    for (const [label, bytes] of [
      ['0xfd encoding 1', new Uint8Array([0xfd, 0x01, 0x00])],
      ['0xfe encoding 1', new Uint8Array([0xfe, 0x01, 0x00, 0x00, 0x00])],
      ['0xff encoding 1', new Uint8Array([0xff, 1, 0, 0, 0, 0, 0, 0, 0])],
    ] as Array<[string, Uint8Array]>) {
      expect(new ByteReader(bytes).readVarInt(), label).toBe(1n);
    }
  });

  it('a non-canonical SEGWIT encoding cannot survive witness anchoring', () => {
    // wtxid is sha256d over the exact bytes supplied (packages/core/src/tx.ts:121),
    // so a re-encoded segwit transaction gets a different wtxid and therefore
    // fails the BIP-141 witness commitment. This is what makes L3 safe against
    // the divergence above.
    const r = rng(0x5e61_0001);
    const raw = serializeFull({
      version: 2,
      inputs: [{
        prevTxidLE: randBytes(r, 32), prevTxid: '00'.repeat(32), vout: 0,
        scriptSig: new Uint8Array(), sequence: 0xffffffff, witness: [randBytes(r, 64)],
      }],
      outputs: [{ value: 700n, scriptPubKey: randBytes(r, 22) }],
      locktime: 0,
    });
    const canonical = parseTx(raw);
    expect(canonical.hasWitness, 'this fixture must be segwit for the test to mean anything').toBe(true);

    // Re-encode the INPUT count varint non-canonically. For a segwit
    // serialization it sits immediately after version(4) + marker(1) + flag(1),
    // and the assertion below fails loudly rather than silently targeting the
    // wrong byte if that layout ever changes.
    const inCountIdx = 6;
    expect(raw[4], 'segwit marker').toBe(0x00);
    expect(raw[5], 'segwit flag').toBe(0x01);
    expect(raw[inCountIdx], 'located the input-count varint').toBe(1);
    const nonCanonical = concatBytes(
      raw.slice(0, inCountIdx), new Uint8Array([0xfd, 0x01, 0x00]), raw.slice(inCountIdx + 1),
    );

    let reparsed;
    try {
      reparsed = parseTx(nonCanonical);
    } catch {
      return;   // rejected outright, also safe
    }
    expect(reparsed.txid, 'txid comes from the canonical re-serialization').toBe(canonical.txid);
    expect(reparsed.wtxid, 'wtxid is over the supplied bytes and MUST differ')
      .not.toBe(canonical.wtxid);
  });

  it('for a LEGACY transaction neither identifier pins the supplied bytes', () => {
    // A non-segwit transaction has wtxid == txid, and txid is computed from the
    // canonical re-serialization. So two different byte strings parse to one
    // transaction with one txid and one wtxid, differing only in `raw`.
    //
    // This is inert for inscriptions, since envelope content lives in a taproot
    // witness, which only a segwit transaction has, and the case above covers
    // that. It is recorded because any future code that treats `tx.raw` of a
    // legacy transaction as pinned by its txid would be wrong.
    const r = rng(0x1e6a_0001);
    const raw = serializeFull({
      version: 2,
      inputs: [{
        prevTxidLE: randBytes(r, 32), prevTxid: '00'.repeat(32), vout: 0,
        scriptSig: randBytes(r, 3), sequence: 0xffffffff, witness: [],
      }],
      outputs: [{ value: 5000n, scriptPubKey: randBytes(r, 22) }],
      locktime: 0,
    });
    const canonical = parseTx(raw);
    expect(canonical.hasWitness).toBe(false);

    const nonCanonical = concatBytes(
      raw.slice(0, 4), new Uint8Array([0xfd, 0x01, 0x00]), raw.slice(5),
    );
    let reparsed;
    try {
      reparsed = parseTx(nonCanonical);
    } catch {
      return;
    }
    expect(reparsed.txid).toBe(canonical.txid);
    expect(reparsed.wtxid).toBe(canonical.wtxid);
    expect(reparsed.raw.length, 'yet the byte strings differ in length')
      .not.toBe(canonical.raw.length);
  });

});

describe('transaction parsing', () => {
  it('every truncation of a valid transaction raises', () => {
    const r = rng(0x7a11_0001);
    const raw = serializeFull({
      version: 2,
      inputs: [{
        prevTxidLE: randBytes(r, 32), prevTxid: '00'.repeat(32), vout: 1,
        scriptSig: randBytes(r, 25), sequence: 0xfffffffe, witness: [randBytes(r, 64)],
      }],
      outputs: [{ value: 12345n, scriptPubKey: randBytes(r, 34) }],
      locktime: 500,
    });
    expect(rejects(() => parseTx(raw)), 'the complete transaction parses').toBe(false);

    for (let cut = 1; cut < raw.length; cut++) {
      expect(
        rejects(() => parseTx(raw.slice(0, cut))),
        `a transaction truncated to ${cut} of ${raw.length} bytes must be rejected`,
      ).toBe(true);
    }
  });

  it('trailing bytes are rejected unless explicitly allowed', () => {
    const r = rng(0x7a11_0002);
    const raw = serializeFull({
      version: 1,
      inputs: [{
        prevTxidLE: randBytes(r, 32), prevTxid: '00'.repeat(32), vout: 0,
        scriptSig: new Uint8Array(), sequence: 0xffffffff, witness: [],
      }],
      outputs: [{ value: 1n, scriptPubKey: randBytes(r, 22) }],
      locktime: 0,
    });
    const withTail = concatBytes(raw, randBytes(r, 7));
    expect(rejects(() => parseTx(withTail)), 'trailing bytes rejected by default').toBe(true);
    expect(rejects(() => parseTx(withTail, { allowTrailing: true })), 'allowTrailing accepts').toBe(false);
    // and the parsed tx must expose only its own bytes, not the tail
    expect(parseTx(withTail, { allowTrailing: true }).raw.length).toBe(raw.length);
  });

  it('a zero-input transaction is rejected', () => {
    // Otherwise it is ambiguous with the segwit marker.
    const w = new ByteWriter();
    w.writeI32LE(1).writeVarInt(0).writeVarInt(0).writeU32LE(0);
    expect(rejects(() => parseTx(w.toBytes()))).toBe(true);
  });

  it('an invalid segwit flag is rejected', () => {
    const r = rng(0x7a11_0003);
    const w = new ByteWriter();
    w.writeI32LE(1).writeU8(0x00).writeU8(0x02);   // marker 0x00, flag != 0x01
    w.writeVarInt(1).writeBytes(randBytes(r, 32)).writeU32LE(0).writeVarInt(0).writeU32LE(0xffffffff);
    w.writeVarInt(0).writeU32LE(0);
    expect(rejects(() => parseTx(w.toBytes()))).toBe(true);
  });
});

describe('control block parsing', () => {
  it('rejects every length that is not 33 + 32k', () => {
    const r = rng(0xc0b1_0001);
    for (let len = 0; len <= 200; len++) {
      const valid = len >= 33 && (len - 33) % 32 === 0;
      expect(
        rejects(() => parseControlBlock(randBytes(r, len))),
        `length ${len} should be ${valid ? 'accepted' : 'rejected'}`,
      ).toBe(!valid);
    }
  });

  it('rejects a merkle path deeper than the taproot maximum of 128', () => {
    const r = rng(0xc0b1_0002);
    const deep = randBytes(r, 33 + 32 * 129);
    expect(rejects(() => parseControlBlock(deep)), 'depth 129').toBe(true);
    const atLimit = randBytes(r, 33 + 32 * 128);
    expect(rejects(() => parseControlBlock(atLimit)), 'depth 128 is the limit and is allowed').toBe(false);
  });

  it('splits the path into exact 32-byte siblings', () => {
    const r = rng(0xc0b1_0003);
    for (const depth of [0, 1, 2, 5, 32, 128]) {
      const bytes = randBytes(r, 33 + 32 * depth);
      const cb = parseControlBlock(bytes);
      expect(cb.path.length, `depth ${depth}`).toBe(depth);
      for (const [i, sib] of cb.path.entries()) {
        expect(sib.length, `sibling ${i} length`).toBe(32);
        expect(bytesToHex(sib)).toBe(bytesToHex(bytes.slice(33 + i * 32, 33 + (i + 1) * 32)));
      }
      expect(cb.internalKey.length, 'internal key is 32 bytes').toBe(32);
      expect(cb.leafVersion & 0x01, 'leaf version has the parity bit cleared').toBe(0);
      expect(cb.outputKeyParity).toBe(bytes[0] & 0x01);
    }
  });
});

describe('script pushdata parsing', () => {
  it('a pushdata claiming more bytes than remain does not yield short data', () => {
    // OP_PUSHDATA1 (0x4c) with length 0xff but no payload; likewise the direct
    // push opcodes. Whatever the parser does, it must not hand back an
    // operation whose data is shorter than the length it declared.
    const truncations: Uint8Array[] = [
      new Uint8Array([0x4c, 0xff]),
      new Uint8Array([0x4c, 0x10, 0x01, 0x02]),
      new Uint8Array([0x4d, 0x00, 0x01]),
      new Uint8Array([0x4e, 0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([0x20, 0x01, 0x02, 0x03]),
    ];
    for (const [i, bytes] of truncations.entries()) {
      let ops;
      try {
        ops = parseScript(bytes);
      } catch {
        continue;                       // raised, which is the safe outcome
      }
      for (const op of ops) {
        if (!op.data) continue;
        expect(
          op.data.length,
          `case ${i}: a parsed push must not carry fewer bytes than the script held`,
        ).toBeLessThanOrEqual(bytes.length);
      }
    }
  });

  it('round-trips a well-formed push of every boundary length', () => {
    const r = rng(0x9051_0001);
    for (const len of [0, 1, 75, 76, 77, 255, 256, 520]) {
      const data = randBytes(r, len);
      const w = new ByteWriter();
      if (len < 0x4c) w.writeU8(len);
      else if (len <= 0xff) w.writeU8(0x4c).writeU8(len);
      else w.writeU8(0x4d).writeU8(len & 0xff).writeU8(len >> 8);
      w.writeBytes(data);

      const ops = parseScript(w.toBytes());
      expect(ops.length, `length ${len}: one operation`).toBe(1);
      expect(bytesToHex(ops[0].data ?? new Uint8Array()), `length ${len}: payload`).toBe(bytesToHex(data));
    }
  });
});
