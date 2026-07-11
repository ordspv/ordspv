"use strict";
(() => {
  // packages/core/src/bytes.ts
  function hexToBytes(hex) {
    if (hex.length % 2 !== 0) throw new Error(`hex length must be even, got ${hex.length}`);
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex characters");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  function bytesToHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }
  function reverseBytes(bytes) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
    return out;
  }
  function displayToInternal(hex) {
    return reverseBytes(hexToBytes(hex));
  }
  function internalToDisplay(bytes) {
    return bytesToHex(reverseBytes(bytes));
  }
  function concatBytes(...arrays) {
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
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function leBytesToBigInt(bytes) {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = v << 8n | BigInt(bytes[i]);
    return v;
  }
  function beBytesToBigInt(bytes) {
    let v = 0n;
    for (let i = 0; i < bytes.length; i++) v = v << 8n | BigInt(bytes[i]);
    return v;
  }
  var ByteReader = class {
    bytes;
    pos;
    view;
    constructor(bytes, pos = 0) {
      this.bytes = bytes;
      this.pos = pos;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    get remaining() {
      return this.bytes.length - this.pos;
    }
    need(n) {
      if (this.pos + n > this.bytes.length) {
        throw new Error(`unexpected end of data: need ${n} bytes at ${this.pos}, have ${this.remaining}`);
      }
    }
    peekU8(offset = 0) {
      this.need(offset + 1);
      return this.bytes[this.pos + offset];
    }
    readU8() {
      this.need(1);
      return this.bytes[this.pos++];
    }
    readU16LE() {
      this.need(2);
      const v = this.view.getUint16(this.pos, true);
      this.pos += 2;
      return v;
    }
    readU32LE() {
      this.need(4);
      const v = this.view.getUint32(this.pos, true);
      this.pos += 4;
      return v;
    }
    readI32LE() {
      this.need(4);
      const v = this.view.getInt32(this.pos, true);
      this.pos += 4;
      return v;
    }
    readU64LE() {
      this.need(8);
      const v = this.view.getBigUint64(this.pos, true);
      this.pos += 8;
      return v;
    }
    readBytes(n) {
      this.need(n);
      const out = this.bytes.slice(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }
    /** Bitcoin CompactSize varint. */
    readVarInt() {
      const first = this.readU8();
      if (first < 253) return BigInt(first);
      if (first === 253) return BigInt(this.readU16LE());
      if (first === 254) return BigInt(this.readU32LE());
      return this.readU64LE();
    }
    readVarIntNum() {
      const v = this.readVarInt();
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("varint too large for number");
      return Number(v);
    }
  };
  var ByteWriter = class {
    chunks = [];
    writeU8(v) {
      this.chunks.push(new Uint8Array([v & 255]));
      return this;
    }
    writeU32LE(v) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, v >>> 0, true);
      this.chunks.push(b);
      return this;
    }
    writeI32LE(v) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, v | 0, true);
      this.chunks.push(b);
      return this;
    }
    writeU64LE(v) {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, v, true);
      this.chunks.push(b);
      return this;
    }
    writeVarInt(v) {
      const n = BigInt(v);
      if (n < 0n) throw new Error("varint must be non-negative");
      if (n < 0xfdn) return this.writeU8(Number(n));
      if (n <= 0xffffn) {
        this.writeU8(253);
        const b = new Uint8Array(2);
        new DataView(b.buffer).setUint16(0, Number(n), true);
        this.chunks.push(b);
        return this;
      }
      if (n <= 0xffffffffn) {
        this.writeU8(254);
        return this.writeU32LE(Number(n));
      }
      this.writeU8(255);
      return this.writeU64LE(n);
    }
    writeBytes(b) {
      this.chunks.push(b);
      return this;
    }
    toBytes() {
      return concatBytes(...this.chunks);
    }
  };

  // node_modules/@noble/hashes/utils.js
  function isBytes(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
  }
  function anumber(n, title = "") {
    if (typeof n !== "number") {
      const prefix = title && `"${title}" `;
      throw new TypeError(`${prefix}expected number, got ${typeof n}`);
    }
    if (!Number.isSafeInteger(n) || n < 0) {
      const prefix = title && `"${title}" `;
      throw new RangeError(`${prefix}expected integer >= 0, got ${n}`);
    }
  }
  function abytes(value, length, title = "") {
    const bytes = isBytes(value);
    const len = value?.length;
    const needsLen = length !== void 0;
    if (!bytes || needsLen && len !== length) {
      const prefix = title && `"${title}" `;
      const ofLen = needsLen ? ` of length ${length}` : "";
      const got = bytes ? `length=${len}` : `type=${typeof value}`;
      const message = prefix + "expected Uint8Array" + ofLen + ", got " + got;
      if (!bytes)
        throw new TypeError(message);
      throw new RangeError(message);
    }
    return value;
  }
  function ahash(h) {
    if (typeof h !== "function" || typeof h.create !== "function")
      throw new TypeError("Hash must wrapped by utils.createHasher");
    anumber(h.outputLen);
    anumber(h.blockLen);
    if (h.outputLen < 1)
      throw new Error('"outputLen" must be >= 1');
    if (h.blockLen < 1)
      throw new Error('"blockLen" must be >= 1');
  }
  function aexists(instance, checkFinished = true) {
    if (instance.destroyed)
      throw new Error("Hash instance has been destroyed");
    if (checkFinished && instance.finished)
      throw new Error("Hash#digest() has already been called");
  }
  function aoutput(out, instance) {
    abytes(out, void 0, "digestInto() output");
    const min = instance.outputLen;
    if (out.length < min) {
      throw new RangeError('"digestInto() output" expected to be of length >=' + min);
    }
  }
  function clean(...arrays) {
    for (let i = 0; i < arrays.length; i++) {
      arrays[i].fill(0);
    }
  }
  function createView(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  function rotr(word, shift) {
    return word << 32 - shift | word >>> shift;
  }
  var hasHexBuiltin = /* @__PURE__ */ (() => (
    // @ts-ignore
    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
  ))();
  var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  function bytesToHex2(bytes) {
    abytes(bytes);
    if (hasHexBuiltin)
      return bytes.toHex();
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += hexes[bytes[i]];
    }
    return hex;
  }
  var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
  function asciiToBase16(ch) {
    if (ch >= asciis._0 && ch <= asciis._9)
      return ch - asciis._0;
    if (ch >= asciis.A && ch <= asciis.F)
      return ch - (asciis.A - 10);
    if (ch >= asciis.a && ch <= asciis.f)
      return ch - (asciis.a - 10);
    return;
  }
  function hexToBytes2(hex) {
    if (typeof hex !== "string")
      throw new TypeError("hex string expected, got " + typeof hex);
    if (hasHexBuiltin) {
      try {
        return Uint8Array.fromHex(hex);
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new RangeError(error.message);
        throw error;
      }
    }
    const hl = hex.length;
    const al = hl / 2;
    if (hl % 2)
      throw new RangeError("hex string expected, got unpadded hex of length " + hl);
    const array = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
      const n1 = asciiToBase16(hex.charCodeAt(hi));
      const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
      if (n1 === void 0 || n2 === void 0) {
        const char = hex[hi] + hex[hi + 1];
        throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
      }
      array[ai] = n1 * 16 + n2;
    }
    return array;
  }
  function concatBytes2(...arrays) {
    let sum = 0;
    for (let i = 0; i < arrays.length; i++) {
      const a = arrays[i];
      abytes(a);
      sum += a.length;
    }
    const res = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
      const a = arrays[i];
      res.set(a, pad);
      pad += a.length;
    }
    return res;
  }
  function createHasher(hashCons, info = {}) {
    const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
    const tmp = hashCons(void 0);
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.canXOF = tmp.canXOF;
    hashC.create = (opts) => hashCons(opts);
    Object.assign(hashC, info);
    return Object.freeze(hashC);
  }
  function randomBytes(bytesLength = 32) {
    anumber(bytesLength, "bytesLength");
    const cr = typeof globalThis === "object" ? globalThis.crypto : null;
    if (typeof cr?.getRandomValues !== "function")
      throw new Error("crypto.getRandomValues must be defined");
    if (bytesLength > 65536)
      throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
    return cr.getRandomValues(new Uint8Array(bytesLength));
  }
  var oidNist = (suffix) => ({
    // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
    // Larger suffix values would need base-128 OID encoding and a different length byte.
    oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
  });

  // node_modules/@noble/hashes/_md.js
  function Chi(a, b, c) {
    return a & b ^ ~a & c;
  }
  function Maj(a, b, c) {
    return a & b ^ a & c ^ b & c;
  }
  var HashMD = class {
    blockLen;
    outputLen;
    canXOF = false;
    padOffset;
    isLE;
    // For partial updates less than block size
    buffer;
    view;
    finished = false;
    length = 0;
    pos = 0;
    destroyed = false;
    constructor(blockLen, outputLen, padOffset, isLE) {
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.padOffset = padOffset;
      this.isLE = isLE;
      this.buffer = new Uint8Array(blockLen);
      this.view = createView(this.buffer);
    }
    update(data) {
      aexists(this);
      abytes(data);
      const { view, buffer, blockLen } = this;
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take2 = Math.min(blockLen - this.pos, len - pos);
        if (take2 === blockLen) {
          const dataView = createView(data);
          for (; blockLen <= len - pos; pos += blockLen)
            this.process(dataView, pos);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take2), this.pos);
        this.pos += take2;
        pos += take2;
        if (this.pos === blockLen) {
          this.process(view, 0);
          this.pos = 0;
        }
      }
      this.length += data.length;
      this.roundClean();
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const { buffer, view, blockLen, isLE } = this;
      let { pos } = this;
      buffer[pos++] = 128;
      clean(this.buffer.subarray(pos));
      if (this.padOffset > blockLen - pos) {
        this.process(view, 0);
        pos = 0;
      }
      for (let i = pos; i < blockLen; i++)
        buffer[i] = 0;
      view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
      this.process(view, 0);
      const oview = createView(out);
      const len = this.outputLen;
      if (len % 4)
        throw new Error("_sha2: outputLen must be aligned to 32bit");
      const outLen = len / 4;
      const state = this.get();
      if (outLen > state.length)
        throw new Error("_sha2: outputLen bigger than state");
      for (let i = 0; i < outLen; i++)
        oview.setUint32(4 * i, state[i], isLE);
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      to ||= new this.constructor();
      to.set(...this.get());
      const { blockLen, buffer, length, finished, destroyed, pos } = this;
      to.destroyed = destroyed;
      to.finished = finished;
      to.length = length;
      to.pos = pos;
      if (length % blockLen)
        to.buffer.set(buffer);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
  };
  var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);

  // node_modules/@noble/hashes/sha2.js
  var SHA256_K = /* @__PURE__ */ Uint32Array.from([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
  var SHA2_32B = class extends HashMD {
    constructor(outputLen) {
      super(64, outputLen, 8, false);
    }
    get() {
      const { A, B, C, D, E, F, G, H } = this;
      return [A, B, C, D, E, F, G, H];
    }
    // prettier-ignore
    set(A, B, C, D, E, F, G, H) {
      this.A = A | 0;
      this.B = B | 0;
      this.C = C | 0;
      this.D = D | 0;
      this.E = E | 0;
      this.F = F | 0;
      this.G = G | 0;
      this.H = H | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4)
        SHA256_W[i] = view.getUint32(offset, false);
      for (let i = 16; i < 64; i++) {
        const W15 = SHA256_W[i - 15];
        const W2 = SHA256_W[i - 2];
        const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
        const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
        SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
      }
      let { A, B, C, D, E, F, G, H } = this;
      for (let i = 0; i < 64; i++) {
        const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
        const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
        const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
        const T2 = sigma0 + Maj(A, B, C) | 0;
        H = G;
        G = F;
        F = E;
        E = D + T1 | 0;
        D = C;
        C = B;
        B = A;
        A = T1 + T2 | 0;
      }
      A = A + this.A | 0;
      B = B + this.B | 0;
      C = C + this.C | 0;
      D = D + this.D | 0;
      E = E + this.E | 0;
      F = F + this.F | 0;
      G = G + this.G | 0;
      H = H + this.H | 0;
      this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
      clean(SHA256_W);
    }
    destroy() {
      this.destroyed = true;
      this.set(0, 0, 0, 0, 0, 0, 0, 0);
      clean(this.buffer);
    }
  };
  var _SHA256 = class extends SHA2_32B {
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    A = SHA256_IV[0] | 0;
    B = SHA256_IV[1] | 0;
    C = SHA256_IV[2] | 0;
    D = SHA256_IV[3] | 0;
    E = SHA256_IV[4] | 0;
    F = SHA256_IV[5] | 0;
    G = SHA256_IV[6] | 0;
    H = SHA256_IV[7] | 0;
    constructor() {
      super(32);
    }
  };
  var sha256 = /* @__PURE__ */ createHasher(
    () => new _SHA256(),
    /* @__PURE__ */ oidNist(1)
  );

  // packages/core/src/hash.ts
  function sha2562(data) {
    return sha256(data);
  }
  function sha256d(data) {
    return sha256(sha256(data));
  }
  function taggedHash(tag, ...msgs) {
    const tagHash = sha256(new TextEncoder().encode(tag));
    return sha256(concatBytes(tagHash, tagHash, ...msgs));
  }

  // packages/core/src/tx.ts
  function parseTx(raw, opts = {}) {
    const r = new ByteReader(raw);
    const start = r.pos;
    const version = r.readI32LE();
    let hasWitness = false;
    if (r.peekU8(0) === 0) {
      const flag = r.peekU8(1);
      if (flag !== 1) throw new Error(`invalid segwit flag 0x${flag.toString(16)}`);
      r.pos += 2;
      hasWitness = true;
    }
    const vinCount = r.readVarIntNum();
    if (vinCount === 0) throw new Error("transaction has zero inputs");
    const inputs = [];
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
        witness: []
      });
    }
    const voutCount = r.readVarIntNum();
    const outputs = [];
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
        const items = [];
        for (let j = 0; j < itemCount; j++) {
          const len = r.readVarIntNum();
          items.push(r.readBytes(len));
        }
        if (itemCount > 0) anyWitness = true;
        inputs[i].witness = items;
      }
      if (!anyWitness) throw new Error("segwit marker present but all witness stacks empty");
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
      size: exactRaw.length
    };
  }
  function serializeStripped(tx) {
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
  function isCoinbase(tx) {
    if (tx.inputs.length !== 1) return false;
    const input = tx.inputs[0];
    return input.vout === 4294967295 && input.prevTxidLE.every((b) => b === 0);
  }

  // packages/core/src/header.ts
  function parseHeader(raw) {
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
      hash: internalToDisplay(hashLE)
    };
  }
  function bitsToTarget(bits) {
    const exponent = bits >>> 24;
    const mantissa = BigInt(bits & 8388607);
    if ((bits & 8388608) !== 0) throw new Error("negative target");
    let target;
    if (exponent <= 3) {
      target = mantissa >> 8n * BigInt(3 - exponent);
    } else {
      target = mantissa << 8n * BigInt(exponent - 3);
    }
    if (target >> 256n !== 0n) throw new Error("target overflow");
    return target;
  }
  function checkProofOfWork(header) {
    const target = bitsToTarget(header.bits);
    const hashValue = leBytesToBigInt(header.hashLE);
    return hashValue <= target;
  }
  var MAINNET_CHAIN_PARAMS = {
    retargetInterval: 2016,
    targetTimespan: 14 * 24 * 3600,
    powLimitBits: 486604799
  };

  // packages/core/src/merkle.ts
  function hashPair(a, b) {
    return sha256d(concatBytes(a, b));
  }
  function verifyMerkleBranch(leaf, branch, pos, txCount) {
    if (pos < 0 || !Number.isInteger(pos)) throw new Error("invalid merkle position");
    if (txCount !== void 0) {
      if (pos >= txCount) throw new Error(`merkle position ${pos} out of range for ${txCount} txs`);
      const expectedHeight = treeHeight(txCount);
      if (branch.length !== expectedHeight) {
        throw new Error(`merkle branch length ${branch.length} != expected height ${expectedHeight}`);
      }
    }
    let node = leaf;
    let index = pos;
    let width = txCount;
    for (let i = 0; i < branch.length; i++) {
      const sibling = branch[i];
      if (width !== void 0) {
        const isLastOdd = index === width - 1 && width % 2 === 1;
        if (isLastOdd && !bytesEqual(sibling, node)) {
          throw new Error(`merkle level ${i}: expected self-paired final node`);
        }
        if (!isLastOdd && bytesEqual(sibling, node) && index % 2 === 0 && index + 1 === width - 1) {
          throw new Error(`merkle level ${i}: duplicate sibling (possible mutation)`);
        }
        width = Math.ceil(width / 2);
      }
      node = index % 2 === 1 ? hashPair(sibling, node) : hashPair(node, sibling);
      index = Math.floor(index / 2);
    }
    if (index !== 0) throw new Error("merkle position exceeds branch length");
    return { root: node };
  }
  function treeHeight(leafCount) {
    if (leafCount <= 0) throw new Error("invalid leaf count");
    let height = 0;
    let width = leafCount;
    while (width > 1) {
      width = Math.ceil(width / 2);
      height++;
    }
    return height;
  }
  function buildMerkleBranch(leaves, pos) {
    if (pos < 0 || pos >= leaves.length) throw new Error("position out of range");
    const branch = [];
    let level = leaves.slice();
    let index = pos;
    while (level.length > 1) {
      const siblingIndex = index % 2 === 1 ? index - 1 : index + 1;
      branch.push(siblingIndex < level.length ? level[siblingIndex] : level[index]);
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : level[i];
        next.push(hashPair(left, right));
      }
      level = next;
      index = Math.floor(index / 2);
    }
    return branch;
  }

  // packages/core/src/script.ts
  var OP_0 = 0;
  var OP_PUSHDATA1 = 76;
  var OP_PUSHDATA2 = 77;
  var OP_PUSHDATA4 = 78;
  var OP_1NEGATE = 79;
  var OP_1 = 81;
  var OP_16 = 96;
  var OP_IF = 99;
  var OP_ENDIF = 104;
  function parseScript(script) {
    const ops = [];
    let i = 0;
    while (i < script.length) {
      const offset = i;
      const opcode = script[i++];
      if (opcode === OP_0) {
        ops.push({ opcode, data: new Uint8Array(0), offset });
      } else if (opcode >= 1 && opcode <= 75) {
        ops.push({ opcode, data: take(script, i, opcode), offset });
        i += opcode;
      } else if (opcode === OP_PUSHDATA1) {
        const len = at(script, i);
        i += 1;
        ops.push({ opcode, data: take(script, i, len), offset });
        i += len;
      } else if (opcode === OP_PUSHDATA2) {
        const len = at(script, i) | at(script, i + 1) << 8;
        i += 2;
        ops.push({ opcode, data: take(script, i, len), offset });
        i += len;
      } else if (opcode === OP_PUSHDATA4) {
        const len = at(script, i) | at(script, i + 1) << 8 | at(script, i + 2) << 16 | at(script, i + 3) << 24;
        if (len < 0) throw new Error("push length overflow");
        i += 4;
        ops.push({ opcode, data: take(script, i, len), offset });
        i += len;
      } else {
        ops.push({ opcode, offset });
      }
    }
    return ops;
  }
  function at(script, i) {
    if (i >= script.length) throw new Error("script truncated");
    return script[i];
  }
  function take(script, i, len) {
    if (i + len > script.length) throw new Error("script push overruns end");
    return script.slice(i, i + len);
  }

  // packages/core/src/inscriptionId.ts
  var ID_RE = /^[0-9a-f]{64}i(0|[1-9][0-9]*)$/;
  function parseInscriptionId(id) {
    const normalized = id.toLowerCase();
    if (!ID_RE.test(normalized)) throw new Error(`invalid inscription id: ${id}`);
    const txid = normalized.slice(0, 64);
    const index = Number(normalized.slice(65));
    if (!Number.isSafeInteger(index) || index > 4294967295) {
      throw new Error(`inscription index out of range: ${index}`);
    }
    return { txid, txidLE: displayToInternal(txid), index };
  }
  function formatInscriptionId(txid, index) {
    return `${txid.toLowerCase()}i${index}`;
  }
  function isInscriptionId(s) {
    return ID_RE.test(s.toLowerCase());
  }

  // node_modules/@noble/curves/utils.js
  var abytes2 = (value, length, title) => abytes(value, length, title);
  var anumber2 = anumber;
  var bytesToHex3 = bytesToHex2;
  var concatBytes3 = (...arrays) => concatBytes2(...arrays);
  var hexToBytes3 = (hex) => hexToBytes2(hex);
  var isBytes2 = isBytes;
  var randomBytes2 = (bytesLength) => randomBytes(bytesLength);
  var _0n = /* @__PURE__ */ BigInt(0);
  var _1n = /* @__PURE__ */ BigInt(1);
  function abool(value, title = "") {
    if (typeof value !== "boolean") {
      const prefix = title && `"${title}" `;
      throw new TypeError(prefix + "expected boolean, got type=" + typeof value);
    }
    return value;
  }
  function abignumber(n) {
    if (typeof n === "bigint") {
      if (!isPosBig(n))
        throw new RangeError("positive bigint expected, got " + n);
    } else
      anumber2(n);
    return n;
  }
  function asafenumber(value, title = "") {
    if (typeof value !== "number") {
      const prefix = title && `"${title}" `;
      throw new TypeError(prefix + "expected number, got type=" + typeof value);
    }
    if (!Number.isSafeInteger(value)) {
      const prefix = title && `"${title}" `;
      throw new RangeError(prefix + "expected safe integer, got " + value);
    }
  }
  function numberToHexUnpadded(num) {
    const hex = abignumber(num).toString(16);
    return hex.length & 1 ? "0" + hex : hex;
  }
  function hexToNumber(hex) {
    if (typeof hex !== "string")
      throw new TypeError("hex string expected, got " + typeof hex);
    return hex === "" ? _0n : BigInt("0x" + hex);
  }
  function bytesToNumberBE(bytes) {
    return hexToNumber(bytesToHex2(bytes));
  }
  function bytesToNumberLE(bytes) {
    return hexToNumber(bytesToHex2(copyBytes(abytes(bytes)).reverse()));
  }
  function numberToBytesBE(n, len) {
    anumber(len);
    if (len === 0)
      throw new RangeError("zero length");
    n = abignumber(n);
    const hex = n.toString(16);
    if (hex.length > len * 2)
      throw new RangeError("number too large");
    return hexToBytes2(hex.padStart(len * 2, "0"));
  }
  function numberToBytesLE(n, len) {
    return numberToBytesBE(n, len).reverse();
  }
  function copyBytes(bytes) {
    return Uint8Array.from(abytes2(bytes));
  }
  var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
  function inRange(n, min, max) {
    return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
  }
  function aInRange(title, n, min, max) {
    if (!inRange(n, min, max))
      throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
  }
  function bitLen(n) {
    if (n < _0n)
      throw new Error("expected non-negative bigint, got " + n);
    let len;
    for (len = 0; n > _0n; n >>= _1n, len += 1)
      ;
    return len;
  }
  var bitMask = (n) => (_1n << BigInt(n)) - _1n;
  function createHmacDrbg(hashLen, qByteLen, hmacFn) {
    anumber(hashLen, "hashLen");
    anumber(qByteLen, "qByteLen");
    if (typeof hmacFn !== "function")
      throw new TypeError("hmacFn must be a function");
    const u8n = (len) => new Uint8Array(len);
    const NULL = Uint8Array.of();
    const byte0 = Uint8Array.of(0);
    const byte1 = Uint8Array.of(1);
    const _maxDrbgIters = 1e3;
    let v = u8n(hashLen);
    let k = u8n(hashLen);
    let i = 0;
    const reset = () => {
      v.fill(1);
      k.fill(0);
      i = 0;
    };
    const h = (...msgs) => hmacFn(k, concatBytes3(v, ...msgs));
    const reseed = (seed = NULL) => {
      k = h(byte0, seed);
      v = h();
      if (seed.length === 0)
        return;
      k = h(byte1, seed);
      v = h();
    };
    const gen = () => {
      if (i++ >= _maxDrbgIters)
        throw new Error("drbg: tried max amount of iterations");
      let len = 0;
      const out = [];
      while (len < qByteLen) {
        v = h();
        const sl = v.slice();
        out.push(sl);
        len += v.length;
      }
      return concatBytes3(...out);
    };
    const genUntil = (seed, pred) => {
      reset();
      reseed(seed);
      let res = void 0;
      while ((res = pred(gen())) === void 0)
        reseed();
      reset();
      return res;
    };
    return genUntil;
  }
  function validateObject(object, fields = {}, optFields = {}) {
    if (Object.prototype.toString.call(object) !== "[object Object]")
      throw new TypeError("expected valid options object");
    function checkField(fieldName, expectedType, isOpt) {
      if (!isOpt && expectedType !== "function" && !Object.hasOwn(object, fieldName))
        throw new TypeError(`param "${fieldName}" is invalid: expected own property`);
      const val = object[fieldName];
      if (isOpt && val === void 0)
        return;
      const current = typeof val;
      if (current !== expectedType || val === null)
        throw new TypeError(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
    }
    const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
    iter(fields, false);
    iter(optFields, true);
  }

  // node_modules/@noble/curves/abstract/modular.js
  var _0n2 = /* @__PURE__ */ BigInt(0);
  var _1n2 = /* @__PURE__ */ BigInt(1);
  var _2n = /* @__PURE__ */ BigInt(2);
  var _3n = /* @__PURE__ */ BigInt(3);
  var _4n = /* @__PURE__ */ BigInt(4);
  var _5n = /* @__PURE__ */ BigInt(5);
  var _7n = /* @__PURE__ */ BigInt(7);
  var _8n = /* @__PURE__ */ BigInt(8);
  var _9n = /* @__PURE__ */ BigInt(9);
  var _16n = /* @__PURE__ */ BigInt(16);
  function mod(a, b) {
    if (b <= _0n2)
      throw new Error("mod: expected positive modulus, got " + b);
    const result = a % b;
    return result >= _0n2 ? result : b + result;
  }
  function pow2(x, power, modulo) {
    if (power < _0n2)
      throw new Error("pow2: expected non-negative exponent, got " + power);
    let res = x;
    while (power-- > _0n2) {
      res *= res;
      res %= modulo;
    }
    return res;
  }
  function invert(number, modulo) {
    if (number === _0n2)
      throw new Error("invert: expected non-zero number");
    if (modulo <= _0n2)
      throw new Error("invert: expected positive modulus, got " + modulo);
    let a = mod(number, modulo);
    let b = modulo;
    let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
    while (a !== _0n2) {
      const q = b / a;
      const r = b - a * q;
      const m = x - u * q;
      const n = y - v * q;
      b = a, a = r, x = u, y = v, u = m, v = n;
    }
    const gcd = b;
    if (gcd !== _1n2)
      throw new Error("invert: does not exist");
    return mod(x, modulo);
  }
  function assertIsSquare(Fp, root, n) {
    const F = Fp;
    if (!F.eql(F.sqr(root), n))
      throw new Error("Cannot find square root");
  }
  function sqrt3mod4(Fp, n) {
    const F = Fp;
    const p1div4 = (F.ORDER + _1n2) / _4n;
    const root = F.pow(n, p1div4);
    assertIsSquare(F, root, n);
    return root;
  }
  function sqrt5mod8(Fp, n) {
    const F = Fp;
    const p5div8 = (F.ORDER - _5n) / _8n;
    const n2 = F.mul(n, _2n);
    const v = F.pow(n2, p5div8);
    const nv = F.mul(n, v);
    const i = F.mul(F.mul(nv, _2n), v);
    const root = F.mul(nv, F.sub(i, F.ONE));
    assertIsSquare(F, root, n);
    return root;
  }
  function sqrt9mod16(P) {
    const Fp_ = Field(P);
    const tn = tonelliShanks(P);
    const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
    const c2 = tn(Fp_, c1);
    const c3 = tn(Fp_, Fp_.neg(c1));
    const c4 = (P + _7n) / _16n;
    return ((Fp, n) => {
      const F = Fp;
      let tv1 = F.pow(n, c4);
      let tv2 = F.mul(tv1, c1);
      const tv3 = F.mul(tv1, c2);
      const tv4 = F.mul(tv1, c3);
      const e1 = F.eql(F.sqr(tv2), n);
      const e2 = F.eql(F.sqr(tv3), n);
      tv1 = F.cmov(tv1, tv2, e1);
      tv2 = F.cmov(tv4, tv3, e2);
      const e3 = F.eql(F.sqr(tv2), n);
      const root = F.cmov(tv1, tv2, e3);
      assertIsSquare(F, root, n);
      return root;
    });
  }
  function tonelliShanks(P) {
    if (P < _3n)
      throw new Error("sqrt is not defined for small field");
    let Q = P - _1n2;
    let S = 0;
    while (Q % _2n === _0n2) {
      Q /= _2n;
      S++;
    }
    let Z = _2n;
    const _Fp = Field(P);
    while (FpLegendre(_Fp, Z) === 1) {
      if (Z++ > 1e3)
        throw new Error("Cannot find square root: probably non-prime P");
    }
    if (S === 1)
      return sqrt3mod4;
    let cc = _Fp.pow(Z, Q);
    const Q1div2 = (Q + _1n2) / _2n;
    return function tonelliSlow(Fp, n) {
      const F = Fp;
      if (F.is0(n))
        return n;
      if (FpLegendre(F, n) !== 1)
        throw new Error("Cannot find square root");
      let M = S;
      let c = F.mul(F.ONE, cc);
      let t = F.pow(n, Q);
      let R = F.pow(n, Q1div2);
      while (!F.eql(t, F.ONE)) {
        if (F.is0(t))
          return F.ZERO;
        let i = 1;
        let t_tmp = F.sqr(t);
        while (!F.eql(t_tmp, F.ONE)) {
          i++;
          t_tmp = F.sqr(t_tmp);
          if (i === M)
            throw new Error("Cannot find square root");
        }
        const exponent = _1n2 << BigInt(M - i - 1);
        const b = F.pow(c, exponent);
        M = i;
        c = F.sqr(b);
        t = F.mul(t, c);
        R = F.mul(R, b);
      }
      return R;
    };
  }
  function FpSqrt(P) {
    if (P % _4n === _3n)
      return sqrt3mod4;
    if (P % _8n === _5n)
      return sqrt5mod8;
    if (P % _16n === _9n)
      return sqrt9mod16(P);
    return tonelliShanks(P);
  }
  var FIELD_FIELDS = [
    "create",
    "isValid",
    "is0",
    "neg",
    "inv",
    "sqrt",
    "sqr",
    "eql",
    "add",
    "sub",
    "mul",
    "pow",
    "div",
    "addN",
    "subN",
    "mulN",
    "sqrN"
  ];
  function validateField(field) {
    const initial = {
      ORDER: "bigint",
      BYTES: "number",
      BITS: "number"
    };
    const opts = FIELD_FIELDS.reduce((map, val) => {
      map[val] = "function";
      return map;
    }, initial);
    validateObject(field, opts);
    asafenumber(field.BYTES, "BYTES");
    asafenumber(field.BITS, "BITS");
    if (field.BYTES < 1 || field.BITS < 1)
      throw new Error("invalid field: expected BYTES/BITS > 0");
    if (field.ORDER <= _1n2)
      throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
    return field;
  }
  function FpPow(Fp, num, power) {
    const F = Fp;
    if (power < _0n2)
      throw new Error("invalid exponent, negatives unsupported");
    if (power === _0n2)
      return F.ONE;
    if (power === _1n2)
      return num;
    let p = F.ONE;
    let d = num;
    while (power > _0n2) {
      if (power & _1n2)
        p = F.mul(p, d);
      d = F.sqr(d);
      power >>= _1n2;
    }
    return p;
  }
  function FpInvertBatch(Fp, nums, passZero = false) {
    const F = Fp;
    const inverted = new Array(nums.length).fill(passZero ? F.ZERO : void 0);
    const multipliedAcc = nums.reduce((acc, num, i) => {
      if (F.is0(num))
        return acc;
      inverted[i] = acc;
      return F.mul(acc, num);
    }, F.ONE);
    const invertedAcc = F.inv(multipliedAcc);
    nums.reduceRight((acc, num, i) => {
      if (F.is0(num))
        return acc;
      inverted[i] = F.mul(acc, inverted[i]);
      return F.mul(acc, num);
    }, invertedAcc);
    return inverted;
  }
  function FpLegendre(Fp, n) {
    const F = Fp;
    const p1mod2 = (F.ORDER - _1n2) / _2n;
    const powered = F.pow(n, p1mod2);
    const yes = F.eql(powered, F.ONE);
    const zero = F.eql(powered, F.ZERO);
    const no = F.eql(powered, F.neg(F.ONE));
    if (!yes && !zero && !no)
      throw new Error("invalid Legendre symbol result");
    return yes ? 1 : zero ? 0 : -1;
  }
  function nLength(n, nBitLength) {
    if (nBitLength !== void 0)
      anumber2(nBitLength);
    if (n <= _0n2)
      throw new Error("invalid n length: expected positive n, got " + n);
    if (nBitLength !== void 0 && nBitLength < 1)
      throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
    const bits = bitLen(n);
    if (nBitLength !== void 0 && nBitLength < bits)
      throw new Error(`invalid n length: expected bit length (${bits}) >= n.length (${nBitLength})`);
    const _nBitLength = nBitLength !== void 0 ? nBitLength : bits;
    const nByteLength = Math.ceil(_nBitLength / 8);
    return { nBitLength: _nBitLength, nByteLength };
  }
  var FIELD_SQRT = /* @__PURE__ */ new WeakMap();
  var _Field = class {
    ORDER;
    BITS;
    BYTES;
    isLE;
    ZERO = _0n2;
    ONE = _1n2;
    _lengths;
    _mod;
    constructor(ORDER, opts = {}) {
      if (ORDER <= _1n2)
        throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
      let _nbitLength = void 0;
      this.isLE = false;
      if (opts != null && typeof opts === "object") {
        if (typeof opts.BITS === "number")
          _nbitLength = opts.BITS;
        if (typeof opts.sqrt === "function")
          Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
        if (typeof opts.isLE === "boolean")
          this.isLE = opts.isLE;
        if (opts.allowedLengths)
          this._lengths = Object.freeze(opts.allowedLengths.slice());
        if (typeof opts.modFromBytes === "boolean")
          this._mod = opts.modFromBytes;
      }
      const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
      if (nByteLength > 2048)
        throw new Error("invalid field: expected ORDER of <= 2048 bytes");
      this.ORDER = ORDER;
      this.BITS = nBitLength;
      this.BYTES = nByteLength;
      Object.freeze(this);
    }
    create(num) {
      return mod(num, this.ORDER);
    }
    isValid(num) {
      if (typeof num !== "bigint")
        throw new TypeError("invalid field element: expected bigint, got " + typeof num);
      return _0n2 <= num && num < this.ORDER;
    }
    is0(num) {
      return num === _0n2;
    }
    // is valid and invertible
    isValidNot0(num) {
      return !this.is0(num) && this.isValid(num);
    }
    isOdd(num) {
      return (num & _1n2) === _1n2;
    }
    neg(num) {
      return mod(-num, this.ORDER);
    }
    eql(lhs, rhs) {
      return lhs === rhs;
    }
    sqr(num) {
      return mod(num * num, this.ORDER);
    }
    add(lhs, rhs) {
      return mod(lhs + rhs, this.ORDER);
    }
    sub(lhs, rhs) {
      return mod(lhs - rhs, this.ORDER);
    }
    mul(lhs, rhs) {
      return mod(lhs * rhs, this.ORDER);
    }
    pow(num, power) {
      return FpPow(this, num, power);
    }
    div(lhs, rhs) {
      return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
    }
    // Same as above, but doesn't normalize
    sqrN(num) {
      return num * num;
    }
    addN(lhs, rhs) {
      return lhs + rhs;
    }
    subN(lhs, rhs) {
      return lhs - rhs;
    }
    mulN(lhs, rhs) {
      return lhs * rhs;
    }
    inv(num) {
      return invert(num, this.ORDER);
    }
    sqrt(num) {
      let sqrt = FIELD_SQRT.get(this);
      if (!sqrt)
        FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
      return sqrt(this, num);
    }
    toBytes(num) {
      return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
    }
    fromBytes(bytes, skipValidation = false) {
      abytes2(bytes);
      const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
      if (allowedLengths) {
        if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
          throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
        }
        const padded = new Uint8Array(BYTES);
        padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
        bytes = padded;
      }
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
      if (modFromBytes)
        scalar = mod(scalar, ORDER);
      if (!skipValidation) {
        if (!this.isValid(scalar))
          throw new Error("invalid field element: outside of range 0..ORDER");
      }
      return scalar;
    }
    // TODO: we don't need it here, move out to separate fn
    invertBatch(lst) {
      return FpInvertBatch(this, lst);
    }
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov(a, b, condition) {
      abool(condition, "condition");
      return condition ? b : a;
    }
  };
  Object.freeze(_Field.prototype);
  function Field(ORDER, opts = {}) {
    return new _Field(ORDER, opts);
  }
  function getFieldBytesLength(fieldOrder) {
    if (typeof fieldOrder !== "bigint")
      throw new Error("field order must be bigint");
    if (fieldOrder <= _1n2)
      throw new Error("field order must be greater than 1");
    const bitLength = bitLen(fieldOrder - _1n2);
    return Math.ceil(bitLength / 8);
  }
  function getMinHashLength(fieldOrder) {
    const length = getFieldBytesLength(fieldOrder);
    return length + Math.ceil(length / 2);
  }
  function mapHashToField(key, fieldOrder, isLE = false) {
    abytes2(key);
    const len = key.length;
    const fieldLen = getFieldBytesLength(fieldOrder);
    const minLen = Math.max(getMinHashLength(fieldOrder), 16);
    if (len < minLen || len > 1024)
      throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
    const num = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
    const reduced = mod(num, fieldOrder - _1n2) + _1n2;
    return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
  }

  // node_modules/@noble/curves/abstract/curve.js
  var _0n3 = /* @__PURE__ */ BigInt(0);
  var _1n3 = /* @__PURE__ */ BigInt(1);
  function negateCt(condition, item) {
    const neg = item.negate();
    return condition ? neg : item;
  }
  function normalizeZ(c, points) {
    const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
    return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
  }
  function validateW(W, bits) {
    if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
      throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
  }
  function calcWOpts(W, scalarBits) {
    validateW(W, scalarBits);
    const windows = Math.ceil(scalarBits / W) + 1;
    const windowSize = 2 ** (W - 1);
    const maxNumber = 2 ** W;
    const mask = bitMask(W);
    const shiftBy = BigInt(W);
    return { windows, windowSize, mask, maxNumber, shiftBy };
  }
  function calcOffsets(n, window2, wOpts) {
    const { windowSize, mask, maxNumber, shiftBy } = wOpts;
    let wbits = Number(n & mask);
    let nextN = n >> shiftBy;
    if (wbits > windowSize) {
      wbits -= maxNumber;
      nextN += _1n3;
    }
    const offsetStart = window2 * windowSize;
    const offset = offsetStart + Math.abs(wbits) - 1;
    const isZero = wbits === 0;
    const isNeg = wbits < 0;
    const isNegF = window2 % 2 !== 0;
    const offsetF = offsetStart;
    return { nextN, offset, isZero, isNeg, isNegF, offsetF };
  }
  var pointPrecomputes = /* @__PURE__ */ new WeakMap();
  var pointWindowSizes = /* @__PURE__ */ new WeakMap();
  function getW(P) {
    return pointWindowSizes.get(P) || 1;
  }
  function assert0(n) {
    if (n !== _0n3)
      throw new Error("invalid wNAF");
  }
  var wNAF = class {
    BASE;
    ZERO;
    Fn;
    bits;
    // Parametrized with a given Point class (not individual point)
    constructor(Point, bits) {
      this.BASE = Point.BASE;
      this.ZERO = Point.ZERO;
      this.Fn = Point.Fn;
      this.bits = bits;
    }
    // non-const time multiplication ladder
    _unsafeLadder(elm, n, p = this.ZERO) {
      let d = elm;
      while (n > _0n3) {
        if (n & _1n3)
          p = p.add(d);
        d = d.double();
        n >>= _1n3;
      }
      return p;
    }
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param point - Point instance
     * @param W - window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(point, W) {
      const { windows, windowSize } = calcWOpts(W, this.bits);
      const points = [];
      let p = point;
      let base = p;
      for (let window2 = 0; window2 < windows; window2++) {
        base = p;
        points.push(base);
        for (let i = 1; i < windowSize; i++) {
          base = base.add(p);
          points.push(base);
        }
        p = base.double();
      }
      return points;
    }
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * More compact implementation:
     * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
     * @returns real and fake (for const-time) points
     */
    wNAF(W, precomputes, n) {
      if (!this.Fn.isValid(n))
        throw new Error("invalid scalar");
      let p = this.ZERO;
      let f = this.BASE;
      const wo = calcWOpts(W, this.bits);
      for (let window2 = 0; window2 < wo.windows; window2++) {
        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window2, wo);
        n = nextN;
        if (isZero) {
          f = f.add(negateCt(isNegF, precomputes[offsetF]));
        } else {
          p = p.add(negateCt(isNeg, precomputes[offset]));
        }
      }
      assert0(n);
      return { p, f };
    }
    /**
     * Implements unsafe EC multiplication using precomputed tables
     * and w-ary non-adjacent form.
     * @param acc - accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
      const wo = calcWOpts(W, this.bits);
      for (let window2 = 0; window2 < wo.windows; window2++) {
        if (n === _0n3)
          break;
        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window2, wo);
        n = nextN;
        if (isZero) {
          continue;
        } else {
          const item = precomputes[offset];
          acc = acc.add(isNeg ? item.negate() : item);
        }
      }
      assert0(n);
      return acc;
    }
    getPrecomputes(W, point, transform) {
      let comp = pointPrecomputes.get(point);
      if (!comp) {
        comp = this.precomputeWindow(point, W);
        if (W !== 1) {
          if (typeof transform === "function")
            comp = transform(comp);
          pointPrecomputes.set(point, comp);
        }
      }
      return comp;
    }
    cached(point, scalar, transform) {
      const W = getW(point);
      return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
    }
    unsafe(point, scalar, transform, prev) {
      const W = getW(point);
      if (W === 1)
        return this._unsafeLadder(point, scalar, prev);
      return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
    }
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    createCache(P, W) {
      validateW(W, this.bits);
      pointWindowSizes.set(P, W);
      pointPrecomputes.delete(P);
    }
    hasCache(elm) {
      return getW(elm) !== 1;
    }
  };
  function mulEndoUnsafe(Point, point, k1, k2) {
    let acc = point;
    let p1 = Point.ZERO;
    let p2 = Point.ZERO;
    while (k1 > _0n3 || k2 > _0n3) {
      if (k1 & _1n3)
        p1 = p1.add(acc);
      if (k2 & _1n3)
        p2 = p2.add(acc);
      acc = acc.double();
      k1 >>= _1n3;
      k2 >>= _1n3;
    }
    return { p1, p2 };
  }
  function createField(order, field, isLE) {
    if (field) {
      if (field.ORDER !== order)
        throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
      validateField(field);
      return field;
    } else {
      return Field(order, { isLE });
    }
  }
  function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
    if (FpFnLE === void 0)
      FpFnLE = type === "edwards";
    if (!CURVE || typeof CURVE !== "object")
      throw new Error(`expected valid ${type} CURVE object`);
    for (const p of ["p", "n", "h"]) {
      const val = CURVE[p];
      if (!(typeof val === "bigint" && val > _0n3))
        throw new Error(`CURVE.${p} must be positive bigint`);
    }
    const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
    const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
    const _b = type === "weierstrass" ? "b" : "d";
    const params = ["Gx", "Gy", "a", _b];
    for (const p of params) {
      if (!Fp.isValid(CURVE[p]))
        throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
    }
    CURVE = Object.freeze(Object.assign({}, CURVE));
    return { CURVE, Fp, Fn };
  }
  function createKeygen(randomSecretKey, getPublicKey) {
    return function keygen(seed) {
      const secretKey = randomSecretKey(seed);
      return { secretKey, publicKey: getPublicKey(secretKey) };
    };
  }

  // node_modules/@noble/hashes/hmac.js
  var _HMAC = class {
    oHash;
    iHash;
    blockLen;
    outputLen;
    canXOF = false;
    finished = false;
    destroyed = false;
    constructor(hash, key) {
      ahash(hash);
      abytes(key, void 0, "key");
      this.iHash = hash.create();
      if (typeof this.iHash.update !== "function")
        throw new Error("Expected instance of class which extends utils.Hash");
      this.blockLen = this.iHash.blockLen;
      this.outputLen = this.iHash.outputLen;
      const blockLen = this.blockLen;
      const pad = new Uint8Array(blockLen);
      pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54;
      this.iHash.update(pad);
      this.oHash = hash.create();
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54 ^ 92;
      this.oHash.update(pad);
      clean(pad);
    }
    update(buf) {
      aexists(this);
      this.iHash.update(buf);
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const buf = out.subarray(0, this.outputLen);
      this.iHash.digestInto(buf);
      this.oHash.update(buf);
      this.oHash.digestInto(buf);
      this.destroy();
    }
    digest() {
      const out = new Uint8Array(this.oHash.outputLen);
      this.digestInto(out);
      return out;
    }
    _cloneInto(to) {
      to ||= Object.create(Object.getPrototypeOf(this), {});
      const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
      to = to;
      to.finished = finished;
      to.destroyed = destroyed;
      to.blockLen = blockLen;
      to.outputLen = outputLen;
      to.oHash = oHash._cloneInto(to.oHash);
      to.iHash = iHash._cloneInto(to.iHash);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
    destroy() {
      this.destroyed = true;
      this.oHash.destroy();
      this.iHash.destroy();
    }
  };
  var hmac = /* @__PURE__ */ (() => {
    const hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
    hmac_.create = (hash, key) => new _HMAC(hash, key);
    return hmac_;
  })();

  // node_modules/@noble/curves/abstract/weierstrass.js
  var divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n2) / den;
  function _splitEndoScalar(k, basis, n) {
    aInRange("scalar", k, _0n4, n);
    const [[a1, b1], [a2, b2]] = basis;
    const c1 = divNearest(b2 * k, n);
    const c2 = divNearest(-b1 * k, n);
    let k1 = k - c1 * a1 - c2 * a2;
    let k2 = -c1 * b1 - c2 * b2;
    const k1neg = k1 < _0n4;
    const k2neg = k2 < _0n4;
    if (k1neg)
      k1 = -k1;
    if (k2neg)
      k2 = -k2;
    const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
    if (k1 < _0n4 || k1 >= MAX_NUM || k2 < _0n4 || k2 >= MAX_NUM) {
      throw new Error("splitScalar (endomorphism): failed for k");
    }
    return { k1neg, k1, k2neg, k2 };
  }
  function validateSigFormat(format) {
    if (!["compact", "recovered", "der"].includes(format))
      throw new Error('Signature format must be "compact", "recovered", or "der"');
    return format;
  }
  function validateSigOpts(opts, def) {
    validateObject(opts);
    const optsn = {};
    for (let optName of Object.keys(def)) {
      optsn[optName] = opts[optName] === void 0 ? def[optName] : opts[optName];
    }
    abool(optsn.lowS, "lowS");
    abool(optsn.prehash, "prehash");
    if (optsn.format !== void 0)
      validateSigFormat(optsn.format);
    return optsn;
  }
  var DERErr = class extends Error {
    constructor(m = "") {
      super(m);
    }
  };
  var DER = {
    // asn.1 DER encoding utils
    Err: DERErr,
    // Basic building block is TLV (Tag-Length-Value)
    _tlv: {
      encode: (tag, data) => {
        const { Err: E } = DER;
        asafenumber(tag, "tag");
        if (tag < 0 || tag > 255)
          throw new E("tlv.encode: wrong tag");
        if (typeof data !== "string")
          throw new TypeError('"data" expected string, got type=' + typeof data);
        if (data.length & 1)
          throw new E("tlv.encode: unpadded data");
        const dataLen = data.length / 2;
        const len = numberToHexUnpadded(dataLen);
        if (len.length / 2 & 128)
          throw new E("tlv.encode: long form length too big");
        const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
        const t = numberToHexUnpadded(tag);
        return t + lenLen + len + data;
      },
      // v - value, l - left bytes (unparsed)
      decode(tag, data) {
        const { Err: E } = DER;
        data = abytes2(data, void 0, "DER data");
        let pos = 0;
        if (tag < 0 || tag > 255)
          throw new E("tlv.encode: wrong tag");
        if (data.length < 2 || data[pos++] !== tag)
          throw new E("tlv.decode: wrong tlv");
        const first = data[pos++];
        const isLong = !!(first & 128);
        let length = 0;
        if (!isLong)
          length = first;
        else {
          const lenLen = first & 127;
          if (!lenLen)
            throw new E("tlv.decode(long): indefinite length not supported");
          if (lenLen > 4)
            throw new E("tlv.decode(long): byte length is too big");
          const lengthBytes = data.subarray(pos, pos + lenLen);
          if (lengthBytes.length !== lenLen)
            throw new E("tlv.decode: length bytes not complete");
          if (lengthBytes[0] === 0)
            throw new E("tlv.decode(long): zero leftmost byte");
          for (const b of lengthBytes)
            length = length << 8 | b;
          pos += lenLen;
          if (length < 128)
            throw new E("tlv.decode(long): not minimal encoding");
        }
        const v = data.subarray(pos, pos + length);
        if (v.length !== length)
          throw new E("tlv.decode: wrong value length");
        return { v, l: data.subarray(pos + length) };
      }
    },
    // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
    // since we always use positive integers here. It must always be empty:
    // - add zero byte if exists
    // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
    _int: {
      encode(num) {
        const { Err: E } = DER;
        abignumber(num);
        if (num < _0n4)
          throw new E("integer: negative integers are not allowed");
        let hex = numberToHexUnpadded(num);
        if (Number.parseInt(hex[0], 16) & 8)
          hex = "00" + hex;
        if (hex.length & 1)
          throw new E("unexpected DER parsing assertion: unpadded hex");
        return hex;
      },
      decode(data) {
        const { Err: E } = DER;
        if (data.length < 1)
          throw new E("invalid signature integer: empty");
        if (data[0] & 128)
          throw new E("invalid signature integer: negative");
        if (data.length > 1 && data[0] === 0 && !(data[1] & 128))
          throw new E("invalid signature integer: unnecessary leading zero");
        return bytesToNumberBE(data);
      }
    },
    toSig(bytes) {
      const { Err: E, _int: int, _tlv: tlv } = DER;
      const data = abytes2(bytes, void 0, "signature");
      const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
      if (seqLeftBytes.length)
        throw new E("invalid signature: left bytes after parsing");
      const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
      const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
      if (sLeftBytes.length)
        throw new E("invalid signature: left bytes after parsing");
      return { r: int.decode(rBytes), s: int.decode(sBytes) };
    },
    hexFromSig(sig) {
      const { _tlv: tlv, _int: int } = DER;
      const rs = tlv.encode(2, int.encode(sig.r));
      const ss = tlv.encode(2, int.encode(sig.s));
      const seq = rs + ss;
      return tlv.encode(48, seq);
    }
  };
  Object.freeze(DER._tlv);
  Object.freeze(DER._int);
  Object.freeze(DER);
  var _0n4 = /* @__PURE__ */ BigInt(0);
  var _1n4 = /* @__PURE__ */ BigInt(1);
  var _2n2 = /* @__PURE__ */ BigInt(2);
  var _3n2 = /* @__PURE__ */ BigInt(3);
  var _4n2 = /* @__PURE__ */ BigInt(4);
  function weierstrass(params, extraOpts = {}) {
    const validated = createCurveFields("weierstrass", params, extraOpts);
    const Fp = validated.Fp;
    const Fn = validated.Fn;
    let CURVE = validated.CURVE;
    const { h: cofactor, n: CURVE_ORDER } = CURVE;
    validateObject(extraOpts, {}, {
      allowInfinityPoint: "boolean",
      clearCofactor: "function",
      isTorsionFree: "function",
      fromBytes: "function",
      toBytes: "function",
      endo: "object"
    });
    const { endo, allowInfinityPoint } = extraOpts;
    if (endo) {
      if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {
        throw new Error('invalid endo: expected "beta": bigint and "basises": array');
      }
    }
    const lengths = getWLengths(Fp, Fn);
    function assertCompressionIsSupported() {
      if (!Fp.isOdd)
        throw new Error("compression is not supported: Field does not have .isOdd()");
    }
    function pointToBytes(_c, point, isCompressed) {
      if (allowInfinityPoint && point.is0())
        return Uint8Array.of(0);
      const { x, y } = point.toAffine();
      const bx = Fp.toBytes(x);
      abool(isCompressed, "isCompressed");
      if (isCompressed) {
        assertCompressionIsSupported();
        const hasEvenY = !Fp.isOdd(y);
        return concatBytes3(pprefix(hasEvenY), bx);
      } else {
        return concatBytes3(Uint8Array.of(4), bx, Fp.toBytes(y));
      }
    }
    function pointFromBytes(bytes) {
      abytes2(bytes, void 0, "Point");
      const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
      const length = bytes.length;
      const head = bytes[0];
      const tail = bytes.subarray(1);
      if (allowInfinityPoint && length === 1 && head === 0)
        return { x: Fp.ZERO, y: Fp.ZERO };
      if (length === comp && (head === 2 || head === 3)) {
        const x = Fp.fromBytes(tail);
        if (!Fp.isValid(x))
          throw new Error("bad point: is not on curve, wrong x");
        const y2 = weierstrassEquation(x);
        let y;
        try {
          y = Fp.sqrt(y2);
        } catch (sqrtError) {
          const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
          throw new Error("bad point: is not on curve, sqrt error" + err);
        }
        assertCompressionIsSupported();
        const evenY = Fp.isOdd(y);
        const evenH = (head & 1) === 1;
        if (evenH !== evenY)
          y = Fp.neg(y);
        return { x, y };
      } else if (length === uncomp && head === 4) {
        const L = Fp.BYTES;
        const x = Fp.fromBytes(tail.subarray(0, L));
        const y = Fp.fromBytes(tail.subarray(L, L * 2));
        if (!isValidXY(x, y))
          throw new Error("bad point: is not on curve");
        return { x, y };
      } else {
        throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
      }
    }
    const encodePoint = extraOpts.toBytes === void 0 ? pointToBytes : extraOpts.toBytes;
    const decodePoint = extraOpts.fromBytes === void 0 ? pointFromBytes : extraOpts.fromBytes;
    function weierstrassEquation(x) {
      const x2 = Fp.sqr(x);
      const x3 = Fp.mul(x2, x);
      return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
    }
    function isValidXY(x, y) {
      const left = Fp.sqr(y);
      const right = weierstrassEquation(x);
      return Fp.eql(left, right);
    }
    if (!isValidXY(CURVE.Gx, CURVE.Gy))
      throw new Error("bad curve params: generator point");
    const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);
    const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
    if (Fp.is0(Fp.add(_4a3, _27b2)))
      throw new Error("bad curve params: a or b");
    function acoord(title, n, banZero = false) {
      if (!Fp.isValid(n) || banZero && Fp.is0(n))
        throw new Error(`bad point coordinate ${title}`);
      return n;
    }
    function aprjpoint(other) {
      if (!(other instanceof Point))
        throw new Error("Weierstrass Point expected");
    }
    function splitEndoScalarN(k) {
      if (!endo || !endo.basises)
        throw new Error("no endo");
      return _splitEndoScalar(k, endo.basises, Fn.ORDER);
    }
    function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
      k2p = new Point(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
      k1p = negateCt(k1neg, k1p);
      k2p = negateCt(k2neg, k2p);
      return k1p.add(k2p);
    }
    class Point {
      // base / generator point
      static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
      // zero / infinity / identity point
      static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
      // 0, 1, 0
      // math field
      static Fp = Fp;
      // scalar field
      static Fn = Fn;
      X;
      Y;
      Z;
      /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
      constructor(X, Y, Z) {
        this.X = acoord("x", X);
        this.Y = acoord("y", Y, true);
        this.Z = acoord("z", Z);
        Object.freeze(this);
      }
      static CURVE() {
        return CURVE;
      }
      /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
      static fromAffine(p) {
        const { x, y } = p || {};
        if (!p || !Fp.isValid(x) || !Fp.isValid(y))
          throw new Error("invalid affine point");
        if (p instanceof Point)
          throw new Error("projective point not allowed");
        if (Fp.is0(x) && Fp.is0(y))
          return Point.ZERO;
        return new Point(x, y, Fp.ONE);
      }
      static fromBytes(bytes) {
        const P = Point.fromAffine(decodePoint(abytes2(bytes, void 0, "point")));
        P.assertValidity();
        return P;
      }
      static fromHex(hex) {
        return Point.fromBytes(hexToBytes3(hex));
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      /**
       *
       * @param windowSize
       * @param isLazy - true will defer table computation until the first multiplication
       * @returns
       */
      precompute(windowSize = 8, isLazy = true) {
        wnaf.createCache(this, windowSize);
        if (!isLazy)
          this.multiply(_3n2);
        return this;
      }
      // TODO: return `this`
      /** A point on curve is valid if it conforms to equation. */
      assertValidity() {
        const p = this;
        if (p.is0()) {
          if (extraOpts.allowInfinityPoint && Fp.is0(p.X) && Fp.eql(p.Y, Fp.ONE) && Fp.is0(p.Z))
            return;
          throw new Error("bad point: ZERO");
        }
        const { x, y } = p.toAffine();
        if (!Fp.isValid(x) || !Fp.isValid(y))
          throw new Error("bad point: x or y not field elements");
        if (!isValidXY(x, y))
          throw new Error("bad point: equation left != right");
        if (!p.isTorsionFree())
          throw new Error("bad point: not in prime-order subgroup");
      }
      hasEvenY() {
        const { y } = this.toAffine();
        if (!Fp.isOdd)
          throw new Error("Field doesn't support isOdd");
        return !Fp.isOdd(y);
      }
      /** Compare one point to another. */
      equals(other) {
        aprjpoint(other);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const { X: X2, Y: Y2, Z: Z2 } = other;
        const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
        const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
        return U1 && U2;
      }
      /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
      negate() {
        return new Point(this.X, Fp.neg(this.Y), this.Z);
      }
      // Renes-Costello-Batina exception-free doubling formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 3
      // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
      double() {
        const { a, b } = CURVE;
        const b3 = Fp.mul(b, _3n2);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
        let t0 = Fp.mul(X1, X1);
        let t1 = Fp.mul(Y1, Y1);
        let t2 = Fp.mul(Z1, Z1);
        let t3 = Fp.mul(X1, Y1);
        t3 = Fp.add(t3, t3);
        Z3 = Fp.mul(X1, Z1);
        Z3 = Fp.add(Z3, Z3);
        X3 = Fp.mul(a, Z3);
        Y3 = Fp.mul(b3, t2);
        Y3 = Fp.add(X3, Y3);
        X3 = Fp.sub(t1, Y3);
        Y3 = Fp.add(t1, Y3);
        Y3 = Fp.mul(X3, Y3);
        X3 = Fp.mul(t3, X3);
        Z3 = Fp.mul(b3, Z3);
        t2 = Fp.mul(a, t2);
        t3 = Fp.sub(t0, t2);
        t3 = Fp.mul(a, t3);
        t3 = Fp.add(t3, Z3);
        Z3 = Fp.add(t0, t0);
        t0 = Fp.add(Z3, t0);
        t0 = Fp.add(t0, t2);
        t0 = Fp.mul(t0, t3);
        Y3 = Fp.add(Y3, t0);
        t2 = Fp.mul(Y1, Z1);
        t2 = Fp.add(t2, t2);
        t0 = Fp.mul(t2, t3);
        X3 = Fp.sub(X3, t0);
        Z3 = Fp.mul(t2, t1);
        Z3 = Fp.add(Z3, Z3);
        Z3 = Fp.add(Z3, Z3);
        return new Point(X3, Y3, Z3);
      }
      // Renes-Costello-Batina exception-free addition formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 1
      // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
      add(other) {
        aprjpoint(other);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const { X: X2, Y: Y2, Z: Z2 } = other;
        let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
        const a = CURVE.a;
        const b3 = Fp.mul(CURVE.b, _3n2);
        let t0 = Fp.mul(X1, X2);
        let t1 = Fp.mul(Y1, Y2);
        let t2 = Fp.mul(Z1, Z2);
        let t3 = Fp.add(X1, Y1);
        let t4 = Fp.add(X2, Y2);
        t3 = Fp.mul(t3, t4);
        t4 = Fp.add(t0, t1);
        t3 = Fp.sub(t3, t4);
        t4 = Fp.add(X1, Z1);
        let t5 = Fp.add(X2, Z2);
        t4 = Fp.mul(t4, t5);
        t5 = Fp.add(t0, t2);
        t4 = Fp.sub(t4, t5);
        t5 = Fp.add(Y1, Z1);
        X3 = Fp.add(Y2, Z2);
        t5 = Fp.mul(t5, X3);
        X3 = Fp.add(t1, t2);
        t5 = Fp.sub(t5, X3);
        Z3 = Fp.mul(a, t4);
        X3 = Fp.mul(b3, t2);
        Z3 = Fp.add(X3, Z3);
        X3 = Fp.sub(t1, Z3);
        Z3 = Fp.add(t1, Z3);
        Y3 = Fp.mul(X3, Z3);
        t1 = Fp.add(t0, t0);
        t1 = Fp.add(t1, t0);
        t2 = Fp.mul(a, t2);
        t4 = Fp.mul(b3, t4);
        t1 = Fp.add(t1, t2);
        t2 = Fp.sub(t0, t2);
        t2 = Fp.mul(a, t2);
        t4 = Fp.add(t4, t2);
        t0 = Fp.mul(t1, t4);
        Y3 = Fp.add(Y3, t0);
        t0 = Fp.mul(t5, t4);
        X3 = Fp.mul(t3, X3);
        X3 = Fp.sub(X3, t0);
        t0 = Fp.mul(t3, t1);
        Z3 = Fp.mul(t5, Z3);
        Z3 = Fp.add(Z3, t0);
        return new Point(X3, Y3, Z3);
      }
      subtract(other) {
        aprjpoint(other);
        return this.add(other.negate());
      }
      is0() {
        return this.equals(Point.ZERO);
      }
      /**
       * Constant time multiplication.
       * Uses wNAF method. Windowed method may be 10% faster,
       * but takes 2x longer to generate and consumes 2x memory.
       * Uses precomputes when available.
       * Uses endomorphism for Koblitz curves.
       * @param scalar - by which the point would be multiplied
       * @returns New point
       */
      multiply(scalar) {
        const { endo: endo2 } = extraOpts;
        if (!Fn.isValidNot0(scalar))
          throw new RangeError("invalid scalar: out of range");
        let point, fake;
        const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point, p));
        if (endo2) {
          const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
          const { p: k1p, f: k1f } = mul(k1);
          const { p: k2p, f: k2f } = mul(k2);
          fake = k1f.add(k2f);
          point = finishEndo(endo2.beta, k1p, k2p, k1neg, k2neg);
        } else {
          const { p, f } = mul(scalar);
          point = p;
          fake = f;
        }
        return normalizeZ(Point, [point, fake])[0];
      }
      /**
       * Non-constant-time multiplication. Uses double-and-add algorithm.
       * It's faster, but should only be used when you don't care about
       * an exposed secret key e.g. sig verification, which works over *public* keys.
       */
      multiplyUnsafe(scalar) {
        const { endo: endo2 } = extraOpts;
        const p = this;
        const sc = scalar;
        if (!Fn.isValid(sc))
          throw new RangeError("invalid scalar: out of range");
        if (sc === _0n4 || p.is0())
          return Point.ZERO;
        if (sc === _1n4)
          return p;
        if (wnaf.hasCache(this))
          return this.multiply(sc);
        if (endo2) {
          const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
          const { p1, p2 } = mulEndoUnsafe(Point, p, k1, k2);
          return finishEndo(endo2.beta, p1, p2, k1neg, k2neg);
        } else {
          return wnaf.unsafe(p, sc);
        }
      }
      /**
       * Converts Projective point to affine (x, y) coordinates.
       * (X, Y, Z) ∋ (x=X/Z, y=Y/Z).
       * @param invertedZ - Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
       */
      toAffine(invertedZ) {
        const p = this;
        let iz = invertedZ;
        const { X, Y, Z } = p;
        if (Fp.eql(Z, Fp.ONE))
          return { x: X, y: Y };
        const is0 = p.is0();
        if (iz == null)
          iz = is0 ? Fp.ONE : Fp.inv(Z);
        const x = Fp.mul(X, iz);
        const y = Fp.mul(Y, iz);
        const zz = Fp.mul(Z, iz);
        if (is0)
          return { x: Fp.ZERO, y: Fp.ZERO };
        if (!Fp.eql(zz, Fp.ONE))
          throw new Error("invZ was invalid");
        return { x, y };
      }
      /**
       * Checks whether Point is free of torsion elements (is in prime subgroup).
       * Always torsion-free for cofactor=1 curves.
       */
      isTorsionFree() {
        const { isTorsionFree } = extraOpts;
        if (cofactor === _1n4)
          return true;
        if (isTorsionFree)
          return isTorsionFree(Point, this);
        return wnaf.unsafe(this, CURVE_ORDER).is0();
      }
      clearCofactor() {
        const { clearCofactor } = extraOpts;
        if (cofactor === _1n4)
          return this;
        if (clearCofactor)
          return clearCofactor(Point, this);
        return this.multiplyUnsafe(cofactor);
      }
      isSmallOrder() {
        if (cofactor === _1n4)
          return this.is0();
        return this.clearCofactor().is0();
      }
      toBytes(isCompressed = true) {
        abool(isCompressed, "isCompressed");
        this.assertValidity();
        return encodePoint(Point, this, isCompressed);
      }
      toHex(isCompressed = true) {
        return bytesToHex3(this.toBytes(isCompressed));
      }
      toString() {
        return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
      }
    }
    const bits = Fn.BITS;
    const wnaf = new wNAF(Point, extraOpts.endo ? Math.ceil(bits / 2) : bits);
    if (bits >= 8)
      Point.BASE.precompute(8);
    Object.freeze(Point.prototype);
    Object.freeze(Point);
    return Point;
  }
  function pprefix(hasEvenY) {
    return Uint8Array.of(hasEvenY ? 2 : 3);
  }
  function getWLengths(Fp, Fn) {
    return {
      secretKey: Fn.BYTES,
      publicKey: 1 + Fp.BYTES,
      publicKeyUncompressed: 1 + 2 * Fp.BYTES,
      publicKeyHasPrefix: true,
      // Raw compact `(r || s)` signature width; DER and recovered signatures use
      // different lengths outside this helper.
      signature: 2 * Fn.BYTES
    };
  }
  function ecdh(Point, ecdhOpts = {}) {
    const { Fn } = Point;
    const randomBytes_ = ecdhOpts.randomBytes === void 0 ? randomBytes2 : ecdhOpts.randomBytes;
    const lengths = Object.assign(getWLengths(Point.Fp, Fn), {
      seed: Math.max(getMinHashLength(Fn.ORDER), 16)
    });
    function isValidSecretKey(secretKey) {
      try {
        const num = Fn.fromBytes(secretKey);
        return Fn.isValidNot0(num);
      } catch (error) {
        return false;
      }
    }
    function isValidPublicKey(publicKey, isCompressed) {
      const { publicKey: comp, publicKeyUncompressed } = lengths;
      try {
        const l = publicKey.length;
        if (isCompressed === true && l !== comp)
          return false;
        if (isCompressed === false && l !== publicKeyUncompressed)
          return false;
        return !!Point.fromBytes(publicKey);
      } catch (error) {
        return false;
      }
    }
    function randomSecretKey(seed) {
      seed = seed === void 0 ? randomBytes_(lengths.seed) : seed;
      return mapHashToField(abytes2(seed, lengths.seed, "seed"), Fn.ORDER);
    }
    function getPublicKey(secretKey, isCompressed = true) {
      return Point.BASE.multiply(Fn.fromBytes(secretKey)).toBytes(isCompressed);
    }
    function isProbPub(item) {
      const { secretKey, publicKey, publicKeyUncompressed } = lengths;
      const allowedLengths = Fn._lengths;
      if (!isBytes2(item))
        return void 0;
      const l = abytes2(item, void 0, "key").length;
      const isPub = l === publicKey || l === publicKeyUncompressed;
      const isSec = l === secretKey || !!allowedLengths?.includes(l);
      if (isPub && isSec)
        return void 0;
      return isPub;
    }
    function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
      if (isProbPub(secretKeyA) === true)
        throw new Error("first arg must be private key");
      if (isProbPub(publicKeyB) === false)
        throw new Error("second arg must be public key");
      const s = Fn.fromBytes(secretKeyA);
      const b = Point.fromBytes(publicKeyB);
      return b.multiply(s).toBytes(isCompressed);
    }
    const utils = {
      isValidSecretKey,
      isValidPublicKey,
      randomSecretKey
    };
    const keygen = createKeygen(randomSecretKey, getPublicKey);
    Object.freeze(utils);
    Object.freeze(lengths);
    return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point, utils, lengths });
  }
  function ecdsa(Point, hash, ecdsaOpts = {}) {
    const hash_ = hash;
    ahash(hash_);
    validateObject(ecdsaOpts, {}, {
      hmac: "function",
      lowS: "boolean",
      randomBytes: "function",
      bits2int: "function",
      bits2int_modN: "function"
    });
    ecdsaOpts = Object.assign({}, ecdsaOpts);
    const randomBytes3 = ecdsaOpts.randomBytes === void 0 ? randomBytes2 : ecdsaOpts.randomBytes;
    const hmac2 = ecdsaOpts.hmac === void 0 ? (key, msg) => hmac(hash_, key, msg) : ecdsaOpts.hmac;
    const { Fp, Fn } = Point;
    const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;
    const { keygen, getPublicKey, getSharedSecret, utils, lengths } = ecdh(Point, ecdsaOpts);
    const defaultSigOpts = {
      prehash: true,
      lowS: typeof ecdsaOpts.lowS === "boolean" ? ecdsaOpts.lowS : true,
      format: "compact",
      extraEntropy: false
    };
    const hasLargeRecoveryLifts = CURVE_ORDER * _2n2 + _1n4 < Fp.ORDER;
    function isBiggerThanHalfOrder(number) {
      const HALF = CURVE_ORDER >> _1n4;
      return number > HALF;
    }
    function validateRS(title, num) {
      if (!Fn.isValidNot0(num))
        throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
      return num;
    }
    function assertRecoverableCurve() {
      if (hasLargeRecoveryLifts)
        throw new Error('"recovered" sig type is not supported for cofactor >2 curves');
    }
    function validateSigLength(bytes, format) {
      validateSigFormat(format);
      const size = lengths.signature;
      const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : void 0;
      return abytes2(bytes, sizer);
    }
    class Signature {
      r;
      s;
      recovery;
      constructor(r, s, recovery) {
        this.r = validateRS("r", r);
        this.s = validateRS("s", s);
        if (recovery != null) {
          assertRecoverableCurve();
          if (![0, 1, 2, 3].includes(recovery))
            throw new Error("invalid recovery id");
          this.recovery = recovery;
        }
        Object.freeze(this);
      }
      static fromBytes(bytes, format = defaultSigOpts.format) {
        validateSigLength(bytes, format);
        let recid;
        if (format === "der") {
          const { r: r2, s: s2 } = DER.toSig(abytes2(bytes));
          return new Signature(r2, s2);
        }
        if (format === "recovered") {
          recid = bytes[0];
          format = "compact";
          bytes = bytes.subarray(1);
        }
        const L = lengths.signature / 2;
        const r = bytes.subarray(0, L);
        const s = bytes.subarray(L, L * 2);
        return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);
      }
      static fromHex(hex, format) {
        return this.fromBytes(hexToBytes3(hex), format);
      }
      assertRecovery() {
        const { recovery } = this;
        if (recovery == null)
          throw new Error("invalid recovery id: must be present");
        return recovery;
      }
      addRecoveryBit(recovery) {
        return new Signature(this.r, this.s, recovery);
      }
      // Unlike the top-level helper below, this method expects a digest that has
      // already been hashed to the curve's message representative.
      recoverPublicKey(messageHash) {
        const { r, s } = this;
        const recovery = this.assertRecovery();
        const radj = recovery === 2 || recovery === 3 ? r + CURVE_ORDER : r;
        if (!Fp.isValid(radj))
          throw new Error("invalid recovery id: sig.r+curve.n != R.x");
        const x = Fp.toBytes(radj);
        const R = Point.fromBytes(concatBytes3(pprefix((recovery & 1) === 0), x));
        const ir = Fn.inv(radj);
        const h = bits2int_modN(abytes2(messageHash, void 0, "msgHash"));
        const u1 = Fn.create(-h * ir);
        const u2 = Fn.create(s * ir);
        const Q = Point.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));
        if (Q.is0())
          throw new Error("invalid recovery: point at infinify");
        Q.assertValidity();
        return Q;
      }
      // Signatures should be low-s, to prevent malleability.
      hasHighS() {
        return isBiggerThanHalfOrder(this.s);
      }
      toBytes(format = defaultSigOpts.format) {
        validateSigFormat(format);
        if (format === "der")
          return hexToBytes3(DER.hexFromSig(this));
        const { r, s } = this;
        const rb = Fn.toBytes(r);
        const sb = Fn.toBytes(s);
        if (format === "recovered") {
          assertRecoverableCurve();
          return concatBytes3(Uint8Array.of(this.assertRecovery()), rb, sb);
        }
        return concatBytes3(rb, sb);
      }
      toHex(format) {
        return bytesToHex3(this.toBytes(format));
      }
    }
    Object.freeze(Signature.prototype);
    Object.freeze(Signature);
    const bits2int = ecdsaOpts.bits2int === void 0 ? function bits2int_def(bytes) {
      if (bytes.length > 8192)
        throw new Error("input is too large");
      const num = bytesToNumberBE(bytes);
      const delta = bytes.length * 8 - fnBits;
      return delta > 0 ? num >> BigInt(delta) : num;
    } : ecdsaOpts.bits2int;
    const bits2int_modN = ecdsaOpts.bits2int_modN === void 0 ? function bits2int_modN_def(bytes) {
      return Fn.create(bits2int(bytes));
    } : ecdsaOpts.bits2int_modN;
    const ORDER_MASK = bitMask(fnBits);
    function int2octets(num) {
      aInRange("num < 2^" + fnBits, num, _0n4, ORDER_MASK);
      return Fn.toBytes(num);
    }
    function validateMsgAndHash(message, prehash) {
      abytes2(message, void 0, "message");
      return prehash ? abytes2(hash_(message), void 0, "prehashed message") : message;
    }
    function prepSig(message, secretKey, opts) {
      const { lowS, prehash, extraEntropy } = validateSigOpts(opts, defaultSigOpts);
      message = validateMsgAndHash(message, prehash);
      const h1int = bits2int_modN(message);
      const d = Fn.fromBytes(secretKey);
      if (!Fn.isValidNot0(d))
        throw new Error("invalid private key");
      const seedArgs = [int2octets(d), int2octets(h1int)];
      if (extraEntropy != null && extraEntropy !== false) {
        const e = extraEntropy === true ? randomBytes3(lengths.secretKey) : extraEntropy;
        seedArgs.push(abytes2(e, void 0, "extraEntropy"));
      }
      const seed = concatBytes3(...seedArgs);
      const m = h1int;
      function k2sig(kBytes) {
        const k = bits2int(kBytes);
        if (!Fn.isValidNot0(k))
          return;
        const ik = Fn.inv(k);
        const q = Point.BASE.multiply(k).toAffine();
        const r = Fn.create(q.x);
        if (r === _0n4)
          return;
        const s = Fn.create(ik * Fn.create(m + r * d));
        if (s === _0n4)
          return;
        let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n4);
        let normS = s;
        if (lowS && isBiggerThanHalfOrder(s)) {
          normS = Fn.neg(s);
          recovery ^= 1;
        }
        return new Signature(r, normS, hasLargeRecoveryLifts ? void 0 : recovery);
      }
      return { seed, k2sig };
    }
    function sign(message, secretKey, opts = {}) {
      const { seed, k2sig } = prepSig(message, secretKey, opts);
      const drbg = createHmacDrbg(hash_.outputLen, Fn.BYTES, hmac2);
      const sig = drbg(seed, k2sig);
      return sig.toBytes(opts.format);
    }
    function verify(signature, message, publicKey, opts = {}) {
      const { lowS, prehash, format } = validateSigOpts(opts, defaultSigOpts);
      publicKey = abytes2(publicKey, void 0, "publicKey");
      message = validateMsgAndHash(message, prehash);
      if (!isBytes2(signature)) {
        const end = signature instanceof Signature ? ", use sig.toBytes()" : "";
        throw new Error("verify expects Uint8Array signature" + end);
      }
      validateSigLength(signature, format);
      try {
        const sig = Signature.fromBytes(signature, format);
        const P = Point.fromBytes(publicKey);
        if (lowS && sig.hasHighS())
          return false;
        const { r, s } = sig;
        const h = bits2int_modN(message);
        const is = Fn.inv(s);
        const u1 = Fn.create(h * is);
        const u2 = Fn.create(r * is);
        const R = Point.BASE.multiplyUnsafe(u1).add(P.multiplyUnsafe(u2));
        if (R.is0())
          return false;
        const v = Fn.create(R.x);
        return v === r;
      } catch (e) {
        return false;
      }
    }
    function recoverPublicKey(signature, message, opts = {}) {
      const { prehash } = validateSigOpts(opts, defaultSigOpts);
      message = validateMsgAndHash(message, prehash);
      return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
    }
    return Object.freeze({
      keygen,
      getPublicKey,
      getSharedSecret,
      utils,
      lengths,
      Point,
      sign,
      verify,
      recoverPublicKey,
      Signature,
      hash: hash_
    });
  }

  // node_modules/@noble/curves/secp256k1.js
  var secp256k1_CURVE = {
    p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
    n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
    h: BigInt(1),
    a: BigInt(0),
    b: BigInt(7),
    Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
    Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
  };
  var secp256k1_ENDO = {
    beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
    basises: [
      [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
      [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
    ]
  };
  var _2n3 = /* @__PURE__ */ BigInt(2);
  function sqrtMod(y) {
    const P = secp256k1_CURVE.p;
    const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
    const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
    const b2 = y * y * y % P;
    const b3 = b2 * b2 * y % P;
    const b6 = pow2(b3, _3n3, P) * b3 % P;
    const b9 = pow2(b6, _3n3, P) * b3 % P;
    const b11 = pow2(b9, _2n3, P) * b2 % P;
    const b22 = pow2(b11, _11n, P) * b11 % P;
    const b44 = pow2(b22, _22n, P) * b22 % P;
    const b88 = pow2(b44, _44n, P) * b44 % P;
    const b176 = pow2(b88, _88n, P) * b88 % P;
    const b220 = pow2(b176, _44n, P) * b44 % P;
    const b223 = pow2(b220, _3n3, P) * b3 % P;
    const t1 = pow2(b223, _23n, P) * b22 % P;
    const t2 = pow2(t1, _6n, P) * b2 % P;
    const root = pow2(t2, _2n3, P);
    if (!Fpk1.eql(Fpk1.sqr(root), y))
      throw new Error("Cannot find square root");
    return root;
  }
  var Fpk1 = Field(secp256k1_CURVE.p, { sqrt: sqrtMod });
  var Pointk1 = /* @__PURE__ */ weierstrass(secp256k1_CURVE, {
    Fp: Fpk1,
    endo: secp256k1_ENDO
  });
  var secp256k1 = /* @__PURE__ */ ecdsa(Pointk1, sha256);

  // packages/core/src/taproot.ts
  var TAPROOT_ANNEX_PREFIX = 80;
  var N = secp256k1.Point.Fn.ORDER;
  function parseControlBlock(bytes) {
    if (bytes.length < 33 || (bytes.length - 33) % 32 !== 0) {
      throw new Error(`invalid control block length ${bytes.length}`);
    }
    const depth = (bytes.length - 33) / 32;
    if (depth > 128) throw new Error("control block merkle path too deep");
    const path = [];
    for (let i = 0; i < depth; i++) {
      path.push(bytes.slice(33 + i * 32, 33 + (i + 1) * 32));
    }
    return {
      leafVersion: bytes[0] & 254,
      outputKeyParity: bytes[0] & 1,
      internalKey: bytes.slice(1, 33),
      path
    };
  }
  function tapLeafHash(script, leafVersion = 192) {
    const w = new ByteWriter();
    w.writeU8(leafVersion);
    w.writeVarInt(script.length);
    w.writeBytes(script);
    return taggedHash("TapLeaf", w.toBytes());
  }
  function tapBranch(a, b) {
    let swap = false;
    for (let i = 0; i < 32; i++) {
      if (a[i] !== b[i]) {
        swap = a[i] > b[i];
        break;
      }
    }
    return swap ? taggedHash("TapBranch", concatBytes(b, a)) : taggedHash("TapBranch", concatBytes(a, b));
  }
  function tapMerkleRoot(leafHash, path) {
    let k = leafHash;
    for (const node of path) k = tapBranch(k, node);
    return k;
  }
  function isP2TR(spk) {
    return spk.length === 34 && spk[0] === 81 && spk[1] === 32;
  }
  function verifyScriptPathCommitment(args) {
    const { script, scriptPubKey } = args;
    if (!isP2TR(scriptPubKey)) throw new Error("spent output is not P2TR");
    const outputKey = scriptPubKey.slice(2, 34);
    const cb = args.controlBlock instanceof Uint8Array ? parseControlBlock(args.controlBlock) : args.controlBlock;
    const leafHash = tapLeafHash(script, cb.leafVersion);
    const merkleRoot = tapMerkleRoot(leafHash, cb.path);
    const tweak = beBytesToBigInt(taggedHash("TapTweak", concatBytes(cb.internalKey, merkleRoot)));
    if (tweak >= N) throw new Error("tap tweak >= curve order");
    let P;
    try {
      P = secp256k1.Point.fromBytes(concatBytes(new Uint8Array([2]), cb.internalKey));
    } catch {
      throw new Error("internal key is not a valid x-only point");
    }
    const Q = P.add(secp256k1.Point.BASE.multiply(tweak));
    if (Q.is0()) throw new Error("derived output key is point at infinity");
    const qBytes = Q.toBytes(true);
    const parity = qBytes[0] === 3 ? 1 : 0;
    if (!bytesEqual(qBytes.slice(1), outputKey)) {
      throw new Error("taproot commitment mismatch: derived output key != scriptPubKey key");
    }
    if (parity !== cb.outputKeyParity) {
      throw new Error("taproot commitment mismatch: output key parity");
    }
    return { outputKey, leafHash, merkleRoot };
  }
  function extractTapscript(witness) {
    let stack = witness;
    if (stack.length >= 2 && stack[stack.length - 1].length > 0 && stack[stack.length - 1][0] === TAPROOT_ANNEX_PREFIX) {
      stack = stack.slice(0, -1);
    }
    if (stack.length < 2) return void 0;
    return {
      script: stack[stack.length - 2],
      controlBlock: stack[stack.length - 1]
    };
  }

  // packages/core/src/witnesscommit.ts
  var COMMITMENT_HEADER = new Uint8Array([106, 36, 170, 33, 169, 237]);
  var ZERO32 = new Uint8Array(32);
  function findWitnessCommitment(coinbase) {
    if (!isCoinbase(coinbase)) throw new Error("not a coinbase transaction");
    for (let i = coinbase.outputs.length - 1; i >= 0; i--) {
      const spk = coinbase.outputs[i].scriptPubKey;
      if (spk.length >= 38 && bytesEqual(spk.slice(0, 6), COMMITMENT_HEADER)) {
        return spk.slice(6, 38);
      }
    }
    return void 0;
  }
  function witnessReservedValue(coinbase) {
    const witness = coinbase.inputs[0]?.witness ?? [];
    if (witness.length !== 1 || witness[0].length !== 32) {
      throw new Error("coinbase witness must be exactly one 32-byte reserved value");
    }
    return witness[0];
  }
  function computeWitnessCommitment(witnessRoot, reserved) {
    return sha256d(concatBytes(witnessRoot, reserved));
  }

  // packages/core/src/envelope.ts
  var TAG_CONTENT_TYPE = 1;
  var TAG_POINTER = 2;
  var TAG_PARENT = 3;
  var TAG_METADATA = 5;
  var TAG_METAPROTOCOL = 7;
  var TAG_CONTENT_ENCODING = 9;
  var TAG_DELEGATE = 11;
  var TAG_RUNE = 13;
  var TAG_PROPERTIES = 17;
  var TAG_PROPERTY_ENCODING = 19;
  var ORD_MARKER = new Uint8Array([111, 114, 100]);
  function isEmptyPush(op) {
    return op.data !== void 0 && op.data.length === 0;
  }
  function isOrdMarker(op) {
    return op.data !== void 0 && op.data.length === 3 && op.data[0] === ORD_MARKER[0] && op.data[1] === ORD_MARKER[1] && op.data[2] === ORD_MARKER[2];
  }
  function payloadBytes(op) {
    if (op.data !== void 0) return { bytes: op.data, pushnum: false };
    if (op.opcode === OP_1NEGATE) return { bytes: new Uint8Array([129]), pushnum: true };
    if (op.opcode >= OP_1 && op.opcode <= OP_16) {
      return { bytes: new Uint8Array([op.opcode - OP_1 + 1]), pushnum: true };
    }
    return void 0;
  }
  function isOp(op, opcode) {
    return op !== void 0 && op.data === void 0 && op.opcode === opcode;
  }
  function fromInstructions(ops, cursor, stutter) {
    if (!isOp(ops[cursor], OP_IF)) {
      return { cursor, stutter: ops[cursor] !== void 0 && isEmptyPush(ops[cursor]) };
    }
    cursor++;
    if (ops[cursor] === void 0 || !isOrdMarker(ops[cursor])) {
      return { cursor, stutter: ops[cursor] !== void 0 && isEmptyPush(ops[cursor]) };
    }
    cursor++;
    const payload = [];
    let pushnum = false;
    for (; ; ) {
      const op = ops[cursor];
      if (op === void 0) return { cursor, stutter: false };
      cursor++;
      if (isOp(op, OP_ENDIF)) {
        return { cursor, stutter: false, envelope: { payload, pushnum, stutter } };
      }
      const decoded = payloadBytes(op);
      if (!decoded) return { cursor, stutter: false };
      payload.push(decoded.bytes);
      pushnum ||= decoded.pushnum;
    }
  }
  function parseEnvelopesFromScript(script) {
    let ops;
    try {
      ops = parseScript(script);
    } catch {
      return [];
    }
    const envelopes = [];
    let stuttered = false;
    let cursor = 0;
    while (cursor < ops.length) {
      const instruction = ops[cursor++];
      if (!isEmptyPush(instruction)) continue;
      const attempt = fromInstructions(ops, cursor, stuttered);
      cursor = attempt.cursor;
      if (attempt.envelope) {
        envelopes.push(attempt.envelope);
      } else {
        stuttered = attempt.stutter;
      }
    }
    return envelopes;
  }
  function parseEnvelopesFromTx(tx) {
    const out = [];
    let index = 0;
    for (let vin = 0; vin < tx.inputs.length; vin++) {
      const tapscript = extractTapscript(tx.inputs[vin].witness);
      if (!tapscript) continue;
      let offsetInInput = 0;
      for (const env of parseEnvelopesFromScript(tapscript.script)) {
        out.push({ ...env, input: vin, offsetInInput: offsetInInput++, index: index++ });
      }
    }
    return out;
  }
  function splitPayload(payload) {
    const fields = [];
    let bodyChunks;
    let incompleteField = false;
    for (let i = 0; i < payload.length; i += 2) {
      const tag = payload[i];
      if (tag.length === 0) {
        bodyChunks = payload.slice(i + 1);
        break;
      }
      const value = payload[i + 1];
      if (value === void 0) {
        incompleteField = true;
        break;
      }
      fields.push([tag, value]);
    }
    const seen = /* @__PURE__ */ new Set();
    let duplicateField = false;
    for (const [tag] of fields) {
      const key = bytesToHex(tag);
      if (seen.has(key)) duplicateField = true;
      seen.add(key);
    }
    return { fields, bodyChunks, incompleteField, duplicateField };
  }
  function parseInscriptionIdValue(value) {
    if (value.length < 32 || value.length > 36) return void 0;
    if (value.length > 32 && value[value.length - 1] === 0) return void 0;
    const txidLE = value.slice(0, 32);
    let index = 0;
    for (let i = value.length - 1; i >= 32; i--) {
      index = index * 256 + value[i];
    }
    return formatInscriptionId(internalToDisplay(txidLE), index);
  }
  function decodeLeU64Trimmed(value) {
    for (let i = 8; i < value.length; i++) {
      if (value[i] !== 0) return void 0;
    }
    let v = 0n;
    const len = Math.min(value.length, 8);
    for (let i = len - 1; i >= 0; i--) v = v << 8n | BigInt(value[i]);
    return v;
  }
  var utf8 = new TextDecoder("utf-8", { fatal: false });
  function interpretEnvelope(env) {
    const { fields, bodyChunks, incompleteField, duplicateField } = splitPayload(env.payload);
    const byKey = /* @__PURE__ */ new Map();
    for (const [tag, value] of fields) {
      const key = bytesToHex(tag);
      const entry = byKey.get(key) ?? { tag, values: [] };
      entry.values.push(value);
      byKey.set(key, entry);
    }
    const keyOf = (tag) => bytesToHex(new Uint8Array([tag]));
    const takeFirst = (tag) => {
      const entry = byKey.get(keyOf(tag));
      if (!entry || entry.values.length === 0) return void 0;
      const [first, ...rest] = entry.values;
      if (rest.length === 0) byKey.delete(keyOf(tag));
      else byKey.set(keyOf(tag), { tag: entry.tag, values: rest });
      return first;
    };
    const takeChunked = (tag) => {
      const entry = byKey.get(keyOf(tag));
      if (!entry) return void 0;
      byKey.delete(keyOf(tag));
      return concatBytes(...entry.values);
    };
    const takeArray = (tag) => {
      const entry = byKey.get(keyOf(tag));
      if (!entry) return [];
      byKey.delete(keyOf(tag));
      return entry.values;
    };
    const contentTypeBytes = takeFirst(TAG_CONTENT_TYPE);
    const pointerRaw = takeFirst(TAG_POINTER);
    const parentValues = takeArray(TAG_PARENT);
    const metadata = takeChunked(TAG_METADATA);
    const metaprotocolRaw = takeFirst(TAG_METAPROTOCOL);
    const contentEncodingRaw = takeFirst(TAG_CONTENT_ENCODING);
    const delegateRaw = takeFirst(TAG_DELEGATE);
    const rune = takeFirst(TAG_RUNE);
    const properties = takeChunked(TAG_PROPERTIES);
    const propertyEncodingRaw = takeFirst(TAG_PROPERTY_ENCODING);
    let unrecognizedEvenField = false;
    for (const { tag } of byKey.values()) {
      if (tag.length > 0 && (tag[0] & 1) === 0) unrecognizedEvenField = true;
    }
    const parents = [];
    for (const value of parentValues) {
      const id = parseInscriptionIdValue(value);
      if (id) parents.push(id);
    }
    const pointer = pointerRaw ? decodeLeU64Trimmed(pointerRaw) : void 0;
    return {
      index: env.index,
      input: env.input,
      contentType: contentTypeBytes ? utf8.decode(contentTypeBytes) : void 0,
      contentTypeBytes,
      body: bodyChunks ? concatBytes(...bodyChunks) : void 0,
      contentEncoding: contentEncodingRaw ? utf8.decode(contentEncodingRaw) : void 0,
      metaprotocol: metaprotocolRaw ? utf8.decode(metaprotocolRaw) : void 0,
      metadata,
      properties,
      propertyEncoding: propertyEncodingRaw ? utf8.decode(propertyEncodingRaw) : void 0,
      pointer,
      parents,
      delegate: delegateRaw ? parseInscriptionIdValue(delegateRaw) : void 0,
      rune,
      flags: {
        incompleteField,
        duplicateField,
        unrecognizedEvenField,
        pushnum: env.pushnum,
        stutter: env.stutter
      },
      unboundByEvenField: unrecognizedEvenField
    };
  }
  function inscriptionsFromTx(tx) {
    return parseEnvelopesFromTx(tx).map(interpretEnvelope);
  }

  // packages/core/src/proof.ts
  function parseHexTx(hex, label) {
    let tx;
    try {
      tx = parseTx(hexToBytes(hex.trim()));
    } catch (e) {
      throw new Error(`${label}: cannot parse transaction: ${e.message}`);
    }
    if (tx.raw.length === 64) throw new Error(`${label}: 64-byte transactions are rejected (leaf/node ambiguity)`);
    return tx;
  }
  function verifyProofBundle(bundle, opts = {}) {
    if (bundle.version !== 1) throw new Error(`unsupported proof bundle version ${bundle.version}`);
    const id = parseInscriptionId(bundle.inscriptionId);
    const header = parseHeader(hexToBytes(bundle.block.header));
    if (header.hash !== bundle.block.hash.toLowerCase()) {
      throw new Error(`header hashes to ${header.hash}, bundle claims ${bundle.block.hash}`);
    }
    if (!checkProofOfWork(header)) throw new Error("header fails proof of work");
    if (!Number.isInteger(bundle.block.txCount) || bundle.block.txCount < 1) {
      throw new Error("bundle missing valid txCount");
    }
    opts.trustHeader?.(header, bundle.block.height);
    const reveal = parseHexTx(bundle.reveal.hex, "reveal");
    if (reveal.txid !== id.txid) {
      throw new Error(`reveal tx hashes to ${reveal.txid}, inscription id says ${id.txid}`);
    }
    const txidBranch = bundle.reveal.txidBranch.map(displayToInternal);
    const expectedHeight = treeHeight(bundle.block.txCount);
    if (txidBranch.length !== expectedHeight) {
      throw new Error(`reveal txid branch depth ${txidBranch.length} != tree height ${expectedHeight}`);
    }
    const { root: txidRoot } = verifyMerkleBranch(reveal.txidLE, txidBranch, bundle.reveal.pos, bundle.block.txCount);
    if (!bytesEqual(txidRoot, header.merkleRootLE)) {
      throw new Error("reveal txid merkle proof does not match header merkle root");
    }
    const allInscriptions = inscriptionsFromTx(reveal);
    const inscription = allInscriptions.find((i) => i.index === id.index);
    if (!inscription) {
      throw new Error(`reveal tx contains ${allInscriptions.length} envelope(s); index ${id.index} not present`);
    }
    if (bundle.level === "L2") {
      if (!bundle.commit) throw new Error("L2 bundle missing commit tx");
      const commit = parseHexTx(bundle.commit.hex, "commit");
      const input = reveal.inputs[inscription.input];
      if (commit.txid !== input.prevTxid) {
        throw new Error(`commit tx hashes to ${commit.txid}, reveal input spends ${input.prevTxid}`);
      }
      const spent = commit.outputs[input.vout];
      if (!spent) throw new Error(`commit tx has no output ${input.vout}`);
      const tapscript = extractTapscript(input.witness);
      if (!tapscript) throw new Error("reveal input witness is not a script-path spend");
      verifyScriptPathCommitment({
        script: tapscript.script,
        controlBlock: tapscript.controlBlock,
        scriptPubKey: spent.scriptPubKey
      });
      const depth = parseControlBlock(tapscript.controlBlock).path.length;
      return {
        level: "L2",
        inscriptionId: bundle.inscriptionId.toLowerCase(),
        inscription,
        allInscriptions,
        header,
        height: bundle.block.height,
        revealTx: reveal,
        l2: {
          controlBlockDepth: depth,
          singleLeafTree: depth === 0,
          singleInputReveal: reveal.inputs.length === 1
        }
      };
    }
    if (bundle.level !== "L3") throw new Error(`unknown proof level ${bundle.level}`);
    if (!bundle.witness) throw new Error("L3 bundle missing witness section");
    const coinbase = parseHexTx(bundle.witness.coinbaseHex, "coinbase");
    if (!isCoinbase(coinbase)) throw new Error("claimed coinbase is not a coinbase transaction");
    const cbBranch = bundle.witness.coinbaseTxidBranch.map(displayToInternal);
    if (cbBranch.length !== expectedHeight) {
      throw new Error(`coinbase branch depth ${cbBranch.length} != tree height ${expectedHeight}`);
    }
    const { root: cbRoot } = verifyMerkleBranch(coinbase.txidLE, cbBranch, 0, bundle.block.txCount);
    if (!bytesEqual(cbRoot, header.merkleRootLE)) {
      throw new Error("coinbase txid merkle proof does not match header merkle root");
    }
    const commitment = findWitnessCommitment(coinbase);
    if (!commitment) throw new Error("coinbase has no BIP-141 witness commitment output");
    const reserved = witnessReservedValue(coinbase);
    const wtxidBranch = bundle.witness.wtxidBranch.map(displayToInternal);
    if (wtxidBranch.length !== expectedHeight) {
      throw new Error(`wtxid branch depth ${wtxidBranch.length} != tree height ${expectedHeight}`);
    }
    if (bundle.reveal.pos === 1 && !bytesEqual(wtxidBranch[0], ZERO32)) {
      throw new Error("wtxid branch sibling at position 1 must be the zeroed coinbase leaf");
    }
    if (bundle.reveal.pos === 0) throw new Error("reveal tx cannot be the coinbase");
    const { root: witnessRoot } = verifyMerkleBranch(
      reveal.wtxidLE,
      wtxidBranch,
      bundle.reveal.pos,
      bundle.block.txCount
    );
    const expectedCommitment = computeWitnessCommitment(witnessRoot, reserved);
    if (!bytesEqual(expectedCommitment, commitment)) {
      throw new Error("witness commitment mismatch: reveal witness is not the one committed in this block");
    }
    return {
      level: "L3",
      inscriptionId: bundle.inscriptionId.toLowerCase(),
      inscription,
      allInscriptions,
      header,
      height: bundle.block.height,
      revealTx: reveal
    };
  }

  // packages/core/src/cbor.ts
  var CborReader = class {
    constructor(bytes, pos = 0) {
      this.bytes = bytes;
      this.pos = pos;
    }
    bytes;
    pos;
    u8() {
      if (this.pos >= this.bytes.length) throw new Error("cbor: unexpected end");
      return this.bytes[this.pos++];
    }
    take(n) {
      if (this.pos + n > this.bytes.length) throw new Error("cbor: unexpected end");
      const out = this.bytes.slice(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }
    uint(info) {
      if (info < 24) return BigInt(info);
      if (info === 24) return BigInt(this.u8());
      if (info === 25) {
        const b = this.take(2);
        return BigInt(b[0] << 8 | b[1]);
      }
      if (info === 26) {
        const b = this.take(4);
        return BigInt(b[0]) << 24n | BigInt(b[1]) << 16n | BigInt(b[2]) << 8n | BigInt(b[3]);
      }
      if (info === 27) {
        const b = this.take(8);
        let v = 0n;
        for (const byte of b) v = v << 8n | BigInt(byte);
        return v;
      }
      throw new Error(`cbor: invalid additional info ${info}`);
    }
  };
  function toNumberIfSafe(v) {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  function decodeHalf(b) {
    const half = b[0] << 8 | b[1];
    const sign = half & 32768 ? -1 : 1;
    const exp = half >> 10 & 31;
    const mant = half & 1023;
    if (exp === 0) return sign * mant * 2 ** -24;
    if (exp === 31) return mant ? NaN : sign * Infinity;
    return sign * (mant + 1024) * 2 ** (exp - 25);
  }
  var utf82 = new TextDecoder("utf-8", { fatal: false });
  function keyToString(key) {
    if (typeof key === "string") return key;
    if (typeof key === "number" || typeof key === "bigint" || typeof key === "boolean") return String(key);
    if (key instanceof Uint8Array) return `0x${[...key].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    return JSON.stringify(key);
  }
  function decodeItem(r, depth) {
    if (depth > 128) throw new Error("cbor: nesting too deep");
    const initial = r.u8();
    const major = initial >> 5;
    const info = initial & 31;
    switch (major) {
      case 0:
        return toNumberIfSafe(r.uint(info));
      case 1:
        return toNumberIfSafe(-1n - r.uint(info));
      case 2:
      case 3: {
        if (info === 31) {
          const chunks = [];
          for (; ; ) {
            const next = r.u8();
            if (next === 255) break;
            const m = next >> 5;
            if (m !== major) throw new Error("cbor: mixed chunk types in indefinite string");
            const len2 = Number(r.uint(next & 31));
            chunks.push(r.take(len2));
          }
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          return major === 2 ? merged : utf82.decode(merged);
        }
        const len = Number(r.uint(info));
        const data = r.take(len);
        return major === 2 ? data : utf82.decode(data);
      }
      case 4: {
        const out = [];
        if (info === 31) {
          for (; ; ) {
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
        const out = {};
        const put = () => {
          const key = keyToString(decodeItem(r, depth + 1));
          out[key] = decodeItem(r, depth + 1);
        };
        if (info === 31) {
          for (; ; ) {
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
        r.uint(info);
        return decodeItem(r, depth + 1);
      }
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return void 0;
        if (info === 25) return decodeHalf(r.take(2));
        if (info === 26) return new DataView(r.take(4).buffer).getFloat32(0, false);
        if (info === 27) return new DataView(r.take(8).buffer).getFloat64(0, false);
        if (info < 20) return info;
        if (info === 24) return r.u8();
        throw new Error(`cbor: unsupported simple/float info ${info}`);
      }
      default:
        throw new Error(`cbor: unreachable major ${major}`);
    }
  }
  function peekBreak(r) {
    const b = r.u8();
    if (b === 255) return true;
    r.pos--;
    return false;
  }
  function decodeCbor(bytes) {
    const r = new CborReader(bytes);
    const value = decodeItem(r, 0);
    if (r.pos !== bytes.length) throw new Error(`cbor: ${bytes.length - r.pos} trailing bytes`);
    return value;
  }
  function decodeCborJson(bytes) {
    const walk = (v) => {
      if (v instanceof Uint8Array) return `0x${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      if (typeof v === "bigint") return v.toString();
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const out = {};
        for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
        return out;
      }
      return v;
    };
    return walk(decodeCbor(bytes));
  }

  // packages/core/src/block.ts
  function parseBlock(raw) {
    if (raw.length < 81) throw new Error("block too short");
    const header = parseHeader(raw.slice(0, 80));
    const r = new ByteReader(raw, 80);
    const count = r.readVarIntNum();
    const txs = [];
    for (let i = 0; i < count; i++) {
      const tx = parseTx(raw.slice(r.pos), { allowTrailing: true });
      txs.push(tx);
      r.pos += tx.size;
    }
    if (r.remaining !== 0) throw new Error(`block has ${r.remaining} trailing bytes`);
    return { header, txs };
  }

  // packages/fetch/src/uri.ts
  var B64_RE = /^[A-Za-z0-9+/_-]{43}=?$/;
  var HEX64_RE = /^[0-9a-fA-F]{64}$/;
  function decodeIntegrity(fragment) {
    const eq = fragment.indexOf("=");
    const value = fragment.slice(eq + 1);
    if (!value.startsWith("sha256-")) throw new Error(`unsupported integrity algorithm in "${fragment}"`);
    const digest = value.slice("sha256-".length);
    if (HEX64_RE.test(digest)) return { algorithm: "sha256", digestHex: digest.toLowerCase() };
    if (B64_RE.test(digest)) {
      const b64 = digest.replace(/-/g, "+").replace(/_/g, "/");
      const bin = typeof atob === "function" ? atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")) : Buffer.from(b64, "base64").toString("binary");
      if (bin.length !== 32) throw new Error("integrity digest must be 32 bytes");
      let hex = "";
      for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
      return { algorithm: "sha256", digestHex: hex };
    }
    throw new Error("integrity digest must be 64 hex chars or base64 of 32 bytes");
  }
  function parseOrdUri(input) {
    let rest = input.trim();
    let integrity;
    const hash = rest.indexOf("#");
    if (hash !== -1) {
      const fragment = decodeURIComponent(rest.slice(hash + 1));
      rest = rest.slice(0, hash);
      if (fragment.startsWith("integrity=")) integrity = decodeIntegrity(fragment);
      else if (fragment.length > 0) throw new Error(`unknown ord URI fragment "${fragment}"`);
    }
    const lower = rest.toLowerCase();
    if (lower.startsWith("ord://")) rest = rest.slice(6);
    else if (lower.startsWith("ord:")) rest = rest.slice(4);
    else if (!isInscriptionId(rest.split("/")[0] ?? "")) {
      throw new Error(`not an ord URI: ${input}`);
    }
    const segments = rest.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) throw new Error("ord URI missing inscription id");
    const id = parseInscriptionId(segments[0]);
    let path = "undelegated";
    if (segments.length === 2) {
      if (segments[1] === "content") path = "content";
      else if (segments[1] === "metadata") path = "metadata";
      else throw new Error(`unknown ord URI path "/${segments[1]}"`);
    } else if (segments.length > 2) {
      throw new Error(`ord URI has too many path segments: ${input}`);
    }
    const idString = `${id.txid}i${id.index}`;
    const canonical = `ord:${idString}` + (path === "undelegated" ? "" : `/${path}`) + (integrity ? `#integrity=sha256-${integrity.digestHex}` : "");
    return { id, idString, path, integrity, canonical };
  }

  // packages/fetch/src/backends.ts
  async function ok(res, url) {
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res;
  }
  var EsploraBackend = class {
    constructor(baseUrl, fetchFn = (u, i) => fetch(u, i)) {
      this.baseUrl = baseUrl;
      this.fetchFn = fetchFn;
      this.baseUrl = baseUrl.replace(/\/+$/, "");
    }
    baseUrl;
    fetchFn;
    async text(path) {
      const url = `${this.baseUrl}${path}`;
      return (await ok(await this.fetchFn(url), url)).text();
    }
    async json(path) {
      const url = `${this.baseUrl}${path}`;
      return (await ok(await this.fetchFn(url), url)).json();
    }
    getTxHex(txid) {
      return this.text(`/tx/${txid}/hex`);
    }
    getTxStatus(txid) {
      return this.json(`/tx/${txid}/status`);
    }
    getMerkleProof(txid) {
      return this.json(`/tx/${txid}/merkle-proof`);
    }
    getHeaderHex(blockHash) {
      return this.text(`/block/${blockHash}/header`);
    }
    getBlockInfo(blockHash) {
      return this.json(`/block/${blockHash}`);
    }
    getBlockHashAtHeight(height) {
      return this.text(`/block-height/${height}`);
    }
    getTipHeight() {
      return this.text("/blocks/tip/height");
    }
    async getBlockRaw(blockHash) {
      const url = `${this.baseUrl}/block/${blockHash}/raw`;
      const res = await ok(await this.fetchFn(url), url);
      return new Uint8Array(await res.arrayBuffer());
    }
    /** txid of the transaction at index `pos` in the block (esplora /txid endpoint) */
    getTxidAtBlockIndex(blockHash, pos) {
      return this.text(`/block/${blockHash}/txid/${pos}`);
    }
  };
  var OrdBackend = class {
    constructor(baseUrl, fetchFn = (u, i) => fetch(u, i)) {
      this.baseUrl = baseUrl;
      this.fetchFn = fetchFn;
      this.baseUrl = baseUrl.replace(/\/+$/, "");
    }
    baseUrl;
    fetchFn;
    url(path) {
      return `${this.baseUrl}${path}`;
    }
    /** raw content response (delegation applied by the server) */
    async content(id, acceptEncoding = "br, gzip, identity") {
      const url = this.url(`/content/${id}`);
      return ok(await this.fetchFn(url, { headers: { "accept-encoding": acceptEncoding } }), url);
    }
    /** original content, no delegate substitution */
    async undelegatedContent(id, acceptEncoding = "br, gzip, identity") {
      const url = this.url(`/r/undelegated-content/${id}`);
      return ok(await this.fetchFn(url, { headers: { "accept-encoding": acceptEncoding } }), url);
    }
    async inscriptionInfo(id) {
      const url = this.url(`/r/inscription/${id}`);
      return (await ok(await this.fetchFn(url), url)).json();
    }
    /** hex-encoded CBOR metadata (ord serves it as a JSON string) */
    async metadataHex(id) {
      const url = this.url(`/r/metadata/${id}`);
      return (await ok(await this.fetchFn(url), url)).json();
    }
    /** hex-encoded raw transaction (ord serves it as a JSON string) */
    async txHex(txid) {
      const url = this.url(`/r/tx/${txid}`);
      return (await ok(await this.fetchFn(url), url)).json();
    }
  };

  // packages/fetch/src/proofbuilder.ts
  async function buildProofBundle(esplora, id, level) {
    const status = await esplora.getTxStatus(id.txid);
    if (!status.confirmed || !status.block_hash || status.block_height === void 0) {
      throw new Error(`reveal tx ${id.txid} is not confirmed`);
    }
    const blockHash = status.block_hash;
    const height = status.block_height;
    if (level === "L2") {
      const [revealHex, proof, headerHex, blockInfo] = await Promise.all([
        esplora.getTxHex(id.txid),
        esplora.getMerkleProof(id.txid),
        esplora.getHeaderHex(blockHash),
        esplora.getBlockInfo(blockHash)
      ]);
      const reveal = parseTx(hexToBytes(revealHex.trim()));
      const inscription = inscriptionsFromTx(reveal).find((i) => i.index === id.index);
      if (!inscription) {
        throw new Error(`no envelope at index ${id.index} in ${id.txid}`);
      }
      const input = reveal.inputs[inscription.input];
      const commitHex = await esplora.getTxHex(input.prevTxid);
      return {
        version: 1,
        inscriptionId: `${id.txid}i${id.index}`,
        level: "L2",
        block: { height, hash: blockHash, header: headerHex.trim(), txCount: blockInfo.tx_count },
        reveal: { hex: revealHex.trim(), pos: proof.pos, txidBranch: proof.merkle },
        commit: { hex: commitHex.trim() }
      };
    }
    const raw = await esplora.getBlockRaw(blockHash);
    const block = parseBlock(raw);
    const pos = block.txs.findIndex((t) => t.txid === id.txid);
    if (pos === -1) throw new Error(`tx ${id.txid} not found in block ${blockHash}`);
    if (pos === 0) throw new Error("reveal tx cannot be the coinbase");
    const txids = block.txs.map((t) => t.txidLE);
    const wtxids = block.txs.map((t, i) => i === 0 ? ZERO32 : t.wtxidLE);
    const toDisplay = (b) => bytesToHex(b.slice().reverse());
    return {
      version: 1,
      inscriptionId: `${id.txid}i${id.index}`,
      level: "L3",
      block: {
        height,
        hash: block.header.hash,
        header: bytesToHex(block.header.raw),
        txCount: block.txs.length
      },
      reveal: {
        hex: bytesToHex(block.txs[pos].raw),
        pos,
        txidBranch: buildMerkleBranch(txids, pos).map(toDisplay)
      },
      witness: {
        coinbaseHex: bytesToHex(block.txs[0].raw),
        coinbaseTxidBranch: buildMerkleBranch(txids, 0).map(toDisplay),
        wtxidBranch: buildMerkleBranch(wtxids, pos).map(toDisplay)
      }
    };
  }

  // packages/fetch/src/headertrust.ts
  var MAINNET_CHECKPOINTS = /* @__PURE__ */ new Map([
    [0, "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"],
    // block containing inscription 0
    [767430, "000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5"],
    // ord "Jubilee" activation block
    [824544, "00000000000000000001b7f8d0289c6e15e5a6c9a59894b955afcf7dd8f9b1fe"]
  ]);
  var HeaderTrustError = class extends Error {
  };
  function makeHeaderTrust(options = {}) {
    const checkpoints = options.checkpoints ?? MAINNET_CHECKPOINTS;
    const esploras = options.esploras ?? [];
    return async function checkHeader(header, height) {
      const checkpoint = checkpoints.get(height);
      if (checkpoint !== void 0) {
        if (checkpoint !== header.hash) {
          throw new HeaderTrustError(
            `header ${header.hash} at height ${height} contradicts checkpoint ${checkpoint}`
          );
        }
        return { checkpointHit: true, sourcesQueried: 0, sourcesAgreed: 0 };
      }
      if (esploras.length === 0) {
        throw new HeaderTrustError(
          `no checkpoint for height ${height} and no header sources configured`
        );
      }
      const results = await Promise.allSettled(
        esploras.map(async (e) => ({
          hash: (await e.getBlockHashAtHeight(height)).trim().toLowerCase(),
          tip: Number((await e.getTipHeight()).trim())
        }))
      );
      const successes = results.filter(
        (r) => r.status === "fulfilled"
      );
      const agreed = successes.filter((r) => r.value.hash === header.hash);
      const minAgreement = options.minAgreement ?? Math.max(1, Math.min(2, esploras.length));
      if (agreed.length < minAgreement) {
        throw new HeaderTrustError(
          `only ${agreed.length}/${esploras.length} header sources agree on height ${height} (need ${minAgreement}); header ${header.hash}`
        );
      }
      const tips = successes.map((r) => r.value.tip).sort((a, b) => a - b);
      const tipHeight = tips.length ? tips[Math.floor(tips.length / 2)] : void 0;
      if (options.minConfirmations && tipHeight !== void 0) {
        const confs = tipHeight - height + 1;
        if (confs < options.minConfirmations) {
          throw new HeaderTrustError(`only ${confs} confirmations, need ${options.minConfirmations}`);
        }
      }
      return {
        checkpointHit: false,
        sourcesQueried: esploras.length,
        sourcesAgreed: agreed.length,
        tipHeight
      };
    };
  }

  // packages/fetch/src/decompress.browser.ts
  var webDecompressor = async (encoding, data) => {
    if (typeof DecompressionStream === "undefined") return void 0;
    if (encoding !== "gzip" && encoding !== "deflate") return void 0;
    const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream(encoding));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  var defaultDecompressor = webDecompressor;

  // packages/fetch/src/resolver.ts
  var OrdResolveError = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "OrdResolveError";
    }
    code;
  };
  var DEFAULT_ESPLORA = ["https://mempool.space/api", "https://blockstream.info/api"];
  var DEFAULT_ORD_GATEWAYS = ["https://ordinals.com"];
  var OrdResolver = class {
    esploras;
    ordServers;
    options;
    decompressor;
    constructor(options = {}) {
      this.options = options;
      const fetchFn = options.fetchFn;
      this.esploras = (options.esplora ?? DEFAULT_ESPLORA).map((u) => new EsploraBackend(u, fetchFn));
      this.ordServers = (options.ordGateways ?? DEFAULT_ORD_GATEWAYS).map(
        (u) => new OrdBackend(u, fetchFn)
      );
      this.decompressor = options.decompressor ?? defaultDecompressor;
    }
    /** Resolve an ord URI to verified bytes. */
    async resolve(uri, overrides = {}) {
      let parsed;
      try {
        parsed = parseOrdUri(uri);
      } catch (e) {
        throw new OrdResolveError("BAD_URI", e.message);
      }
      const mode = overrides.verification ?? this.options.verification ?? "L2";
      if (mode === "L2" || mode === "L3") return this.resolveVerified(parsed, mode);
      return this.resolveViaGateway(parsed, mode);
    }
    /** fetch()-shaped convenience. */
    async fetch(uri, overrides = {}) {
      const result = await this.resolve(uri, overrides);
      return toResponse(result);
    }
    // ---------- verified path (chain data, untrusted servers) ----------
    async withEsplora(fn) {
      const errors = [];
      for (const e of this.esploras) {
        try {
          return await fn(e);
        } catch (err) {
          errors.push(`${e.baseUrl}: ${err.message}`);
        }
      }
      throw new OrdResolveError("BACKEND", `all esplora backends failed:
${errors.join("\n")}`);
    }
    async verifyInscription(idString, level) {
      const parsed = parseOrdUri(idString);
      const bundle = await this.withEsplora((e) => buildProofBundle(e, parsed.id, level));
      let verified;
      try {
        verified = verifyProofBundle(bundle);
      } catch (e) {
        throw new OrdResolveError("VERIFY_FAILED", e.message);
      }
      const trust = this.options.trustHeader ?? makeHeaderTrust({
        esploras: this.esploras,
        minAgreement: this.options.minHeaderAgreement,
        minConfirmations: this.options.minConfirmations,
        checkpoints: this.options.checkpoints ?? MAINNET_CHECKPOINTS
      });
      let headerTrust;
      try {
        headerTrust = await trust(verified.header, verified.height);
      } catch (e) {
        throw new OrdResolveError("HEADER_TRUST", e.message);
      }
      return { verified, headerTrust };
    }
    async resolveVerified(parsed, level) {
      const { verified, headerTrust } = await this.verifyInscription(parsed.idString, level);
      const inscription = verified.inscription;
      if (parsed.path === "metadata") {
        if (!inscription.metadata) throw new OrdResolveError("NO_CONTENT", "inscription has no metadata");
        const body2 = inscription.metadata;
        this.checkIntegrity(parsed, body2);
        return {
          uri: parsed,
          body: body2,
          contentType: "application/cbor",
          decoded: false,
          metadataJson: safeDecodeCbor(body2),
          inscription,
          verification: this.verification(level, verified, headerTrust, body2, parsed)
        };
      }
      let source = inscription;
      let viaDelegate;
      let sourceVerified = verified;
      if (parsed.path === "content" && inscription.delegate) {
        const delegate = await this.verifyInscription(inscription.delegate, level);
        source = delegate.verified.inscription;
        sourceVerified = delegate.verified;
        viaDelegate = inscription.delegate;
      }
      if (!source.body) {
        throw new OrdResolveError(
          "NO_CONTENT",
          viaDelegate ? `delegate ${viaDelegate} has no body` : "inscription has no body"
        );
      }
      const stored = source.body;
      this.checkIntegrity(parsed, stored);
      const storedContentEncoding = source.contentEncoding;
      let body = stored;
      let decoded = false;
      let contentEncoding = storedContentEncoding;
      if (contentEncoding) {
        const attempt = await this.decompressor(contentEncoding, stored);
        if (attempt) {
          body = attempt;
          decoded = true;
          contentEncoding = void 0;
        }
      }
      return {
        uri: parsed,
        body,
        contentType: source.contentType,
        contentEncoding,
        storedContentEncoding,
        decoded,
        inscription,
        viaDelegate,
        verification: this.verification(level, sourceVerified, headerTrust, stored, parsed)
      };
    }
    verification(level, verified, headerTrust, stored, parsed) {
      return {
        level,
        blockHash: verified.header.hash,
        height: verified.height,
        l2: verified.l2,
        headerTrust,
        bodySha256: bytesToHex(sha2562(stored)),
        integrityChecked: parsed.integrity !== void 0
      };
    }
    checkIntegrity(parsed, stored) {
      if (!parsed.integrity) return;
      const actual = bytesToHex(sha2562(stored));
      if (actual !== parsed.integrity.digestHex) {
        throw new OrdResolveError(
          "INTEGRITY",
          `integrity mismatch: body sha256 ${actual}, URI pins ${parsed.integrity.digestHex}`
        );
      }
    }
    // ---------- gateway path (trusted ord servers, optional L1 pin) ----------
    async resolveViaGateway(parsed, mode) {
      if (mode === "L1" && !parsed.integrity) {
        throw new OrdResolveError(
          "INTEGRITY",
          "L1 verification requires an #integrity fragment in the URI"
        );
      }
      const errors = [];
      for (const ord of this.ordServers) {
        try {
          if (parsed.path === "metadata") {
            const hex = await ord.metadataHex(parsed.idString);
            const body2 = hexToBytes(hex);
            this.checkIntegrity(parsed, body2);
            return {
              uri: parsed,
              body: body2,
              contentType: "application/cbor",
              decoded: false,
              metadataJson: safeDecodeCbor(body2),
              verification: {
                level: mode,
                bodySha256: bytesToHex(sha2562(body2)),
                integrityChecked: parsed.integrity !== void 0
              }
            };
          }
          const res = parsed.path === "content" ? await ord.content(parsed.idString) : await ord.undelegatedContent(parsed.idString);
          const body = new Uint8Array(await res.arrayBuffer());
          const contentEncoding = res.headers.get("content-encoding") ?? void 0;
          if (parsed.integrity) {
            const actual = bytesToHex(sha2562(body));
            if (actual !== parsed.integrity.digestHex) {
              throw new OrdResolveError(
                contentEncoding ? "INTEGRITY_INDETERMINATE" : "INTEGRITY",
                contentEncoding ? `body was transport-decoded (${contentEncoding}); use L2/L3 to check an integrity pin on encoded inscriptions` : `integrity mismatch: body sha256 ${actual}, URI pins ${parsed.integrity.digestHex}`
              );
            }
          }
          return {
            uri: parsed,
            body,
            contentType: res.headers.get("content-type") ?? void 0,
            contentEncoding,
            decoded: false,
            verification: {
              level: mode,
              bodySha256: bytesToHex(sha2562(body)),
              integrityChecked: parsed.integrity !== void 0
            }
          };
        } catch (e) {
          if (e instanceof OrdResolveError && e.code !== "BACKEND") throw e;
          errors.push(`${ord.baseUrl}: ${e.message}`);
        }
      }
      throw new OrdResolveError("BACKEND", `all ord gateways failed:
${errors.join("\n")}`);
    }
  };
  function safeDecodeCbor(bytes) {
    try {
      return decodeCborJson(bytes);
    } catch {
      return void 0;
    }
  }
  function toResponse(result) {
    const headers = new Headers();
    headers.set("content-type", result.contentType ?? "application/octet-stream");
    if (result.contentEncoding) headers.set("content-encoding", result.contentEncoding);
    if (result.storedContentEncoding) {
      headers.set("x-ord-content-encoding", result.storedContentEncoding);
    }
    headers.set("x-ord-verification", result.verification.level);
    if (result.verification.blockHash) headers.set("x-ord-block", result.verification.blockHash);
    if (result.verification.height !== void 0) {
      headers.set("x-ord-height", String(result.verification.height));
    }
    if (result.verification.bodySha256) headers.set("x-ord-body-sha256", result.verification.bodySha256);
    if (result.viaDelegate) headers.set("x-ord-delegate", result.viaDelegate);
    headers.set("cache-control", "public, max-age=1209600, immutable");
    return new Response(result.body.slice(), { status: 200, headers });
  }

  // extension/src/urlmap.ts
  var ID_RE2 = /^[0-9a-f]{64}i\d+$/i;
  function normalizeOrdInput(input) {
    let s = input.trim();
    if (s.startsWith("ord://")) s = `ord:${s.slice("ord://".length)}`;
    if (!s.startsWith("ord:")) {
      if (ID_RE2.test(s)) return `ord:${s.toLowerCase()}`;
      return void 0;
    }
    const rest = s.slice(4);
    const idPart = rest.split(/[/#?]/, 1)[0];
    if (!ID_RE2.test(idPart)) return void 0;
    return `ord:${rest}`;
  }
  function uriFromViewerHash(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    return normalizeOrdInput(decodeURIComponent(raw));
  }
  function uriFromDnrHash(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!raw.startsWith("gw:")) return void 0;
    const [, kind, id] = raw.split(":");
    if (!kind || !id || !ID_RE2.test(id)) return void 0;
    return kind === "r/undelegated-content" ? `ord:${id.toLowerCase()}` : `ord:${id.toLowerCase()}/content`;
  }

  // extension/src/viewer.ts
  var $ = (id) => document.getElementById(id);
  function fact(dt, dd, mono = false) {
    const dl = $("facts");
    const dtEl = document.createElement("dt");
    dtEl.textContent = dt;
    const ddEl = document.createElement("dd");
    ddEl.textContent = dd;
    if (mono) ddEl.className = "mono";
    dl.append(dtEl, ddEl);
  }
  function fail(message) {
    $("status").className = "status fail";
    $("status").textContent = `\u2717 ${message}`;
  }
  async function render(result) {
    const target = $("content");
    const type = result.contentType ?? "application/octet-stream";
    const blob = new Blob([result.body.slice()], { type });
    const url = URL.createObjectURL(blob);
    if (result.contentEncoding) {
      const note = document.createElement("p");
      note.textContent = `body is ${result.contentEncoding}-encoded on-chain and this build cannot decode it \u2014 verified stored bytes offered as download:`;
      const a = document.createElement("a");
      a.href = url;
      a.download = `${result.uri.idString}.${result.contentEncoding}`;
      a.textContent = `${result.body.length} bytes (${type}, ${result.contentEncoding})`;
      target.append(note, a);
      return;
    }
    if (type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = result.uri.idString;
      target.appendChild(img);
    } else if (type.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      target.appendChild(video);
    } else if (type.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.src = url;
      audio.controls = true;
      target.appendChild(audio);
    } else if (type.startsWith("text/html")) {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = url;
      target.appendChild(frame);
    } else if (type.startsWith("text/") || type.includes("json") || type.includes("javascript")) {
      const pre = document.createElement("pre");
      pre.textContent = new TextDecoder().decode(result.body.slice(0, 512 * 1024));
      target.appendChild(pre);
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${result.uri.idString}`;
      a.textContent = `download ${result.body.length} bytes (${type})`;
      target.appendChild(a);
    }
  }
  async function main() {
    const uri = uriFromDnrHash(location.hash) ?? uriFromViewerHash(location.hash);
    if (!uri) {
      fail('no ord: URI in the fragment \u2014 open via an ord: link, gateway redirect, or the "ord" omnibox keyword');
      return;
    }
    $("uri").textContent = uri;
    document.title = `ord viewer \u2014 ${uri.slice(4, 24)}\u2026`;
    const hasChrome = typeof chrome !== "undefined" && !!chrome.storage?.sync;
    const settings = hasChrome ? await chrome.storage.sync.get({ level: "L2", esploras: null }) : { level: "L2", esploras: null };
    const level = settings.level === "L3" ? "L3" : "L2";
    $("status").textContent = `resolving & verifying at ${level}\u2026`;
    const resolver = new OrdResolver({
      ...Array.isArray(settings.esploras) && settings.esploras.length ? { esplora: settings.esploras } : {},
      verification: level
    });
    try {
      const started = performance.now();
      const result = await resolver.resolve(uri);
      const ms = Math.round(performance.now() - started);
      $("status").className = "status pass";
      $("status").textContent = `\u2713 verified at ${result.verification.level} in ${ms} ms \u2014 rendered from proven bytes`;
      fact("inscription", result.uri.idString, true);
      fact("content-type", result.contentType ?? "(none)");
      fact("bytes", String(result.body.length) + (result.decoded ? " (decoded)" : ""));
      if (result.storedContentEncoding) fact("tag-9 encoding", result.storedContentEncoding);
      if (result.viaDelegate) fact("via delegate", result.viaDelegate, true);
      fact("block", `${result.verification.height} (${result.verification.blockHash?.slice(0, 16)}\u2026)`);
      fact("stored sha256", result.verification.bodySha256 ?? "", true);
      const l2 = result.verification.l2;
      if (l2) {
        fact(
          "assurances",
          `singleLeafTree=${l2.singleLeafTree} singleInputReveal=${l2.singleInputReveal}` + (result.verification.level === "L3" ? " (+witness commitment)" : "")
        );
      }
      await render(result);
    } catch (e) {
      fail(e.message);
    }
  }
  void main();
  window.addEventListener("hashchange", () => location.reload());
})();
/*! Bundled license information:

@noble/curves/utils.js:
@noble/curves/abstract/modular.js:
@noble/curves/abstract/curve.js:
@noble/curves/abstract/weierstrass.js:
@noble/curves/secp256k1.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
