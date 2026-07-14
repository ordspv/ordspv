import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fetchCapped, readBodyCapped } from '../src/http.js';
import {
  boundedDecompressor,
  boundedNodeDecompressor,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
} from '../src/decompress.js';
import type { FetchFn } from '../src/backends.js';

describe('fetchCapped: deadline', () => {
  it('rejects a hung fetch after the timeout', async () => {
    const hung: FetchFn = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const started = Date.now();
    await expect(
      fetchCapped('https://slow.test/x', { fetchFn: hung, timeoutMs: 150, maxBytes: 1024 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('returns the body when the fetch completes in time', async () => {
    const ok: FetchFn = async () => new Response('hello');
    const res = await fetchCapped('https://ok.test', { fetchFn: ok, timeoutMs: 1000, maxBytes: 1024 });
    expect(new TextDecoder().decode(res.bytes)).toBe('hello');
    expect(res.ok).toBe(true);
  });
});

describe('fetchCapped: cap violations are not mislabeled as timeouts', () => {
  it('a declared oversize content-length throws the descriptive cap error', async () => {
    const big: FetchFn = async () =>
      new Response('x'.repeat(100), { headers: { 'content-length': '100' } });
    const err = await fetchCapped('https://big.test', {
      fetchFn: big,
      timeoutMs: 5_000,
      maxBytes: 50,
    }).then(() => undefined, (e: Error) => e);
    expect(err?.message).toMatch(/exceeds cap/);
    expect(err?.message).not.toMatch(/timed out/);
  });

  it('a body overshooting the cap mid-stream throws the descriptive cap error', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(40));
        controller.close();
      },
    });
    const noLength: FetchFn = async () => new Response(stream);
    const err = await fetchCapped('https://stream.test', {
      fetchFn: noLength,
      timeoutMs: 5_000,
      maxBytes: 50,
    }).then(() => undefined, (e: Error) => e);
    expect(err?.message).toMatch(/exceeded cap/);
    expect(err?.message).not.toMatch(/timed out/);
  });
});

describe('readBodyCapped: size bound', () => {
  it('rejects when Content-Length already exceeds the cap', async () => {
    const res = new Response('x'.repeat(100), { headers: { 'content-length': '100' } });
    await expect(readBodyCapped(res, 50, 'test')).rejects.toThrow(/content-length 100 exceeds/);
  });

  it('rejects a body that streams past the cap even when Content-Length lies', async () => {
    // a streaming body with NO content-length that overshoots the cap
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(40));
        controller.close();
      },
    });
    const res = new Response(stream);
    await expect(readBodyCapped(res, 50, 'stream')).rejects.toThrow(/exceeded cap/);
  });

  it('accepts a body within the cap', async () => {
    const res = new Response('ok bytes');
    const bytes = await readBodyCapped(res, 1024, 'ok');
    expect(new TextDecoder().decode(bytes)).toBe('ok bytes');
  });
});

describe('bounded decompressor: bomb protection', () => {
  it('refuses output past the configured cap (returns undefined)', async () => {
    const bomb = new Uint8Array(gzipSync(new Uint8Array(4 * 1024 * 1024))); // 4MB zeros
    const capped = boundedNodeDecompressor(64 * 1024);
    expect(await capped('gzip', bomb)).toBeUndefined();
    // a generous cap decodes the same input fine
    const generous = boundedNodeDecompressor(8 * 1024 * 1024);
    const out = await generous('gzip', bomb);
    expect(out?.length).toBe(4 * 1024 * 1024);
  });

  it('boundedDecompressor composes node + web paths with the cap applied', async () => {
    const data = new Uint8Array(gzipSync(new TextEncoder().encode('small enough')));
    const d = boundedDecompressor(1024);
    expect(new TextDecoder().decode((await d('gzip', data))!)).toBe('small enough');
  });

  it('default cap is generous but finite', () => {
    expect(DEFAULT_MAX_DECOMPRESSED_BYTES).toBeGreaterThan(4_000_000);
    expect(Number.isFinite(DEFAULT_MAX_DECOMPRESSED_BYTES)).toBe(true);
  });
});
