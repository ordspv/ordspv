import { describe, expect, it } from 'vitest';
import {
  bitsToTarget,
  bytesToHex,
  checkProofOfWork,
  hexToBytes,
  parseHeader,
  sha256d,
  internalToDisplay,
} from '../src/index.js';

/**
 * Self-verifying consensus sanity checks against universally-known constants.
 * If any byte-order or hashing assumption in the core library is wrong, the
 * genesis block header — whose hash is public knowledge — will not verify.
 */
const GENESIS_HEADER_HEX =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const GENESIS_MERKLE = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';

describe('block header consensus rules', () => {
  it('parses and hashes the genesis header correctly', () => {
    const header = parseHeader(hexToBytes(GENESIS_HEADER_HEX));
    expect(header.hash).toBe(GENESIS_HASH);
    expect(header.merkleRoot).toBe(GENESIS_MERKLE);
    expect(header.time).toBe(1231006505);
    expect(header.bits).toBe(0x1d00ffff);
    expect(header.nonce).toBe(2083236893);
    expect(header.version).toBe(1);
    expect(header.prevBlock).toBe('0'.repeat(64));
  });

  it('validates genesis proof of work', () => {
    const header = parseHeader(hexToBytes(GENESIS_HEADER_HEX));
    expect(checkProofOfWork(header)).toBe(true);
  });

  it('rejects a tampered genesis header PoW', () => {
    const bytes = hexToBytes(GENESIS_HEADER_HEX);
    bytes[79] ^= 0x01; // twiddle the nonce
    const header = parseHeader(bytes);
    expect(checkProofOfWork(header)).toBe(false);
  });

  it('expands compact bits to the max target', () => {
    // difficulty-1 target
    expect(bitsToTarget(0x1d00ffff).toString(16)).toBe(
      'ffff0000000000000000000000000000000000000000000000000000',
    );
  });

  it('sha256d matches known vector', () => {
    // sha256d("") is a standard known value
    expect(bytesToHex(sha256d(new Uint8Array(0)))).toBe(
      '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456',
    );
  });

  it('display/internal round trip', () => {
    const le = hexToBytes('6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000');
    expect(internalToDisplay(le)).toBe('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  });
});
