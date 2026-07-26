import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKEND_LIMITS,
  EsploraBackend,
  parseRetryAfter,
  PooledEsploraBackend,
  resolveLimits,
  type FetchFn,
} from '../src/backends.js';

/**
 * Bounded retry inside a backend, and rotation across a pool of them.
 *
 * A genealogy walk spends thousands of requests on one build, so a rate limit
 * partway through used to end it. Two independent mechanisms answer that: a
 * request retries in place on transient failures, and a failing member hands
 * the same request to the next member without losing the walk's progress.
 *
 * No test here waits on a real backoff: sleep is injected and records what it
 * was asked to wait.
 */

const B = 'https://backend.test';

/** a backend whose sleeps are recorded rather than served */
function backend(fetchFn: FetchFn, limits = {}, base = B) {
  const slept: number[] = [];
  const b = new EsploraBackend(base, fetchFn, limits, async (ms) => {
    slept.push(ms);
  });
  return { b, slept };
}

describe('EsploraBackend retry', () => {
  it('retries a 429 and returns the eventual success', async () => {
    let calls = 0;
    const { b, slept } = backend(async () => {
      calls++;
      return calls < 3 ? new Response('slow down', { status: 429 }) : new Response('deadbeef');
    });
    expect(await b.getTxHex('a'.repeat(64))).toBe('deadbeef');
    expect(calls).toBe(3);
    expect(slept).toHaveLength(2);
  });

  it('retries a 503 and a thrown network error', async () => {
    for (const failure of [
      () => new Response('unavailable', { status: 503 }),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      let calls = 0;
      const { b } = backend(async () => {
        calls++;
        return calls === 1 ? failure() : new Response('ok');
      });
      expect(await b.getTipHeight()).toBe('ok');
      expect(calls).toBe(2);
    }
  });

  it('gives up after maxAttempts and reports the last failure', async () => {
    let calls = 0;
    const { b, slept } = backend(async () => {
      calls++;
      return new Response('slow down', { status: 429 });
    });
    await expect(b.getTipHeight()).rejects.toThrow(/HTTP 429/);
    expect(calls).toBe(DEFAULT_BACKEND_LIMITS.retry.maxAttempts);
    expect(slept).toHaveLength(DEFAULT_BACKEND_LIMITS.retry.maxAttempts - 1);
    // full jitter inside the exponential window, ceiling included
    slept.forEach((ms, i) => {
      const window = Math.min(
        DEFAULT_BACKEND_LIMITS.retry.maxDelayMs,
        DEFAULT_BACKEND_LIMITS.retry.baseDelayMs * 2 ** i,
      );
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(window);
    });
  });

  it('does not retry other non-2xx statuses', async () => {
    let calls = 0;
    const { b } = backend(async () => {
      calls++;
      return new Response('nope', { status: 404 });
    });
    await expect(b.getTxHex('b'.repeat(64))).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  it('does not retry a byte-cap violation', async () => {
    let calls = 0;
    const { b } = backend(
      async () => {
        calls++;
        return new Response('x'.repeat(5000));
      },
      { smallMaxBytes: 10 },
    );
    await expect(b.getTipHeight()).rejects.toThrow(/exceeded cap of 10 bytes/);
    expect(calls).toBe(1);
  });

  it('maxAttempts: 1 disables retry entirely', async () => {
    let calls = 0;
    const { b, slept } = backend(
      async () => {
        calls++;
        return new Response('slow down', { status: 429 });
      },
      { retry: { maxAttempts: 1 } },
    );
    await expect(b.getTipHeight()).rejects.toThrow(/HTTP 429/);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it('honors Retry-After in place of the jittered backoff', async () => {
    let calls = 0;
    const { b, slept } = backend(async () => {
      calls++;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
        : new Response('ok');
    });
    expect(await b.getTipHeight()).toBe('ok');
    expect(slept).toEqual([2000]);
  });

  it('gives each attempt its own deadline rather than the first one', async () => {
    // the trap: a retry loop wrapped around one fetchCapped call inherits the
    // first attempt's AbortController, so attempt 2 starts already aborted
    let calls = 0;
    const { b } = backend(
      async (_url, init) => {
        calls++;
        if (calls === 1) {
          // hang until this attempt's own deadline fires
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        }
        expect(init?.signal?.aborted).toBe(false);
        return new Response('recovered');
      },
      { timeoutMs: 20 },
    );
    expect(await b.getTipHeight()).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('resolveLimits merges the retry group instead of replacing it', () => {
    const limits = resolveLimits({ retry: { maxAttempts: 2 } });
    expect(limits.retry.maxAttempts).toBe(2);
    expect(limits.retry.baseDelayMs).toBe(DEFAULT_BACKEND_LIMITS.retry.baseDelayMs);
    expect(limits.timeoutMs).toBe(DEFAULT_BACKEND_LIMITS.timeoutMs);
  });
});

describe('parseRetryAfter', () => {
  const now = 1_800_000_000_000;
  it('reads delta-seconds and HTTP-dates', () => {
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000);
  });
  it('ignores absent, negative and far-future values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('   ', now)).toBeUndefined();
    expect(parseRetryAfter('-1', now)).toBeUndefined();
    expect(parseRetryAfter('31', now)).toBeUndefined();
    expect(parseRetryAfter('tomorrow', now)).toBeUndefined();
  });
});

describe('PooledEsploraBackend', () => {
  const bases = ['https://p1.test', 'https://p2.test', 'https://p3.test'];

  /** members that never retry, so call counts read as request counts */
  function pool(fetchFn: FetchFn) {
    return new PooledEsploraBackend(
      bases.map((u) => new EsploraBackend(u, fetchFn, { retry: { maxAttempts: 1 } })),
    );
  }

  it('rotates the starting member per request', async () => {
    const seen: string[] = [];
    const p = pool(async (url) => {
      seen.push(new URL(url).origin);
      return new Response('42');
    });
    await p.getTipHeight();
    await p.getTipHeight();
    await p.getTipHeight();
    await p.getTipHeight();
    expect(seen).toEqual([
      'https://p1.test',
      'https://p2.test',
      'https://p3.test',
      'https://p1.test',
    ]);
  });

  it('rotates on failure and retries the same request on the next member', async () => {
    const seen: string[] = [];
    const p = pool(async (url) => {
      const origin = new URL(url).origin;
      seen.push(origin);
      if (origin !== 'https://p3.test') return new Response('down', { status: 500 });
      return new Response('deadbeef');
    });
    expect(await p.getTxHex('c'.repeat(64))).toBe('deadbeef');
    expect(seen).toEqual(['https://p1.test', 'https://p2.test', 'https://p3.test']);
    // only the member that served bytes is recorded
    expect([...p.usedBaseUrls]).toEqual(['https://p3.test']);
  });

  it('fails only when every member has failed the request, naming each', async () => {
    const p = pool(async (url) => new Response(`down ${new URL(url).origin}`, { status: 500 }));
    const err = await p.getTipHeight().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/all 3 pooled backend\(s\) failed for tip height/);
    for (const base of bases) expect((err as Error).message).toContain(base);
    expect(p.usedBaseUrls.size).toBe(0);
  });

  it('tracks every member that served bytes across a run of requests', async () => {
    const p = pool(async () => new Response('7'));
    await p.getTipHeight();
    await p.getTipHeight();
    expect([...p.usedBaseUrls].sort()).toEqual(['https://p1.test', 'https://p2.test']);
  });

  it('refuses an empty pool', () => {
    expect(() => new PooledEsploraBackend([])).toThrow(/at least one backend/);
  });
});
