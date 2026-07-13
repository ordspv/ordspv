import { ByteReader, ByteWriter, internalToDisplay } from './bytes.js';
import { sha256d } from './hash.js';

export interface TxInput {
  /** internal byte order (as on the wire) */
  prevTxidLE: Uint8Array;
  /** display-order hex of the previous txid */
  prevTxid: string;
  vout: number;
  scriptSig: Uint8Array;
  sequence: number;
  /** witness stack items; empty array when no witness for this input */
  witness: Uint8Array[];
}

export interface TxOutput {
  value: bigint;
  scriptPubKey: Uint8Array;
}

export interface ParsedTx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime: number;
  /** true if the serialization carried the segwit marker+flag */
  hasWitness: boolean;
  /** the exact bytes this tx was parsed from */
  raw: Uint8Array;
  /** consensus serialization without witness data (recomputed) */
  strippedRaw: Uint8Array;
  /** internal byte order */
  txidLE: Uint8Array;
  /** display-order hex */
  txid: string;
  /** internal byte order; equals txidLE for non-segwit txs */
  wtxidLE: Uint8Array;
  /** display-order hex */
  wtxid: string;
  /** total serialized size in bytes */
  size: number;
}

/**
 * Parse a raw Bitcoin transaction (segwit-aware, BIP-144 serialization).
 * Throws on malformed or trailing data (strict = exact fit by default).
 * `offset` starts the parse mid-buffer without copying the tail (block parsing).
 */
export function parseTx(
  raw: Uint8Array,
  opts: { allowTrailing?: boolean; offset?: number } = {},
): ParsedTx {
  const r = new ByteReader(raw, opts.offset ?? 0);
  const start = r.pos;
  const version = r.readI32LE();

  let hasWitness = false;
  // BIP-144: marker 0x00 + flag 0x01 signals witness serialization.
  if (r.peekU8(0) === 0x00) {
    const flag = r.peekU8(1);
    if (flag !== 0x01) throw new Error(`invalid segwit flag 0x${flag.toString(16)}`);
    r.pos += 2;
    hasWitness = true;
  }

  const vinCount = r.readVarIntNum();
  if (vinCount === 0) throw new Error('transaction has zero inputs');
  const inputs: TxInput[] = [];
  for (let i = 0; i < vinCount; i++) {
    const prevTxidLE = r.readBytes(32);
    const vout = r.readU32LE();
    const scriptLen = r.readVarIntNum();
    const scriptSig = r.readBytes(scriptLen);
    const sequence = r.readU32LE();
    inputs.push({
      prevTxidLE,
      prevTxid: internalToDisplay(prevTxidLE),
      vout,
      scriptSig,
      sequence,
      witness: [],
    });
  }

  const voutCount = r.readVarIntNum();
  const outputs: TxOutput[] = [];
  for (let i = 0; i < voutCount; i++) {
    const value = r.readU64LE();
    const scriptLen = r.readVarIntNum();
    const scriptPubKey = r.readBytes(scriptLen);
    outputs.push({ value, scriptPubKey });
  }

  if (hasWitness) {
    let anyWitness = false;
    for (let i = 0; i < vinCount; i++) {
      const itemCount = r.readVarIntNum();
      const items: Uint8Array[] = [];
      for (let j = 0; j < itemCount; j++) {
        const len = r.readVarIntNum();
        items.push(r.readBytes(len));
      }
      if (itemCount > 0) anyWitness = true;
      inputs[i].witness = items;
    }
    // BIP-144: witness serialization with all-empty witnesses is invalid.
    if (!anyWitness) throw new Error('segwit marker present but all witness stacks empty');
  }

  const locktime = r.readU32LE();
  const end = r.pos;
  if (!opts.allowTrailing && r.remaining !== 0) {
    throw new Error(`trailing bytes after transaction: ${r.remaining}`);
  }

  const exactRaw = raw.slice(start, end);
  const strippedRaw = serializeStripped({ version, inputs, outputs, locktime });
  const txidLE = sha256d(strippedRaw);
  const wtxidLE = hasWitness ? sha256d(exactRaw) : txidLE;

  return {
    version,
    inputs,
    outputs,
    locktime,
    hasWitness,
    raw: exactRaw,
    strippedRaw,
    txidLE,
    txid: internalToDisplay(txidLE),
    wtxidLE,
    wtxid: internalToDisplay(wtxidLE),
    size: exactRaw.length,
  };
}

/** Serialize a transaction without witness data (pre-segwit format, defines txid). */
export function serializeStripped(tx: {
  version: number;
  inputs: Pick<TxInput, 'prevTxidLE' | 'vout' | 'scriptSig' | 'sequence'>[];
  outputs: TxOutput[];
  locktime: number;
}): Uint8Array {
  const w = new ByteWriter();
  w.writeI32LE(tx.version);
  w.writeVarInt(tx.inputs.length);
  for (const input of tx.inputs) {
    w.writeBytes(input.prevTxidLE);
    w.writeU32LE(input.vout);
    w.writeVarInt(input.scriptSig.length);
    w.writeBytes(input.scriptSig);
    w.writeU32LE(input.sequence);
  }
  w.writeVarInt(tx.outputs.length);
  for (const output of tx.outputs) {
    w.writeU64LE(output.value);
    w.writeVarInt(output.scriptPubKey.length);
    w.writeBytes(output.scriptPubKey);
  }
  w.writeU32LE(tx.locktime);
  return w.toBytes();
}

/** Serialize with witness data (BIP-144). Round-trips parseTx for segwit txs. */
export function serializeFull(tx: {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime: number;
}): Uint8Array {
  const hasWitness = tx.inputs.some((i) => i.witness.length > 0);
  if (!hasWitness) return serializeStripped(tx);
  const w = new ByteWriter();
  w.writeI32LE(tx.version);
  w.writeU8(0x00);
  w.writeU8(0x01);
  w.writeVarInt(tx.inputs.length);
  for (const input of tx.inputs) {
    w.writeBytes(input.prevTxidLE);
    w.writeU32LE(input.vout);
    w.writeVarInt(input.scriptSig.length);
    w.writeBytes(input.scriptSig);
    w.writeU32LE(input.sequence);
  }
  w.writeVarInt(tx.outputs.length);
  for (const output of tx.outputs) {
    w.writeU64LE(output.value);
    w.writeVarInt(output.scriptPubKey.length);
    w.writeBytes(output.scriptPubKey);
  }
  for (const input of tx.inputs) {
    w.writeVarInt(input.witness.length);
    for (const item of input.witness) {
      w.writeVarInt(item.length);
      w.writeBytes(item);
    }
  }
  w.writeU32LE(tx.locktime);
  return w.toBytes();
}

/** True if this looks like a coinbase tx (single input spending the null outpoint). */
export function isCoinbase(tx: ParsedTx): boolean {
  if (tx.inputs.length !== 1) return false;
  const input = tx.inputs[0];
  return input.vout === 0xffffffff && input.prevTxidLE.every((b) => b === 0);
}
