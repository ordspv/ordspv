import { describe, expect, it } from 'vitest';
import {
  bitsToTarget,
  bytesToHex,
  checkProofOfWork,
  hexToBytes,
  parseBlock,
  parseHeader,
  serializeBlock,
  sha256d,
  internalToDisplay,
  ByteWriter,
  MAX_BLOCK_BYTES,
} from '../src/index.js';
import { dummyTx } from './helpers.js';

/**
 * Self-verifying consensus sanity checks against universally-known constants.
 * If any byte-order or hashing assumption in the core library is wrong, the
 * genesis block header, whose hash is public knowledge, will not verify.
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

describe('parseBlock bounds and linearity', () => {
  const HEADER = hexToBytes(GENESIS_HEADER_HEX);

  it('parses a many-tx block in linear time (single advancing offset)', { timeout: 120_000 }, () => {
    // enough small txs that the old per-tx tail copy would be visibly
    // quadratic. An absolute wall-clock bound flaked under full-suite load,
    // so the bound is relative: a small block and a large one are timed in
    // the same test, machine load cancels out of the ratio, and only
    // superlinear growth can breach it
    const small = Array.from({ length: 500 }, () => dummyTx());
    const large = Array.from({ length: 4000 }, () => dummyTx());
    const smallRaw = serializeBlock(HEADER, small);
    const largeRaw = serializeBlock(HEADER, large);
    parseBlock(smallRaw); // warm-up, so JIT compilation is not in the ratio
    const time = (raw: Uint8Array, expectTxs: number): number => {
      const started = performance.now();
      const block = parseBlock(raw);
      const elapsed = performance.now() - started;
      expect(block.txs.length).toBe(expectTxs);
      return elapsed;
    };
    // each round times the two sizes back to back, so a load spike or a GC
    // pause lands on both sides of that round's ratio; the median over
    // rounds discards the rounds it hit only one side of
    const ratios: number[] = [];
    for (let round = 0; round < 5; round++) {
      const smallTime = time(smallRaw, 500);
      const largeTime = time(largeRaw, 4000);
      ratios.push(largeTime / Math.max(smallTime, 0.05));
    }
    ratios.sort((a, b) => a - b);
    const block = parseBlock(largeRaw);
    expect(block.txs[0].txid).toBe(large[0].txid);
    expect(block.txs[3999].txid).toBe(large[3999].txid);
    // 8x the txs: a linear parse costs ~8x, the old per-tx tail copy ~64x.
    // The bound sits far above the one and far below the other
    expect(ratios[2]).toBeLessThan(32);
  });

  it('rejects a block larger than the consensus maximum before parsing', () => {
    const oversized = new Uint8Array(MAX_BLOCK_BYTES + 1);
    oversized.set(HEADER, 0);
    expect(() => parseBlock(oversized)).toThrow(/exceeds consensus maximum/);
  });

  it('rejects a claimed tx count that cannot fit in the remaining bytes', () => {
    const w = new ByteWriter();
    w.writeBytes(HEADER);
    w.writeVarInt(0xffffff); // ~16.7M claimed txs in an almost-empty block
    const raw = w.toBytes();
    expect(() => parseBlock(raw)).toThrow(/claims 16777215 txs/);
  });

  it('still rejects trailing bytes and truncated blocks', () => {
    const txs = [dummyTx()];
    const good = serializeBlock(HEADER, txs);
    const trailing = new Uint8Array(good.length + 3);
    trailing.set(good, 0);
    expect(() => parseBlock(trailing)).toThrow(/trailing/);
    expect(() => parseBlock(good.slice(0, good.length - 2))).toThrow();
    expect(parseBlock(good).txs.length).toBe(1);
  });
});
