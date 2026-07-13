import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isInscriptionId, parseInscriptionId } from '@ordspv/core';
import {
  buildProofBundle,
  EsploraBackend,
  OrdResolver,
  readBodyCapped,
  toResponse,
  type FetchFn,
} from '@ordspv/fetch';
import { ByteLru } from './lru.js';
import { Registry } from './metrics.js';
import { TokenBucketLimiter } from './ratelimit.js';

export { ByteLru } from './lru.js';
export { Counter, Histogram, Registry } from './metrics.js';
export { TokenBucketLimiter } from './ratelimit.js';

/**
 * Reference ord gateway (SPEC-GATEWAY.md).
 *
 * Personalities:
 * - proxy   : replicate an upstream ord server's /content and /r/* surface
 *             with ord-parity headers. Availability play only; adds no trust.
 * - verify  : serve /content only after locally verifying the bytes against
 *             Bitcoin (L2 by default) via esplora backends.
 *
 * Both serve:  GET /ord/v1/proof/<id>?level=l2|l3, GET /ord/v1/verified/<id>,
 *              GET /healthz, GET /metrics (prometheus text)
 *
 * Operational features (SPEC-GATEWAY §7): bounded byte-budget LRU on
 * immutable 200s (x-cache header), per-IP token-bucket rate limiting,
 * streaming proxy for oversized bodies, structured JSON request logs,
 * graceful shutdown. Verified responses are buffered, because a merkle proof
 * cannot be verified over bytes that have not all been read.
 */

export interface GatewayOptions {
  port?: number;
  upstream?: string;
  esplora?: string[];
  mode?: 'proxy' | 'verify';
  verification?: 'L2' | 'L3';
  fetchFn?: FetchFn;
  /** LRU budget across cached bodies (default 256 MiB; 0 disables) */
  cacheMaxBytes?: number;
  /** largest single cacheable body (default 8 MiB) */
  cacheMaxEntryBytes?: number;
  /** sustained requests/second per IP (default 10; 0 disables) */
  rateLimitPerSec?: number;
  /** burst size per IP (default 40) */
  rateBurst?: number;
  /**
   * Behind a load balancer / CDN: number of TRUSTED proxy hops in front of
   * this gateway (true = 1). The client IP is taken from the right of
   * X-Forwarded-For — the entries appended by your own proxies — never from
   * the client-controlled left end, and must parse as an IP address
   * (otherwise the socket address is used).
   */
  trustProxy?: boolean | number;
  /** structured log sink; false silences (default). CLI wires console.log. */
  log?: ((line: Record<string, unknown>) => void) | false;
}

// ord-parity security headers for /content (see research: ord server.rs)
const CONTENT_CSP = [
  "default-src 'self' 'unsafe-eval' 'unsafe-inline' data: blob:",
  "default-src *:*/content/ *:*/blockheight *:*/blockhash *:*/blockhash/ *:*/blocktime *:*/r/ 'unsafe-eval' 'unsafe-inline' data: blob:",
];
const IMMUTABLE = 'public, max-age=1209600, immutable';

function send(
  res: ServerResponse,
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, { 'access-control-allow-origin': '*', ...headers });
  res.end(typeof body === 'string' ? body : Buffer.from(body));
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(value, null, 2), { 'content-type': 'application/json', ...headers });
}

/** drop a :port suffix from an X-Forwarded-For entry (IPv4:port / [IPv6]:port) */
function stripPort(entry: string): string {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    return end === -1 ? entry : entry.slice(1, end);
  }
  const parts = entry.split(':');
  return parts.length === 2 ? parts[0] : entry;
}

/** low-cardinality route label for metrics/logs */
export function routeLabel(path: string): string {
  if (path === '/healthz') return 'healthz';
  if (path === '/metrics') return 'metrics';
  if (path.startsWith('/content/')) return '/content/:id';
  if (path.startsWith('/preview/')) return '/preview/:id';
  if (/^\/ord\/v1\/proof\//.test(path)) return '/ord/v1/proof/:id';
  if (/^\/ord\/v1\/verified\//.test(path)) return '/ord/v1/verified/:id';
  if (path.startsWith('/r/')) return '/r/*';
  if (path === '/blockheight' || path === '/blocktime' || path.startsWith('/blockhash')) return '/chain';
  return 'other';
}

export function createGateway(options: GatewayOptions = {}): Server {
  const upstream = (options.upstream ?? 'https://ordinals.com').replace(/\/+$/, '');
  const mode = options.mode ?? 'proxy';
  const level = options.verification ?? 'L2';
  const fetchFn: FetchFn = options.fetchFn ?? ((u, i) => fetch(u, i));
  const esploras = (options.esplora ?? ['https://mempool.space/api', 'https://blockstream.info/api']).map(
    (u) => new EsploraBackend(u, fetchFn),
  );
  const resolver = new OrdResolver({
    esplora: esploras.map((e) => e.baseUrl),
    ordGateways: [upstream],
    fetchFn,
    verification: level,
  });

  const cacheMaxBytes = options.cacheMaxBytes ?? 256 * 1024 * 1024;
  const cacheMaxEntry = options.cacheMaxEntryBytes ?? 8 * 1024 * 1024;
  const cache = new ByteLru(cacheMaxBytes, cacheMaxEntry);
  const ratePerSec = options.rateLimitPerSec ?? 10;
  const limiter = new TokenBucketLimiter(ratePerSec, options.rateBurst ?? 40);
  const log = options.log || undefined;

  const registry = new Registry();
  const mRequests = registry.counter('gateway_http_requests_total', 'HTTP requests by route/method/status');
  const mDuration = registry.histogram('gateway_http_request_duration_seconds', 'request latency');
  const mCacheHits = registry.counter('gateway_cache_hits_total', 'LRU cache hits');
  const mCacheMisses = registry.counter('gateway_cache_misses_total', 'LRU cache misses (cacheable routes only)');
  const mRateLimited = registry.counter('gateway_rate_limited_total', 'requests rejected by the per-IP token bucket');
  const mUpstreamErrors = registry.counter('gateway_upstream_errors_total', 'errors talking to upstream/esplora');
  registry.gauge('gateway_cache_bytes', 'bytes held by the LRU', () => cache.usedBytes);
  registry.gauge('gateway_cache_entries', 'entries in the LRU', () => cache.size);
  registry.gauge('gateway_ratelimit_tracked_ips', 'token buckets currently tracked', () => limiter.trackedKeys);

  const trustedHops =
    options.trustProxy === true ? 1 : typeof options.trustProxy === 'number' ? options.trustProxy : 0;

  function clientIp(req: IncomingMessage): string {
    if (trustedHops > 0) {
      const xff = req.headers['x-forwarded-for'];
      const joined = Array.isArray(xff) ? xff.join(',') : xff;
      const entries = (joined ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // the rightmost `trustedHops` entries were appended by our own proxies;
      // the client is the entry those hops vouch for. Leftmost entries are
      // attacker-controlled and never used.
      const candidate = entries[Math.max(0, entries.length - trustedHops)];
      if (candidate !== undefined) {
        const ip = stripPort(candidate);
        if (isIP(ip) !== 0) return ip;
      }
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** cache + send an immutable 200 */
  function sendCached(
    res: ServerResponse,
    cacheKey: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ): void {
    if (cacheMaxBytes > 0) cache.set(cacheKey, { status: 200, headers, body });
    send(res, 200, body, { ...headers, 'x-cache': 'MISS' });
  }

  async function proxy(req: IncomingMessage, res: ServerResponse, path: string, cacheKey: string): Promise<void> {
    const url = `${upstream}${path}`;
    const upstreamRes = await fetchFn(url, {
      headers: { 'accept-encoding': req.headers['accept-encoding'] ?? 'identity' },
    });
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'content-encoding', 'cache-control']) {
      const v = upstreamRes.headers.get(name);
      if (v) headers[name] = v;
    }
    if (path.startsWith('/content/')) {
      headers['cache-control'] = IMMUTABLE;
    }
    const extra: Record<string, string | string[]> = path.startsWith('/content/')
      ? { 'content-security-policy': CONTENT_CSP }
      : {};

    const length = Number(upstreamRes.headers.get('content-length') ?? NaN);
    const cacheable = upstreamRes.status === 200 && !Number.isNaN(length) && length <= cacheMaxEntry;
    if (cacheable || !upstreamRes.body) {
      // Content-Length may lie: the buffered read is capped regardless
      const body = await readBodyCapped(upstreamRes, cacheMaxEntry, url);
      if (upstreamRes.status === 200) {
        if (cacheMaxBytes > 0) cache.set(cacheKey, { status: 200, headers: { ...headers, ...flat(extra) }, body });
        return send(res, 200, body, { ...headers, ...extra, 'x-cache': 'MISS' });
      }
      return send(res, upstreamRes.status, body, { ...headers, ...extra });
    }
    // large or unknown-length body: stream through, uncached
    res.writeHead(upstreamRes.status, { 'access-control-allow-origin': '*', ...headers, ...extra });
    Readable.fromWeb(upstreamRes.body as import('node:stream/web').ReadableStream).pipe(res);
    await new Promise<void>((resolve) => res.on('close', resolve));
  }

  function flat(h: Record<string, string | string[]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v.join(', ') : v;
    return out;
  }

  /**
   * Cache keys are derived from canonicalized route inputs, never from the
   * raw query string: unknown parameters would otherwise mint unlimited
   * distinct entries for the same immutable response (cache-busting).
   */
  function cacheKeyFor(path: string, url: URL): string {
    if (/^\/ord\/v1\/proof\//.test(path)) {
      const level = (url.searchParams.get('level') ?? 'l2').toUpperCase() === 'L3' ? 'l3' : 'l2';
      return `${path}?level=${level}`;
    }
    return path;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const path = url.pathname;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (path === '/healthz') {
      return sendJson(res, 200, { ok: true, mode, upstream, esplora: esploras.map((e) => e.baseUrl) });
    }
    if (path === '/metrics') {
      return send(res, 200, registry.render(), { 'content-type': 'text/plain; version=0.0.4' });
    }

    // rate limit everything else
    if (ratePerSec > 0) {
      const ip = clientIp(req);
      if (!limiter.take(ip)) {
        mRateLimited.inc();
        return sendJson(res, 429, { error: 'rate limited' }, { 'retry-after': String(limiter.retryAfterSeconds(ip)) });
      }
    }

    // immutable-response cache (canonicalized key; see cacheKeyFor)
    const cacheKey = cacheKeyFor(path, url);
    if (cacheMaxBytes > 0) {
      const hit = cache.get(cacheKey);
      if (hit) {
        mCacheHits.inc();
        return send(res, hit.status, hit.body, { ...hit.headers, 'x-cache': 'HIT' });
      }
      mCacheMisses.inc();
    }

    // proof bundles
    const proofMatch = path.match(/^\/ord\/v1\/proof\/([^/]+)$/);
    if (proofMatch) {
      const id = proofMatch[1];
      if (!isInscriptionId(id)) return sendJson(res, 400, { error: `invalid inscription id: ${id}` });
      const wanted = (url.searchParams.get('level') ?? 'l2').toUpperCase() === 'L3' ? 'L3' : 'L2';
      try {
        const bundle = await tryBackends(esploras, (e) => buildProofBundle(e, parseInscriptionId(id), wanted));
        return sendCached(res, cacheKey, new TextEncoder().encode(JSON.stringify(bundle)), {
          'content-type': 'application/vnd.ord.proof+json; version=1',
          'cache-control': IMMUTABLE,
        });
      } catch (e) {
        mUpstreamErrors.inc();
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }

    // verified content (also the verify-mode /content handler)
    const verifiedMatch = path.match(/^\/ord\/v1\/verified\/([^/]+)$/);
    const contentMatch = path.match(/^\/content\/([^/]+)$/);
    if (verifiedMatch || (contentMatch && mode === 'verify')) {
      const id = (verifiedMatch ?? contentMatch)![1];
      if (!isInscriptionId(id)) return sendJson(res, 400, { error: `invalid inscription id: ${id}` });
      try {
        const result = await resolver.resolve(`ord:${id}/content`);
        const response = toResponse(result);
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => (headers[k] = v));
        headers['content-security-policy'] = CONTENT_CSP.join(', ');
        return sendCached(res, cacheKey, new Uint8Array(await response.arrayBuffer()), headers);
      } catch (e) {
        mUpstreamErrors.inc();
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }

    // ord-server surface passthrough (recursion compatibility)
    if (
      contentMatch ||
      path.startsWith('/r/') ||
      path.startsWith('/preview/') ||
      path === '/blockheight' ||
      path === '/blocktime' ||
      path.startsWith('/blockhash')
    ) {
      try {
        // the ord passthrough surface takes no query parameters: forward the
        // pathname only, so the cached body always matches the canonical
        // upstream response for that path
        return await proxy(req, res, path, cacheKey);
      } catch (e) {
        mUpstreamErrors.inc();
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }

    return sendJson(res, 404, {
      error: 'not found',
      routes: [
        '/content/<id>',
        '/r/*',
        '/ord/v1/proof/<id>?level=l2|l3',
        '/ord/v1/verified/<id>',
        '/healthz',
        '/metrics',
      ],
    });
  }

  return createServer((req, res) => {
    const started = performance.now();
    res.on('finish', () => {
      const seconds = (performance.now() - started) / 1000;
      const route = routeLabel(new URL(req.url ?? '/', 'http://x').pathname);
      mRequests.inc({ route, method: req.method ?? 'GET', status: String(res.statusCode) });
      mDuration.observe({ route }, seconds);
      log?.({
        t: new Date().toISOString(),
        msg: 'req',
        ip: clientIp(req),
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: Math.round(seconds * 1000),
        cache: res.getHeader('x-cache') ?? undefined,
        bytes: Number(res.getHeader('content-length') ?? 0) || undefined,
      });
    });
    handle(req, res).catch((e) => sendJson(res, 500, { error: (e as Error).message }));
  });
}

async function tryBackends<T>(backends: EsploraBackend[], fn: (e: EsploraBackend) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const b of backends) {
    try {
      return await fn(b);
    } catch (e) {
      errors.push(`${b.baseUrl}: ${(e as Error).message}`);
    }
  }
  throw new Error(`all backends failed: ${errors.join('; ')}`);
}

/** graceful shutdown: stop accepting, drain in-flight, force-close after grace */
export function installShutdown(server: Server, graceMs = 10_000, log?: (l: Record<string, unknown>) => void): void {
  let closing = false;
  const close = (signal: string) => {
    if (closing) return;
    closing = true;
    log?.({ t: new Date().toISOString(), msg: 'shutdown', signal, graceMs });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, graceMs).unref();
  };
  process.on('SIGTERM', () => close('SIGTERM'));
  process.on('SIGINT', () => close('SIGINT'));
}

/** CLI entry: npx tsx packages/gateway/src/index.ts */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8317);
  const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));
  const gateway = createGateway({
    port,
    upstream: process.env.ORD_UPSTREAM,
    esplora: process.env.ESPLORA?.split(','),
    mode: (process.env.GATEWAY_MODE as 'proxy' | 'verify') ?? 'proxy',
    verification: process.env.GATEWAY_LEVEL === 'L3' ? 'L3' : 'L2',
    cacheMaxBytes: process.env.CACHE_MAX_BYTES ? Number(process.env.CACHE_MAX_BYTES) : undefined,
    cacheMaxEntryBytes: process.env.CACHE_MAX_ENTRY_BYTES ? Number(process.env.CACHE_MAX_ENTRY_BYTES) : undefined,
    rateLimitPerSec: process.env.RATE_LIMIT ? Number(process.env.RATE_LIMIT) : undefined,
    rateBurst: process.env.RATE_BURST ? Number(process.env.RATE_BURST) : undefined,
    // TRUST_PROXY = number of trusted proxy hops (1 for a single LB/CDN)
    trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || 0 : undefined,
    log,
  });
  installShutdown(gateway, undefined, log);
  gateway.listen(port, () => {
    log({ t: new Date().toISOString(), msg: 'listening', port, mode: process.env.GATEWAY_MODE ?? 'proxy' });
  });
}
