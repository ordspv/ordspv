/**
 * Browser build of the content-encoding layer, swapped in for decompress.ts
 * by the browser bundle (see scripts/build.ts). DecompressionStream covers
 * gzip/deflate; brotli is unavailable without shipping a wasm decoder, so
 * `br` returns undefined and the resolver serves the STORED bytes with
 * `contentEncoding` intact. Callers can hand them to the HTTP layer
 * (Content-Encoding response header) or plug a wasm brotli in via
 * ResolverOptions.decompressor.
 *
 * Exports mirror decompress.ts exactly; one .d.ts serves both builds.
 */

export type Decompressor = (
  encoding: string,
  data: Uint8Array,
) => Promise<Uint8Array | undefined>;

export const webDecompressor: Decompressor = async (encoding, data) => {
  if (typeof DecompressionStream === 'undefined') return undefined;
  if (encoding !== 'gzip' && encoding !== 'deflate') return undefined;
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream(encoding));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** node:zlib is not available in browsers */
export const nodeDecompressor: Decompressor = async () => undefined;

export const defaultDecompressor: Decompressor = webDecompressor;
