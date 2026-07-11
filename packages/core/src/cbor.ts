/**
 * Minimal CBOR decoder (RFC 8949 subset) for inscription metadata (tag 5) and
 * properties (tag 17). Supports definite and indefinite lengths, all major
 * types, half/single/double floats, and nested structures. Not a general
 * CBOR library: tags are unwrapped to their inner value, map keys are
 * stringified (text keys as-is, other keys via JSON/hex), and 64-bit ints
 * outside the safe range come back as bigint.
 */

export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue };

class CborReader {
  constructor(
    private bytes: Uint8Array,
    public pos = 0,
  ) {}

  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error('cbor: unexpected end');
    return this.bytes[this.pos++];
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error('cbor: unexpected end');
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  uint(info: number): bigint {
    if (info < 24) return BigInt(info);
    if (info === 24) return BigInt(this.u8());
    if (info === 25) {
      const b = this.take(2);
      return BigInt((b[0] << 8) | b[1]);
    }
    if (info === 26) {
      const b = this.take(4);
      return (BigInt(b[0]) << 24n) | (BigInt(b[1]) << 16n) | (BigInt(b[2]) << 8n) | BigInt(b[3]);
    }
    if (info === 27) {
      const b = this.take(8);
      let v = 0n;
      for (const byte of b) v = (v << 8n) | BigInt(byte);
      return v;
    }
    throw new Error(`cbor: invalid additional info ${info}`);
  }
}

function toNumberIfSafe(v: bigint): number | bigint {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function decodeHalf(b: Uint8Array): number {
  const half = (b[0] << 8) | b[1];
  const sign = half & 0x8000 ? -1 : 1;
  const exp = (half >> 10) & 0x1f;
  const mant = half & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (mant + 1024) * 2 ** (exp - 25);
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

function keyToString(key: CborValue): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'number' || typeof key === 'bigint' || typeof key === 'boolean') return String(key);
  if (key instanceof Uint8Array) return `0x${[...key].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return JSON.stringify(key);
}

function decodeItem(r: CborReader, depth: number): CborValue {
  if (depth > 128) throw new Error('cbor: nesting too deep');
  const initial = r.u8();
  const major = initial >> 5;
  const info = initial & 0x1f;

  switch (major) {
    case 0:
      return toNumberIfSafe(r.uint(info));
    case 1:
      return toNumberIfSafe(-1n - r.uint(info));
    case 2:
    case 3: {
      if (info === 31) {
        // indefinite: concatenate definite chunks until break
        const chunks: Uint8Array[] = [];
        for (;;) {
          const next = r.u8();
          if (next === 0xff) break;
          const m = next >> 5;
          if (m !== major) throw new Error('cbor: mixed chunk types in indefinite string');
          const len = Number(r.uint(next & 0x1f));
          chunks.push(r.take(len));
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        return major === 2 ? merged : utf8.decode(merged);
      }
      const len = Number(r.uint(info));
      const data = r.take(len);
      return major === 2 ? data : utf8.decode(data);
    }
    case 4: {
      const out: CborValue[] = [];
      if (info === 31) {
        for (;;) {
          if (peekBreak(r)) break;
          out.push(decodeItem(r, depth + 1));
        }
        return out;
      }
      const len = Number(r.uint(info));
      for (let i = 0; i < len; i++) out.push(decodeItem(r, depth + 1));
      return out;
    }
    case 5: {
      const out: { [key: string]: CborValue } = {};
      const put = () => {
        const key = keyToString(decodeItem(r, depth + 1));
        out[key] = decodeItem(r, depth + 1);
      };
      if (info === 31) {
        for (;;) {
          if (peekBreak(r)) break;
          put();
        }
        return out;
      }
      const len = Number(r.uint(info));
      for (let i = 0; i < len; i++) put();
      return out;
    }
    case 6: {
      r.uint(info); // tag number, unwrapped
      return decodeItem(r, depth + 1);
    }
    case 7: {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) return decodeHalf(r.take(2));
      if (info === 26) return new DataView(r.take(4).buffer).getFloat32(0, false);
      if (info === 27) return new DataView(r.take(8).buffer).getFloat64(0, false);
      if (info < 20) return info; // unassigned simple values
      if (info === 24) return r.u8();
      throw new Error(`cbor: unsupported simple/float info ${info}`);
    }
    default:
      throw new Error(`cbor: unreachable major ${major}`);
  }
}

function peekBreak(r: CborReader): boolean {
  const b = r.u8();
  if (b === 0xff) return true;
  r.pos--;
  return false;
}

/** Decode a single CBOR item; trailing bytes are rejected. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const r = new CborReader(bytes);
  const value = decodeItem(r, 0);
  if (r.pos !== bytes.length) throw new Error(`cbor: ${bytes.length - r.pos} trailing bytes`);
  return value;
}

/** Decode, replacing byte strings/bigints so the result is JSON-serializable. */
export function decodeCborJson(bytes: Uint8Array): unknown {
  const walk = (v: CborValue): unknown => {
    if (v instanceof Uint8Array) return `0x${[...v].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(decodeCbor(bytes));
}
