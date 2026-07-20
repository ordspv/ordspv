/**
 * Content-encoding handling. Inscription bodies are stored (and integrity-
 * hashed) in their on-chain encoded form; presentation may require decoding.
 * Node decodes br/gzip via node:zlib; browsers can decode gzip/deflate via
 * DecompressionStream but generally lack brotli; callers there should either
 * ship a wasm brotli or serve the encoded bytes with a Content-Encoding
 * header and let the browser's HTTP layer handle it.
 *
 * Decoded output is bounded: on-chain bodies are small, but a crafted stream
 * can expand enormously, so every decoder enforces a maximum output size and
 * reports "cannot decode" (undefined) past it. The caller then serves the
 * stored encoded bytes instead of buffering an unbounded expansion.
 */

export type Decompressor = (
  encoding: string,
  data: Uint8Array,
) => Promise<Uint8Array | undefined>;

/** Default output bound: generous for any real inscription (stored bodies are <4MB). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** node:zlib decoder with maxOutputLength enforced by zlib itself. */
export function boundedNodeDecompressor(maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES): Decompressor {
  return async (encoding, data) => {
    try {
      const zlib = await import('node:zlib');
      const opts = { maxOutputLength: maxOutputBytes };
      if (encoding === 'br') return new Uint8Array(zlib.brotliDecompressSync(data, opts));
      if (encoding === 'gzip') return new Uint8Array(zlib.gunzipSync(data, opts));
      if (encoding === 'deflate') return new Uint8Array(zlib.inflateSync(data, opts));
      return undefined;
    } catch {
      return undefined;
    }
  };
}

/** DecompressionStream decoder reading incrementally so the cap aborts the stream early. */
export function boundedWebDecompressor(maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES): Decompressor {
  return async (encoding, data) => {
    if (typeof DecompressionStream === 'undefined') return undefined;
    if (encoding !== 'gzip' && encoding !== 'deflate') return undefined;
    try {
      const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream(encoding));
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxOutputBytes) {
          await reader.cancel().catch(() => {});
          return undefined;
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const chunk of chunks) {
        out.set(chunk, off);
        off += chunk.length;
      }
      return out;
    } catch {
      return undefined;
    }
  };
}

/** node:zlib first, DecompressionStream fallback, both bounded. */
export function boundedDecompressor(maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES): Decompressor {
  const node = boundedNodeDecompressor(maxOutputBytes);
  const web = boundedWebDecompressor(maxOutputBytes);
  return async (encoding, data) => {
    const viaNode = await node(encoding, data);
    if (viaNode) return viaNode;
    return web(encoding, data);
  };
}

export const nodeDecompressor: Decompressor = boundedNodeDecompressor();

export const webDecompressor: Decompressor = boundedWebDecompressor();

export const defaultDecompressor: Decompressor = boundedDecompressor();
