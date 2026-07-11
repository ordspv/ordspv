/**
 * Byte / hex utilities. All chain-internal 32-byte hashes in this codebase are
 * passed around in INTERNAL byte order (little-endian, as serialized on the wire).
 * Human-facing hex (txids, block hashes, inscription IDs) is DISPLAY order
 * (byte-reversed). Conversion happens only at the edges via `displayToInternal`
 * / `internalToDisplay` so the orientation of any given value is always explicit.
 */

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex length must be even, got ${hex.length}`);
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex characters');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

/** display-order hex (txid/blockhash as printed) -> internal byte order */
export function displayToInternal(hex: string): Uint8Array {
  return reverseBytes(hexToBytes(hex));
}

/** internal byte order -> display-order hex */
export function internalToDisplay(bytes: Uint8Array): string {
  return bytesToHex(reverseBytes(bytes));
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Interpret internal-order (LE) bytes as a big integer (e.g. hash vs target). */
export function leBytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

export function beBytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/** Sequential reader over a byte buffer with Bitcoin varint support. */
export class ByteReader {
  readonly bytes: Uint8Array;
  pos: number;
  private readonly view: DataView;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new Error(`unexpected end of data: need ${n} bytes at ${this.pos}, have ${this.remaining}`);
    }
  }

  peekU8(offset = 0): number {
    this.need(offset + 1);
    return this.bytes[this.pos + offset];
  }

  readU8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }

  readU16LE(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU32LE(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readI32LE(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readU64LE(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readBytes(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Bitcoin CompactSize varint. */
  readVarInt(): bigint {
    const first = this.readU8();
    if (first < 0xfd) return BigInt(first);
    if (first === 0xfd) return BigInt(this.readU16LE());
    if (first === 0xfe) return BigInt(this.readU32LE());
    return this.readU64LE();
  }

  readVarIntNum(): number {
    const v = this.readVarInt();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('varint too large for number');
    return Number(v);
  }
}

/** Append-only writer producing Bitcoin wire serializations. */
export class ByteWriter {
  private chunks: Uint8Array[] = [];

  writeU8(v: number): this {
    this.chunks.push(new Uint8Array([v & 0xff]));
    return this;
  }

  writeU32LE(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.chunks.push(b);
    return this;
  }

  writeI32LE(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v | 0, true);
    this.chunks.push(b);
    return this;
  }

  writeU64LE(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.chunks.push(b);
    return this;
  }

  writeVarInt(v: number | bigint): this {
    const n = BigInt(v);
    if (n < 0n) throw new Error('varint must be non-negative');
    if (n < 0xfdn) return this.writeU8(Number(n));
    if (n <= 0xffffn) {
      this.writeU8(0xfd);
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, Number(n), true);
      this.chunks.push(b);
      return this;
    }
    if (n <= 0xffffffffn) {
      this.writeU8(0xfe);
      return this.writeU32LE(Number(n));
    }
    this.writeU8(0xff);
    return this.writeU64LE(n);
  }

  writeBytes(b: Uint8Array): this {
    this.chunks.push(b);
    return this;
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}
