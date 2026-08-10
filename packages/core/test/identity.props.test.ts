/**
 * Property tests for identity and byte order:
 *   packages/core/src/{inscriptionId,bytes}.ts
 *
 *   8. IDENTITY   inscription-id parsing round-trips, and byte order is
 *                 consistent between the internal and display representations
 *
 * Byte order is the quiet one. Bitcoin hashes are little-endian on the wire and
 * printed reversed, and a single missed reversal produces a value that is the
 * right length, the right character set and completely wrong. The whole
 * codebase's convention is that conversion happens only at the edges, so these
 * tests pin the edges.
 */

import { describe, it, expect } from 'vitest';
import {
  parseInscriptionId,
  formatInscriptionId,
  isInscriptionId,
  inscriptionIdError,
  hasInscriptionIdShape,
  hexToBytes,
  bytesToHex,
  reverseBytes,
  displayToInternal,
  internalToDisplay,
  bytesEqual,
} from '@ordspv/core';
import { rng, randBytes, randInt, rejects } from './gen.js';

const hex64 = (r: () => number) => bytesToHex(randBytes(r, 32));

describe('inscription id: round-trip', () => {
  it('format then parse returns the same txid and index, for random ids', () => {
    const r = rng(0x1d0001);
    for (let i = 0; i < 400; i++) {
      const txid = hex64(r);
      // 0 and small values dominate real data; include the 32-bit ceiling too.
      const index = [0, 1, 2, randInt(r, 0, 1000), randInt(r, 0, 0xffffffff), 0xffffffff][i % 6];
      const id = formatInscriptionId(txid, index);
      const parsed = parseInscriptionId(id);
      expect(parsed.txid, `txid for ${id}`).toBe(txid);
      expect(parsed.index, `index for ${id}`).toBe(index);
      expect(formatInscriptionId(parsed.txid, parsed.index), 'format is the inverse of parse').toBe(id);
      expect(isInscriptionId(id), 'isInscriptionId agrees with parseInscriptionId').toBe(true);
    }
  });

  it('uppercase hex normalises to lowercase and parses identically', () => {
    const r = rng(0x1d0002);
    for (let i = 0; i < 100; i++) {
      const txid = hex64(r);
      const id = `${txid}i${i}`;
      const upper = id.toUpperCase();
      expect(isInscriptionId(upper), 'uppercase must be recognised').toBe(true);
      const parsed = parseInscriptionId(upper);
      expect(parsed.txid, 'normalised to lowercase').toBe(txid);
      expect(parsed.index).toBe(i);
    }
  });

  it('txidLE is exactly the byte-reversal of the display txid', () => {
    const r = rng(0x1d0003);
    for (let i = 0; i < 200; i++) {
      const txid = hex64(r);
      const parsed = parseInscriptionId(`${txid}i0`);
      expect(bytesToHex(reverseBytes(parsed.txidLE)), 'txidLE reversed is the display txid').toBe(txid);
      expect(internalToDisplay(parsed.txidLE), 'internalToDisplay agrees').toBe(txid);
      expect(parsed.txidLE.length).toBe(32);
    }
  });
});

describe('inscription id: rejection', () => {
  it('rejects malformed ids', () => {
    const r = rng(0x1d0004);
    const good = hex64(r);
    const bad: Array<[string, string]> = [
      ['empty', ''],
      ['no separator', good],
      ['no index', `${good}i`],
      ['negative index', `${good}i-1`],
      ['leading zero index', `${good}i01`],
      ['non-numeric index', `${good}ix`],
      ['short txid', `${good.slice(0, 62)}i0`],
      ['long txid', `${good}aai0`],
      ['non-hex txid', `${'z'.repeat(64)}i0`],
      // NOTE: `index above 2^32-1` is deliberately NOT in this list. The two
      // used to disagree about it, and that regression is the subject of its
      // own test below rather than a footnote in this one.
      ['whitespace', ` ${good}i0`],
      ['trailing whitespace', `${good}i0 `],
      ['double separator', `${good}i0i0`],
      ['float index', `${good}i1.0`],
      ['plus-signed index', `${good}i+1`],
    ];
    for (const [label, id] of bad) {
      expect(rejects(() => parseInscriptionId(id)), `${label}: ${JSON.stringify(id)}`).toBe(true);
      expect(isInscriptionId(id), `isInscriptionId must agree for ${label}`).toBe(false);
    }
  });

  it('isInscriptionId agrees with parseInscriptionId on the index range', () => {
    // Regression. The predicate used to apply the grammar alone while the
    // parser also bounded the index at 0xffffffff, so the predicate accepted
    // ids the parser rejected. Both are exported from @ordspv/core and both
    // were used as a pair, predicate first, in the gateway and the sidecar: the
    // predicate was the 400 gate and the parser ran inside a try whose catch
    // answered 502, so an id the predicate waved through was reported as
    // upstream data being unavailable rather than as the malformed id it is.
    // SPEC-GATEWAY.md:50 assigns 400 to a malformed id.
    const overflow = `${'a'.repeat(64)}i4294967296`;      // 2^32, one past the limit
    expect(rejects(() => parseInscriptionId(overflow)), 'the parser rejects it').toBe(true);
    expect(isInscriptionId(overflow), 'the predicate must reject it too').toBe(false);

    // The other arithmetic that reaches the same place: a digit run long enough
    // that Number() saturates, where Number.isSafeInteger(Infinity) is false.
    const saturated = `${'a'.repeat(64)}i${'9'.repeat(40)}`;
    expect(rejects(() => parseInscriptionId(saturated)), 'the parser rejects it').toBe(true);
    expect(isInscriptionId(saturated), 'the predicate must reject it too').toBe(false);
  });

  it('isInscriptionId and parseInscriptionId never disagree, over random ids', () => {
    const r = rng(0x1d0005);
    const candidates: string[] = [];
    for (let i = 0; i < 300; i++) {
      const txid = hex64(r);
      candidates.push(`${txid}i${randInt(r, 0, 5000)}`);
      // Straddling the ceiling is the point of this draw. Sampling only
      // [0, 0xffffffff] made this test vacuous: the disagreement it exists to
      // catch begins one past the top of that range, so the generator never
      // reached the failing region and the targeted test above did all the
      // work. The draw now spans both sides of the boundary.
      candidates.push(`${txid}i${randInt(r, 0xfffffff0, 0x10000000f)}`);
      candidates.push(`${txid}i${randInt(r, 0, 0xffffffff * 64)}`);
      candidates.push(`${txid}i${'9'.repeat(randInt(r, 1, 40))}`);  // up to saturation
      candidates.push(`${txid}I${randInt(r, 0, 10)}`);            // capital separator
      candidates.push(`${txid.toUpperCase()}i${randInt(r, 0, 10)}`);
      candidates.push(`${txid}i0${randInt(r, 1, 9)}`);            // leading zero
      candidates.push(bytesToHex(randBytes(r, randInt(r, 0, 40))));
    }
    // The draw must actually reach both sides, or the test is vacuous again.
    const overRange = candidates.filter(
      (id) => /^[0-9a-f]{64}i[1-9][0-9]*$/.test(id) && Number(id.slice(65)) > 0xffffffff,
    ).length;
    expect(overRange, 'the generator must sample above the ceiling').toBeGreaterThan(0);

    for (const id of candidates) {
      const predicate = isInscriptionId(id);
      const parses = !rejects(() => parseInscriptionId(id));
      expect(parses, `isInscriptionId says ${predicate} for ${JSON.stringify(id)}`).toBe(predicate);
    }
  });

  it('inscriptionIdError names the reason, and is absent exactly when the id is valid', () => {
    const r = rng(0x1d000a);
    const good = hex64(r);
    expect(inscriptionIdError(`${good}i0`)).toBeUndefined();
    expect(inscriptionIdError(`${good}i${0xffffffff}`)).toBeUndefined();
    expect(inscriptionIdError(`${good}i0`.toUpperCase())).toBeUndefined();
    expect(inscriptionIdError(`${good}i4294967296`)).toBe('inscription index out of range: 4294967296');
    expect(inscriptionIdError(`${good}ix`)).toBe(`invalid inscription id: ${good}ix`);
    expect(inscriptionIdError('')).toBe('invalid inscription id: ');
    // The two must be one decision: the predicate is exactly the absence of a
    // reason, on every candidate the round-trip tests already generate.
    for (let i = 0; i < 200; i++) {
      const id = [`${hex64(r)}i${randInt(r, 0, 0xffffffff * 4)}`, `${hex64(r)}i0${i}`,
                  bytesToHex(randBytes(r, randInt(r, 0, 40)))][i % 3];
      expect(inscriptionIdError(id) === undefined, id).toBe(isInscriptionId(id));
    }
  });

  it('hasInscriptionIdShape is the grammar alone, and is never the validity gate', () => {
    // uri.ts uses it to decide which syntax it is looking at. If it tightened
    // to the parser's bound, a bare id with an out-of-range index would be
    // reported as "not an ord URI" instead of naming the range, which is the
    // less useful of the two answers.
    const good = hex64(rng(0x1d000b));
    expect(hasInscriptionIdShape(`${good}i0`)).toBe(true);
    expect(hasInscriptionIdShape(`${good}i4294967296`), 'the shape is there').toBe(true);
    expect(isInscriptionId(`${good}i4294967296`), 'the validity is not').toBe(false);
    expect(hasInscriptionIdShape(`${good}i01`)).toBe(false);
    expect(hasInscriptionIdShape(`${good}ix`)).toBe(false);
    expect(hasInscriptionIdShape('https://example.com/x')).toBe(false);
  });
});

describe('byte order', () => {
  it('displayToInternal and internalToDisplay are mutual inverses', () => {
    const r = rng(0x1d0006);
    for (let i = 0; i < 300; i++) {
      const n = randInt(r, 0, 40);
      const bytes = randBytes(r, n);
      expect(bytesEqual(displayToInternal(internalToDisplay(bytes)), bytes),
             `round trip through display for ${n} bytes`).toBe(true);

      const hex = bytesToHex(randBytes(r, n));
      expect(internalToDisplay(displayToInternal(hex)), `round trip through internal for ${n} bytes`)
        .toBe(hex);
    }
  });

  it('hexToBytes and bytesToHex are mutual inverses, and reject bad hex', () => {
    const r = rng(0x1d0007);
    for (let i = 0; i < 200; i++) {
      const bytes = randBytes(r, randInt(r, 0, 64));
      expect(bytesEqual(hexToBytes(bytesToHex(bytes)), bytes)).toBe(true);
    }
    expect(rejects(() => hexToBytes('abc')), 'odd length').toBe(true);
    expect(rejects(() => hexToBytes('zz')), 'non-hex characters').toBe(true);
    expect(rejects(() => hexToBytes('ab cd')), 'embedded space').toBe(true);
    expect(hexToBytes('').length, 'empty hex is empty bytes').toBe(0);
    // Uppercase hex must decode identically to lowercase.
    const b = randBytes(r, 32);
    expect(bytesEqual(hexToBytes(bytesToHex(b).toUpperCase()), b), 'uppercase hex').toBe(true);
  });

  it('reversing twice is the identity', () => {
    const r = rng(0x1d0008);
    for (let i = 0; i < 200; i++) {
      const bytes = randBytes(r, randInt(r, 0, 64));
      expect(bytesEqual(reverseBytes(reverseBytes(bytes)), bytes)).toBe(true);
    }
  });

  it('a display hex string is never accidentally equal to its internal form', () => {
    // A palindromic 32-byte value would be, which is why this asserts on random
    // values only. The point is that the two representations are genuinely
    // distinct in practice, so a missed conversion cannot pass unnoticed.
    const r = rng(0x1d0009);
    let differed = 0;
    for (let i = 0; i < 200; i++) {
      const bytes = randBytes(r, 32);
      if (bytesToHex(bytes) !== internalToDisplay(bytes)) differed++;
    }
    expect(differed, 'random 32-byte values must differ from their reversal').toBe(200);
  });
});
