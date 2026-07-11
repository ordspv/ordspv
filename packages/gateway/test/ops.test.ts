import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchFn } from '@ordspv/fetch';
import { ByteLru, Registry, TokenBucketLimiter, createGateway, routeLabel } from '../src/index.js';

describe('ByteLru', () => {
  it('enforces the byte budget by evicting least-recently-used', () => {
    const lru = new ByteLru(100, 60);
    const body = (n: number) => new Uint8Array(n);
    lru.set('a', { status: 200, headers: {}, body: body(40) });
    lru.set('b', { status: 200, headers: {}, body: body(40) });
    expect(lru.get('a')).toBeDefined(); // refresh a
    lru.set('c', { status: 200, headers: {}, body: body(40) }); // budget forces eviction of b
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBeDefined();
    expect(lru.get('c')).toBeDefined();
    expect(lru.usedBytes).toBeLessThanOrEqual(100);
  });

  it('refuses oversized entries and replaces same-key entries without leaking bytes', () => {
    const lru = new ByteLru(100, 50);
    lru.set('big', { status: 200, headers: {}, body: new Uint8Array(51) });
    expect(lru.get('big')).toBeUndefined();
    lru.set('k', { status: 200, headers: {}, body: new Uint8Array(30) });
    lru.set('k', { status: 200, headers: {}, body: new Uint8Array(40) });
    expect(lru.usedBytes).toBe(40);
    expect(lru.size).toBe(1);
  });
});

describe('TokenBucketLimiter', () => {
  it('allows bursts then throttles at the sustained rate (fake clock)', () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(2, 3, () => t);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false); // burst exhausted
    expect(limiter.retryAfterSeconds('ip')).toBeGreaterThan(0);
    t += 500; // +0.5s = +1 token at 2/s
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false);
    t += 10_000; // refill caps at burst
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false);
  });

  it('keys are independent and idle buckets get swept', () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(1, 1, () => t);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    t += 200_000; // idle long past sweep cutoff
    expect(limiter.take('c')).toBe(true); // triggers sweep
    expect(limiter.trackedKeys).toBeLessThanOrEqual(2); // a/b swept (full+idle)
  });
});

describe('Registry (prometheus text)', () => {
  it('renders counters, histograms, and gauges in 0.0.4 text format', () => {
    const registry = new Registry();
    const c = registry.counter('reqs_total', 'requests');
    c.inc({ route: '/x', status: '200' });
    c.inc({ route: '/x', status: '200' });
    c.inc({ route: '/y', status: '404' });
    const h = registry.histogram('lat_seconds', 'latency', [0.1, 1]);
    h.observe({ route: '/x' }, 0.05);
    h.observe({ route: '/x' }, 0.5);
    registry.gauge('cache_bytes', 'bytes', () => 42);

    const text = registry.render();
    expect(text).toContain('# TYPE reqs_total counter');
    expect(text).toContain('reqs_total{route="/x",status="200"} 2');
    expect(text).toContain('reqs_total{route="/y",status="404"} 1');
    expect(text).toContain('lat_seconds_bucket{route="/x",le="0.1"} 1');
    expect(text).toContain('lat_seconds_bucket{route="/x",le="+Inf"} 2');
    expect(text).toContain('lat_seconds_count{route="/x"} 2');
    expect(text).toContain('# TYPE cache_bytes gauge');
    expect(text).toContain('cache_bytes 42');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('routeLabel cardinality', () => {
  it('collapses ids and unknown paths', () => {
    expect(routeLabel('/content/abci0')).toBe('/content/:id');
    expect(routeLabel('/ord/v1/proof/xyzi0')).toBe('/ord/v1/proof/:id');
    expect(routeLabel('/r/blockheight')).toBe('/r/*');
    expect(routeLabel('/blockheight')).toBe('/chain');
    expect(routeLabel('/secret/../../etc')).toBe('other');
  });
});

describe('gateway ops integration', () => {
  const upstreamBody = 'proxied bytes';
  const stub: FetchFn = async (url: string) => {
    if (url.includes('/r/blockheight')) {
      return new Response('767430', {
        headers: { 'content-type': 'text/plain', 'content-length': '6' },
      });
    }
    return new Response(upstreamBody, {
      headers: { 'content-type': 'text/plain', 'content-length': String(upstreamBody.length) },
    });
  };

  const server = createGateway({
    upstream: 'https://up.test',
    esplora: ['https://e.test'],
    mode: 'proxy',
    fetchFn: stub,
    rateLimitPerSec: 0, // separate limiter test below
  });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('caches immutable 200s: MISS then HIT, and /metrics reflects it', async () => {
    const first = await fetch(`${base}/r/blockheight`);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(await first.text()).toBe('767430');
    const second = await fetch(`${base}/r/blockheight`);
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(await second.text()).toBe('767430');

    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('gateway_cache_hits_total 1');
    expect(metrics).toContain('# TYPE gateway_http_requests_total counter');
    expect(metrics).toMatch(/gateway_http_request_duration_seconds_count\{route="\/r\/\*"\} \d+/);
  });

  it('rate limits per IP with retry-after', async () => {
    const limited = createGateway({
      upstream: 'https://up.test',
      esplora: ['https://e.test'],
      fetchFn: stub,
      rateLimitPerSec: 1,
      rateBurst: 2,
    });
    await new Promise<void>((resolve) => limited.listen(0, () => resolve()));
    const lbase = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${lbase}/r/blockheight`)).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    const last = await fetch(`${lbase}/r/blockheight`);
    if (last.status === 429) {
      expect(Number(last.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    }
    // health/metrics are exempt
    expect((await fetch(`${lbase}/healthz`)).status).toBe(200);
    expect((await fetch(`${lbase}/metrics`)).status).toBe(200);
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  });

  it('streams oversized bodies through uncached', async () => {
    const big = 'x'.repeat(64);
    const bigStub: FetchFn = async () =>
      new Response(big, {
        headers: { 'content-type': 'text/plain', 'content-length': String(big.length) },
      });
    const tiny = createGateway({
      upstream: 'https://up.test',
      esplora: ['https://e.test'],
      fetchFn: bigStub,
      cacheMaxEntryBytes: 16, // force the streaming path
      rateLimitPerSec: 0,
    });
    await new Promise<void>((resolve) => tiny.listen(0, () => resolve()));
    const tbase = `http://127.0.0.1:${(tiny.address() as AddressInfo).port}`;
    const res = await fetch(`${tbase}/r/blockheight`);
    expect(await res.text()).toBe(big);
    expect(res.headers.get('x-cache')).toBeNull(); // streamed, not cached
    const again = await fetch(`${tbase}/r/blockheight`);
    expect(again.headers.get('x-cache')).toBeNull();
    await new Promise<void>((resolve) => tiny.close(() => resolve()));
  });
});
