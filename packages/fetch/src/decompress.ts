/**
 * Content-encoding handling. Inscription bodies are stored (and integrity-
 * hashed) in their on-chain encoded form; presentation may require decoding.
 * Node decodes br/gzip via node:zlib; browsers can decode gzip/deflate via
 * DecompressionStream but generally lack brotli — callers there should either
 * ship a wasm brotli or serve the encoded bytes with a Content-Encoding
 * header and let the browser's HTTP layer handle it.
 */

export type Decompressor = (
  encoding: string,
  data: Uint8Array,
) => Promise<Uint8Array | undefined>;

export const nodeDecompressor: Decompressor = async (encoding, data) => {
  try {
    const zlib = await import('node:zlib');
    if (encoding === 'br') return new Uint8Array(zlib.brotliDecompressSync(data));
    if (encoding === 'gzip') return new Uint8Array(zlib.gunzipSync(data));
    if (encoding === 'deflate') return new Uint8Array(zlib.inflateSync(data));
    return undefined;
  } catch {
    return undefined;
  }
};

export const webDecompressor: Decompressor = async (encoding, data) => {
  if (typeof DecompressionStream === 'undefined') return undefined;
  if (encoding !== 'gzip' && encoding !== 'deflate') return undefined;
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream(encoding));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const defaultDecompressor: Decompressor = async (encoding, data) => {
  const node = await nodeDecompressor(encoding, data);
  if (node) return node;
  return webDecompressor(encoding, data);
};
