import { ByteReader, ByteWriter, concatBytes } from './bytes.js';
import { parseHeader, type BlockHeader } from './header.js';
import { parseTx, type ParsedTx } from './tx.js';

export interface ParsedBlock {
  header: BlockHeader;
  txs: ParsedTx[];
}

/**
 * Parse a full serialized block (header + varint tx count + transactions).
 * This is how an L3 verifier obtains the wtxid set when no proof-serving
 * gateway is available: download the raw block from any untrusted source and
 * build the witness tree locally.
 */
export function parseBlock(raw: Uint8Array): ParsedBlock {
  if (raw.length < 81) throw new Error('block too short');
  const header = parseHeader(raw.slice(0, 80));
  const r = new ByteReader(raw, 80);
  const count = r.readVarIntNum();
  const txs: ParsedTx[] = [];
  for (let i = 0; i < count; i++) {
    const tx = parseTx(raw.slice(r.pos), { allowTrailing: true });
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
