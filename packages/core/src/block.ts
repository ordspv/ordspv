import { ByteReader, ByteWriter, concatBytes } from './bytes.js';
import { parseHeader, type BlockHeader } from './header.js';
import { parseTx, type ParsedTx } from './tx.js';

export interface ParsedBlock {
  header: BlockHeader;
  txs: ParsedTx[];
}

/** Consensus bound: 4M weight units cap the serialized block at 4,000,000 bytes. */
export const MAX_BLOCK_BYTES = 4_000_000;

/**
 * Smallest transaction parseTx accepts: version(4) + vin count(1, min 1) +
 * one input (36 outpoint + 1 script len + 4 sequence) + vout count(1) +
 * locktime(4). Used to bound a claimed tx count before parsing.
 */
const MIN_TX_BYTES = 51;

/**
 * Parse a full serialized block (header + varint tx count + transactions).
 * This is how an L3 verifier obtains the wtxid set when no proof-serving
 * gateway is available: download the raw block from any untrusted source and
 * build the witness tree locally. The input is untrusted: size and claimed
 * tx count are bounded up front, and each tx is parsed in place from a single
 * advancing offset (no per-tx tail copy), so parsing stays linear.
 */
export function parseBlock(raw: Uint8Array): ParsedBlock {
  if (raw.length < 81) throw new Error('block too short');
  if (raw.length > MAX_BLOCK_BYTES) {
    throw new Error(`block size ${raw.length} exceeds consensus maximum ${MAX_BLOCK_BYTES}`);
  }
  const header = parseHeader(raw.slice(0, 80));
  const r = new ByteReader(raw, 80);
  const count = r.readVarIntNum();
  if (count * MIN_TX_BYTES > r.remaining) {
    throw new Error(`block claims ${count} txs but only ${r.remaining} bytes remain`);
  }
  const txs: ParsedTx[] = [];
  for (let i = 0; i < count; i++) {
    const tx = parseTx(raw, { allowTrailing: true, offset: r.pos });
    txs.push(tx);
    r.pos += tx.size;
  }
  if (r.remaining !== 0) throw new Error(`block has ${r.remaining} trailing bytes`);
  return { header, txs };
}

/** Serialize a block from its parts (test/tooling use). */
export function serializeBlock(headerRaw: Uint8Array, txs: { raw: Uint8Array }[]): Uint8Array {
  const w = new ByteWriter();
  w.writeBytes(headerRaw);
  w.writeVarInt(txs.length);
  return concatBytes(w.toBytes(), ...txs.map((t) => t.raw));
}
