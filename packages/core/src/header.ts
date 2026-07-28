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

/**
 * What a caller's `trustHeader` hook asserted about a header it did not reject.
 *
 * `'hash-at-height'` says the hook checked this block hash against its own view
 * of the chain at this height and they agree, so the header and the height are
 * bound together. Returning nothing (`void`) leaves the hook rejection-only:
 * it rejects by throwing, and a verifier reads nothing positive out of a hook
 * that returned quietly.
 */
export type HeaderAttestation = void | 'hash-at-height';

/** Proof-of-work check: header hash (as 256-bit LE integer) must be <= target from bits. */
export function checkProofOfWork(header: BlockHeader): boolean {
  const target = bitsToTarget(header.bits);
  const hashValue = leBytesToBigInt(header.hashLE);
  return hashValue <= target;
}

/**
 * Proof-of-work floor. `checkProofOfWork` compares a header's hash against the
 * target the header itself declares, so a header that declares an easy target
 * passes it for a few milliseconds of work. A bundle chooses its own headers,
 * so a verifier that checks only the self-declared target proves nothing about
 * the cost of fabricating one.
 *
 * `powLimitBits` is the network's easiest allowed target. `undefined` means
 * mainnet (MAINNET_CHAIN_PARAMS.powLimitBits), a number overrides it for
 * another chain, and `null` disables the floor. The comparison is local and
 * needs no network. A header that fails is fabricated or belongs to another
 * chain, and both are forgery-class.
 */
export function checkPowLimit(
  header: BlockHeader,
  powLimitBits: number | null | undefined,
  label = 'header',
): void {
  const limit = powLimitBits === undefined ? MAINNET_CHAIN_PARAMS.powLimitBits : powLimitBits;
  if (limit === null) return;
  if (bitsToTarget(header.bits) > bitsToTarget(limit)) {
    throw new Error(
      `${label}: target (bits 0x${header.bits.toString(16)}) is easier than the ` +
        `proof-of-work limit 0x${limit.toString(16)}; set powLimitBits for non-mainnet chains`,
    );
  }
}

/**
 * Compress a target into compact "bits": exact port of arith_uint256::GetCompact
 * (round-trips consensus semantics: retarget comparisons happen in compact form,
 * so precision loss here is consensus-correct, not a bug).
 */
export function targetToBits(target: bigint): number {
  if (target < 0n) throw new Error('negative target');
  if (target === 0n) return 0;
  let size = 0;
  for (let t = target; t > 0n; t >>= 8n) size++;
  let compact: number;
  if (size <= 3) {
    compact = Number(target << (8n * BigInt(3 - size)));
  } else {
    compact = Number(target >> (8n * BigInt(size - 3)));
  }
  // if the sign bit would be set, shift the mantissa and bump the exponent
  if ((compact & 0x00800000) !== 0) {
    compact >>= 8;
    size++;
  }
  return (compact | (size << 24)) >>> 0;
}

export interface ChainParams {
  /** blocks per difficulty period (mainnet 2016) */
  retargetInterval: number;
  /** target seconds per period (mainnet 1209600 = 14 days) */
  targetTimespan: number;
  /** compact encoding of the maximum (easiest) allowed target */
  powLimitBits: number;
  /** regtest-style chains skip retargeting entirely */
  noRetarget?: boolean;
}

export const MAINNET_CHAIN_PARAMS: ChainParams = {
  retargetInterval: 2016,
  targetTimespan: 14 * 24 * 3600,
  powLimitBits: 0x1d00ffff,
};

/**
 * Difficulty retarget: exact port of pow.cpp CalculateNextWorkRequired.
 * `firstTime` is the timestamp of the FIRST block of the closing period
 * (height H-interval for a boundary at H), `lastTime` of its LAST block
 * (height H-1). Bitcoin's off-by-one 2015-block window, faithfully kept.
 * Multiplication precedes division (consensus truncation order).
 */
export function calcNextBits(
  prevBits: number,
  firstTime: number,
  lastTime: number,
  params: ChainParams = MAINNET_CHAIN_PARAMS,
): number {
  let actualTimespan = lastTime - firstTime;
  const min = Math.floor(params.targetTimespan / 4);
  const max = params.targetTimespan * 4;
  if (actualTimespan < min) actualTimespan = min;
  if (actualTimespan > max) actualTimespan = max;

  const powLimit = bitsToTarget(params.powLimitBits);
  let target = bitsToTarget(prevBits);
  target *= BigInt(actualTimespan);
  target /= BigInt(params.targetTimespan);
  if (target > powLimit) target = powLimit;
  return targetToBits(target);
}

/** Expected work encoded by `bits`: floor(2^256 / (target + 1)), the chainwork summand. */
export function workFromBits(bits: number): bigint {
  const target = bitsToTarget(bits);
  return (1n << 256n) / (target + 1n);
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
