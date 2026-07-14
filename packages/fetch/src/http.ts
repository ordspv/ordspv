/**
 * Bounded HTTP primitives. Every network read in this package goes through a
 * deadline and a byte cap: backends are untrusted, so a hung socket must
 * reject (failover needs an error to act on) and a response body must not be
 * able to exhaust memory. Content-Length is checked but never trusted; the
 * cap is enforced on actually-received bytes while streaming.
 */

import type { FetchFn } from './backends.js';

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

export interface CappedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bytes: Uint8Array;
}

export interface FetchCappedOptions {
  /** reject the whole request (connect + body) after this many ms */
  timeoutMs?: number;
  /** reject once more than this many body bytes have been received */
  maxBytes: number;
  headers?: Record<string, string>;
  fetchFn?: FetchFn;
}

/**
 * Fetch with a hard deadline and a byte-capped body read. The deadline is
 * enforced both via AbortSignal (kills the socket under real fetch) and a
 * racing timer (so injected fetch implementations that ignore the signal
 * still reject on time).
 */
export async function fetchCapped(url: string, options: FetchCappedOptions): Promise<CappedResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          // the controller is also aborted on byte-cap violations; only the
          // deadline timer's own abort may be reported as a timeout — any
          // other abort lets `work` surface its descriptive error instead
          if (timedOut) reject(new Error(`${url}: timed out after ${timeoutMs}ms`));
        },
        { once: true },
      );
    });
    const work = (async () => {
      const res = await fetchFn(url, { signal: controller.signal, headers: options.headers });
      const bytes = await readBodyCapped(res, options.maxBytes, url, controller);
      return { status: res.status, ok: res.ok, headers: res.headers, bytes };
    })();
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a Response body, rejecting once `maxBytes` is exceeded. The declared
 * Content-Length is used only to fail fast; the enforced bound is the running
 * count of received bytes.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  context: string,
  controller?: AbortController,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (!Number.isNaN(declared) && declared > maxBytes) {
    controller?.abort();
    throw new Error(`${context}: declared content-length ${declared} exceeds cap of ${maxBytes} bytes`);
  }
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(`${context}: response exceeded cap of ${maxBytes} bytes`);
    }
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      controller?.abort();
      throw new Error(`${context}: response exceeded cap of ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}
