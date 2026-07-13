/**
 * Browser build of the content-encoding layer, swapped in for decompress.ts
 * by the browser bundle (see scripts/build.ts). DecompressionStream covers
 * gzip/deflate; brotli is unavailable without shipping a wasm decoder, so
 * `br` returns undefined and the resolver serves the STORED bytes with
 * `contentEncoding` intact. Callers can hand them to the HTTP layer
 * (Content-Encoding response header) or plug a wasm brotli in via
 * ResolverOptions.decompressor.
 *
 * Every decoder is bounded: it reads the DecompressionStream incrementally and
 * aborts past the configured output cap, so a decompression bomb cannot exhaust
 * memory. Exports mirror decompress.ts exactly; one .d.ts serves both builds.
 */

export type Decompressor = (
  encoding: string,
  data: Uint8Array,
) => Promise<Uint8Array | undefined>;

/** Default output bound: generous for any real inscription (stored bodies are <4MB). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

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

/** node:zlib is not available in browsers */
export function boundedNodeDecompressor(_maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES): Decompressor {
  return async () => undefined;
}

/** browser: only the DecompressionStream path is available, bounded */
export function boundedDecompressor(maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES): Decompressor {
  return boundedWebDecompressor(maxOutputBytes);
}

export const webDecompressor: Decompressor = boundedWebDecompressor();

export const nodeDecompressor: Decompressor = boundedNodeDecompressor();

export const defaultDecompressor: Decompressor = boundedWebDecompressor();
