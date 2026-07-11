import { ByteReader, internalToDisplay, leBytesToBigInt } from './bytes.js';
import { sha256d } from './hash.js';

export interface BlockHeader {
  version: number;
  /** internal byte order */
  prevBlockLE: Uint8Array;
  prevBlock: string;
  /** internal byte order */
  merkleRootLE: Uint8Array;
  merkleRoot: string;
  time: number;
  bits: number;
  nonce: number;
  /** the 80 raw bytes */
  raw: Uint8Array;
  /** internal byte order */
  hashLE: Uint8Array;
  /** display-order hex */
  hash: string;
}

export function parseHeader(raw: Uint8Array): BlockHeader {
  if (raw.length !== 80) throw new Error(`block header must be 80 bytes, got ${raw.length}`);
  const r = new ByteReader(raw);
  const version = r.readI32LE();
  const prevBlockLE = r.readBytes(32);
  const merkleRootLE = r.readBytes(32);
  const time = r.readU32LE();
  const bits = r.readU32LE();
  const nonce = r.readU32LE();
  const hashLE = sha256d(raw);
  return {
    version,
    prevBlockLE,
    prevBlock: internalToDisplay(prevBlockLE),
    merkleRootLE,
    merkleRoot: internalToDisplay(merkleRootLE),
    time,
    bits,
    nonce,
    raw,
    hashLE,
    hash: internalToDisplay(hashLE),
  };
}

/** Expand compact "bits" into the full 256-bit target. Throws on negative/overflow encodings. */
export function bitsToTarget(bits: number): bigint {
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  if ((bits & 0x00800000) !== 0) throw new Error('negative target');
  let target: bigint;
  if (exponent <= 3) {
    target = mantissa >> (8n * BigInt(3 - exponent));
  } else {
    target = mantissa << (8n * BigInt(exponent - 3));
  }
  if (target >> 256n !== 0n) throw new Error('target overflow');
  return target;
}

/** Proof-of-work check: header hash (as 256-bit LE integer) must be <= target from bits. */
export function checkProofOfWork(header: BlockHeader): boolean {
  const target = bitsToTarget(header.bits);
  const hashValue = leBytesToBigInt(header.hashLE);
  return hashValue <= target;
}

/**
 * Verify a contiguous chain of headers: each header's prevBlock must equal the
 * previous header's hash, and each must satisfy its own embedded PoW target.
 * NOTE: this does NOT validate difficulty retargeting rules against consensus;
 * callers anchor trust via checkpoints / multi-source tip comparison instead.
 */
export function verifyHeaderChain(headers: BlockHeader[]): void {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!checkProofOfWork(h)) throw new Error(`header ${h.hash} fails its own PoW target`);
    if (i > 0 && h.prevBlock !== headers[i - 1].hash) {
      throw new Error(`header chain broken at index ${i}: ${h.prevBlock} != ${headers[i - 1].hash}`);
    }
  }
}
