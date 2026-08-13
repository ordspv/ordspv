import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { inscriptionIdError, parseInscriptionId, verifyProofBundle } from '@ordspv/core';
import {
  buildProofBundle,
  checkpointTrustHeader,
  DEFAULT_HTTP_TIMEOUT_MS,
  EsploraBackend,
  OrdResolveError,
  OrdResolver,
  readBodyCapped,
  toResponse,
  type BackendCause,
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
  /** header attesters (default `DEFAULT_ANCHOR_SOURCES`); never the proof backends */
  anchorSources?: string[];
  /**
   * `proxy` (default) or `verify`. Any other value falls back to `proxy` and
   * is reported on stderr, because a mode this gateway does not recognise must
   * never be served, or reported by `/healthz`, as though it verified.
   */
  mode?: GatewayMode;
  verification?: 'L2' | 'L3';
  /**
   * Compact-bits proof-of-work floor for the headers this gateway accepts,
   * both in the bundles it serves from `/ord/v1/proof` and in the content it
   * resolves. Defaults to the mainnet limit (0x1d00ffff); a gateway fronting a
   * regtest or signet chain passes that chain's limit, or null to disable the
   * floor.
   */
  powLimitBits?: number | null;
  /**
   * Compiled-in `height → hash` pairs this gateway holds every bundle to
   * (SPEC-VERIFICATION §4), on the proof endpoint and on the content it
   * resolves. Defaults to `MAINNET_CHECKPOINTS`, so a gateway that configures
   * nothing gets mainnet protection; a gateway fronting another chain passes
   * that chain's pairs, or an empty map, because mainnet hashes at a signet or
   * regtest height contradict every honest bundle served there.
   */
  checkpoints?: ReadonlyMap<number, string>;
  fetchFn?: FetchFn;
  /** LRU budget across cached bodies (default 256 MiB; 0 disables) */
  cacheMaxBytes?: number;
  /** largest single cacheable body (default 8 MiB) */
  cacheMaxEntryBytes?: number;
  /** deadline for each upstream proxy fetch in ms (default 20s) */
  upstreamTimeoutMs?: number;
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
/**
 * SPEC-GATEWAY §4's deliberate divergence from ord, on every content response
 * this gateway serves from either personality.
 */
const NOSNIFF = { 'x-content-type-options': 'nosniff' } as const;

/**
 * Whether a request's `Accept-Encoding` admits a content coding.
 *
 * Implemented, which is RFC 9110 §12.5.3 as far as one stored coding needs it:
 * the comma-separated token list, `*` as the fallback when no token names the
 * coding, and a `q` of zero as a refusal. An absent header admits everything.
 * An empty header admits nothing but identity, which is what the RFC says a
 * sender with no coding support looks like, so a non-identity coding is
 * refused.
 *
 * Not implemented, and not needed here: q-value ORDERING. A gateway holding one
 * stored encoding has nothing to choose between, so preference among several
 * codings cannot change this answer. Also not implemented are the identity
 * special cases beyond the empty-field rule, because this is only ever asked
 * about a coding the envelope declared, and `identity` is not one.
 *
 * A `q` that does not parse as a number is read as a refusal. That is the
 * fail-closed direction: the alternative is handing a client bytes it did not
 * agree to decode under a label its HTTP stack will not act on.
 */
export function acceptsEncoding(header: string | undefined, encoding: string): boolean {
  if (header === undefined) return true;
  const wanted = encoding.trim().toLowerCase();
  let wildcard: boolean | undefined;
  for (const element of header.split(',')) {
    const [rawToken, ...params] = element.split(';');
    const token = rawToken.trim().toLowerCase();
    if (token === '') continue;
    const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    const admitted = q === undefined || Number(q.slice(2)) > 0;
    // a token naming the coding settles it; `*` only speaks where none does
    if (token === wanted) return admitted;
    if (token === '*') wildcard = admitted;
  }
  return wildcard ?? false;
}

/** node gives repeated headers as an array; the RFC reads them as one list */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * SPEC-GATEWAY §4's negotiation, applied to a response about to be sent.
 * Answers 406 and returns true when the response carries a `Content-Encoding`
 * the request does not admit, in which case the caller must send nothing more.
 *
 * Only reachable when the resolver could not decode the stored encoding, which
 * is an unknown tag-9 value or a recognized one whose decode failed or ran past
 * its output bound. A decoded body carries no `Content-Encoding` and so
 * negotiates nothing, which is the `MAY decompress br server-side` arm of the
 * same sentence and is where the common cases land.
 *
 * `headers` is mutated to carry `Vary`, so one client's negotiated answer is
 * not reused for a client that negotiated differently, by this gateway's own
 * LRU or by any shared cache in front of it.
 */
function refusedEncoding(
  req: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string>,
): boolean {
  const encoding = headers['content-encoding'];
  if (encoding === undefined) return false;
  headers['vary'] = 'accept-encoding';
  if (acceptsEncoding(headerValue(req.headers['accept-encoding']), encoding)) return false;
  sendJson(res, 406, {
    error:
      `the stored bytes are ${encoding}-encoded, this gateway could not decode them, ` +
      `and the request's Accept-Encoding does not admit ${encoding}`,
  });
  return true;
}

/** upstream Cache-Control directives that veto insertion into the LRU */
function upstreamForbidsCaching(cacheControl: string | null): boolean {
  if (!cacheControl) return false;
  return cacheControl
    .toLowerCase()
    .split(',')
    .map((d) => d.trim())
    .some((d) => d === 'no-store' || d === 'no-cache' || d === 'private' || /^max-age\s*=\s*0+$/.test(d));
}

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

export type GatewayMode = 'proxy' | 'verify';

/**
 * Resolve a supplied mode to one of the two the gateway implements.
 *
 * The comparison that selects the verifying branch is `=== 'verify'`, so any
 * other spelling silently serves proxy bytes. `GATEWAY_MODE=Verify` used to do
 * exactly that while `/healthz` echoed `Verify` back as apparent confirmation.
 * An unrecognised value is reported on stderr and read as `proxy`, which is the
 * personality that claims the least.
 */
export function normalizeMode(value: unknown): GatewayMode {
  if (value === undefined || value === null) return 'proxy';
  if (value === 'proxy' || value === 'verify') return value;
  console.error(
    `gateway mode ${JSON.stringify(value)} is not "proxy" or "verify"; running in proxy mode`,
  );
  return 'proxy';
}

/**
 * A count supplied through the options, or the default when it is absent or
 * unusable.
 *
 * Every guard downstream is a `> 0` test, and `NaN > 0` is false, so a count
 * that arrives as `NaN` reads as "not requested" and switches the protection it
 * governs off. The same holds for a negative value. Neither is silently
 * honoured: the default applies and the substitution is reported.
 */
function count(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    console.error(`gateway option ${name}=${value} is not a count; using ${fallback}`);
    return fallback;
  }
  return value;
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
  const mode = normalizeMode(options.mode);
  const level = options.verification ?? 'L2';
  const fetchFn: FetchFn = options.fetchFn ?? ((u, i) => fetch(u, i));
  const esploras = (options.esplora ?? ['https://mempool.space/api', 'https://blockstream.info/api']).map(
    (u) => new EsploraBackend(u, fetchFn),
  );
  const resolver = new OrdResolver({
    esplora: esploras.map((e) => e.baseUrl),
    anchorSources: options.anchorSources,
    ordGateways: [upstream],
    fetchFn,
    verification: level,
    powLimitBits: options.powLimitBits,
    // the resolver reads the same set the proof endpoint does, so an operator
    // who moved this gateway off mainnet moves both surfaces at once. Left
    // unthreaded, a signet gateway configured with an empty map would still
    // hold its verified content path to mainnet hashes
    checkpoints: options.checkpoints,
  });

  // SPEC-VERIFICATION §4: the proof endpoint verifies offline, so the checkpoint
  // set is the only chain view it has. Built once, and with the argument left
  // undefined it is the mainnet set
  const trustHeader = checkpointTrustHeader(options.checkpoints);

  const cacheMaxBytes = count('cacheMaxBytes', options.cacheMaxBytes, 256 * 1024 * 1024);
  const cacheMaxEntry = count('cacheMaxEntryBytes', options.cacheMaxEntryBytes, 8 * 1024 * 1024);
  const upstreamTimeoutMs = count('upstreamTimeoutMs', options.upstreamTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const cache = new ByteLru(cacheMaxBytes, cacheMaxEntry);
  const ratePerSec = count('rateLimitPerSec', options.rateLimitPerSec, 10);
  const limiter = new TokenBucketLimiter(ratePerSec, count('rateBurst', options.rateBurst, 40));
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
    options.trustProxy === true
      ? 1
      : typeof options.trustProxy === 'number'
        ? count('trustProxy', options.trustProxy, 0)
        : 0;

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
    // Only /content/<id> bytes are immutable on the proxied ord surface;
    // /blockheight, /blocktime, /blockhash*, /r/*, /preview/* move with the
    // chain tip and must never be served stale from the LRU.
    const immutable = path.startsWith('/content/');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    const onClientClose = () => controller.abort();
    res.on('close', onClientClose);
    try {
      // fixed identity encoding: the cached body must be one canonical byte
      // sequence, not whichever variant the first client happened to negotiate
      const upstreamRes = await fetchFn(url, {
        headers: { 'accept-encoding': 'identity' },
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'cache-control']) {
        const v = upstreamRes.headers.get(name);
        if (v) headers[name] = v;
      }
      const forbidden = upstreamForbidsCaching(upstreamRes.headers.get('cache-control'));
      if (immutable && !forbidden) {
        headers['cache-control'] = IMMUTABLE;
      }
      // §4's header set is scoped to /content/<id>, which is the same surface
      // `immutable` selects, so nosniff travels with the CSP headers
      const extra: Record<string, string | string[]> = immutable
        ? { 'content-security-policy': CONTENT_CSP, ...NOSNIFF }
        : {};

      const mayCache = immutable && !forbidden && cacheMaxBytes > 0;
      const length = Number(upstreamRes.headers.get('content-length') ?? NaN);
      const bufferable = !Number.isNaN(length) && length <= cacheMaxEntry;
      if ((mayCache && bufferable) || !upstreamRes.body) {
        // Content-Length may lie: the buffered read is capped regardless
        const body = await readBodyCapped(upstreamRes, cacheMaxEntry, url, controller);
        if (upstreamRes.status === 200) {
          if (mayCache) {
            cache.set(cacheKey, { status: 200, headers: { ...headers, ...flat(extra) }, body });
            return send(res, 200, body, { ...headers, ...extra, 'x-cache': 'MISS' });
          }
          return send(res, 200, body, { ...headers, ...extra, 'x-cache': 'BYPASS' });
        }
        return send(res, upstreamRes.status, body, { ...headers, ...extra });
      }
      // mutable, cache-vetoed, oversized, or unknown-length: stream through,
      // uncached. The deadline covers connect + headers + buffered reads; a
      // streamed body paces at the client and is torn down by the client-close
      // abort instead.
      clearTimeout(timer);
      res.writeHead(upstreamRes.status, {
        'access-control-allow-origin': '*',
        ...headers,
        ...extra,
        ...(upstreamRes.status === 200 ? { 'x-cache': 'BYPASS' } : {}),
      });
      Readable.fromWeb(upstreamRes.body as import('node:stream/web').ReadableStream).pipe(res);
      await new Promise<void>((resolve) => res.on('close', resolve));
    } finally {
      clearTimeout(timer);
      res.off('close', onClientClose);
    }
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
      // the resolved configuration, never what was supplied: `mode` here is the
      // same variable the verify branch below compares against, so an operator
      // reading this endpoint reads the behaviour rather than their own input
      return sendJson(res, 200, {
        ok: true,
        mode,
        verification: level,
        upstream,
        esplora: esploras.map((e) => e.baseUrl),
      });
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
        // the LRU is keyed on the route and holds one canonical body, so the
        // negotiation runs again per request rather than being inherited from
        // whichever client happened to miss first
        const headers = { ...hit.headers, 'x-cache': 'HIT' };
        if (refusedEncoding(req, res, headers)) return;
        return send(res, hit.status, hit.body, headers);
      }
      mCacheMisses.inc();
    }

    // proof bundles
    const proofMatch = path.match(/^\/ord\/v1\/proof\/([^/]+)$/);
    if (proofMatch) {
      const id = proofMatch[1];
      const badId = inscriptionIdError(id);
      if (badId) return sendJson(res, 400, { error: badId });
      // parsed above the backend loop: the id decides nothing about any
      // backend, and a parse failure inside the loop was reported as
      // "all backends failed" for an input no backend was ever sent
      const parsed = parseInscriptionId(id);
      const wanted = (url.searchParams.get('level') ?? 'l2').toUpperCase() === 'L3' ? 'L3' : 'L2';
      try {
        const bundle = await tryBackends(esploras, (e) => buildProofBundle(e, parsed, wanted));
        // never relay a bundle we cannot verify (SPEC-GATEWAY §3). This sits
        // above sendCached, so a bundle that fails here also never enters the
        // LRU that would serve it to every later caller. The requested id is
        // named, so a backend that answers with a well-formed bundle for a
        // different inscription is refused here rather than relayed under the
        // caller's id and cached under the caller's key. The checkpoint hook is
        // what SPEC-VERIFICATION §4 binds a verifier to: a backend controls the
        // height it claims, and relabelling a genuine header to a checkpointed
        // height needs no forgery at all
        verifyProofBundle(bundle, {
          powLimitBits: options.powLimitBits,
          expectedInscriptionId: id,
          trustHeader,
        });
        return sendCached(res, cacheKey, new TextEncoder().encode(JSON.stringify(bundle)), {
          'content-type': 'application/vnd.ord.proof+json; version=1',
          'cache-control': IMMUTABLE,
        });
      } catch (e) {
        mUpstreamErrors.inc();
        return sendJson(res, statusForFailure(e), { error: (e as Error).message });
      }
    }

    // verified content (also the verify-mode /content handler)
    const verifiedMatch = path.match(/^\/ord\/v1\/verified\/([^/]+)$/);
    const contentMatch = path.match(/^\/content\/([^/]+)$/);
    if (verifiedMatch || (contentMatch && mode === 'verify')) {
      const id = (verifiedMatch ?? contentMatch)![1];
      const badId = inscriptionIdError(id);
      if (badId) return sendJson(res, 400, { error: badId });
      try {
        const result = await resolver.resolve(`ord:${id}/content`);
        const response = toResponse(result);
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => (headers[k] = v));
        headers['content-security-policy'] = CONTENT_CSP.join(', ');
        Object.assign(headers, NOSNIFF);
        // above sendCached, so a refused body never enters the LRU
        if (refusedEncoding(req, res, headers)) return;
        return sendCached(res, cacheKey, new Uint8Array(await response.arrayBuffer()), headers);
      } catch (e) {
        mUpstreamErrors.inc();
        return sendJson(res, statusForFailure(e), { error: (e as Error).message });
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

/**
 * Every configured backend failed, carrying each one's cause so the caller can
 * tell an absent inscription from an unreachable upstream.
 */
export class AllBackendsFailed extends Error {
  constructor(
    message: string,
    readonly causes: readonly BackendCause[],
  ) {
    super(message);
    this.name = 'AllBackendsFailed';
  }
}

/**
 * Whether one backend's failure says the inscription is not there, as opposed
 * to saying this backend could not answer.
 *
 * Four shapes qualify. The backend's own 404 means it looked and the
 * transaction is not in its index. A source saying the transaction was not
 * found says the same in words, which is how the Core-RPC path puts it. An
 * unconfirmed reveal means there is nothing on chain to prove yet. No envelope
 * at the requested index means the transaction is there and carries no such
 * inscription, which is the most definite absence of the four.
 *
 * `tx <txid> not found in block <hash>` is excluded on purpose, although it
 * reads like an absence and the general clause below would otherwise take it:
 * it is one source's status disagreeing with its own block data, which is bad
 * upstream data. Answering 404 to it would tell a caller the inscription does
 * not exist on the strength of a source contradicting itself.
 *
 * Exported because the sidecar answers the same question about the same
 * builder's errors, and two copies of this reasoning would drift.
 */
export function saysNotFound(message: string): boolean {
  if (/ not found in block /i.test(message)) return false;
  return (
    /-> HTTP 404\b/.test(message) ||
    /\bnot found\b/i.test(message) ||
    /\bis not confirmed\b/i.test(message) ||
    /\bno envelope at index\b/i.test(message)
  );
}

/**
 * The status for a whole backend loop having failed: 404 only when every
 * backend that was asked said the inscription is not there.
 *
 * Unanimity is the rule because one backend timing out while another answers
 * 404 is not an absence: the one that might have found it never spoke. With no
 * backends configured nothing said anything, so that is not an absence either.
 */
function statusForCauses(causes: readonly BackendCause[]): 404 | 502 {
  return causes.length > 0 && causes.every((c) => saysNotFound(c.message)) ? 404 : 502;
}

/**
 * SPEC-GATEWAY §3's error table, applied to whatever a resolve or a build
 * threw. `NO_CONTENT` is an absence of its own: the inscription resolved and
 * the referent the caller asked for has no bytes.
 */
function statusForFailure(e: unknown): 404 | 502 {
  if (e instanceof AllBackendsFailed) return statusForCauses(e.causes);
  if (e instanceof OrdResolveError) {
    if (e.code === 'NO_CONTENT') return 404;
    if (e.code === 'BACKEND') return statusForCauses(e.causes);
  }
  return 502;
}

async function tryBackends<T>(backends: EsploraBackend[], fn: (e: EsploraBackend) => Promise<T>): Promise<T> {
  const causes: BackendCause[] = [];
  for (const b of backends) {
    try {
      return await fn(b);
    } catch (e) {
      causes.push({ baseUrl: b.baseUrl, message: (e as Error).message });
    }
  }
  throw new AllBackendsFailed(
    `all backends failed: ${causes.map((c) => `${c.baseUrl}: ${c.message}`).join('; ')}`,
    causes,
  );
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

/**
 * Read a count out of the environment.
 *
 * An unset or empty variable yields undefined, so the option's own default
 * applies. Anything that is not a finite number at or above zero is reported on
 * stderr and yields undefined as well, so it also lands on the default.
 *
 * The guard is the point. `Number('abc')` is `NaN`, `??` does not catch `NaN`,
 * and every guard downstream is a `> 0` test that `NaN` fails: `RATE_LIMIT=abc`
 * switched per-IP rate limiting off, `CACHE_MAX_BYTES=abc` switched the LRU off,
 * and `UPSTREAM_TIMEOUT_MS=abc` reached `setTimeout(fn, NaN)`, which coerces to
 * 1 ms and aborted every proxied fetch. A typo must never disable a protection
 * quietly.
 */
function envCount(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name}=${raw} is not a count; ignoring it and using the default`);
    return undefined;
  }
  return value;
}

/**
 * Read the proof-of-work floor out of the environment: compact bits as a
 * number (`0x1e0377ae` and `503543726` are the same value), or `off` to
 * disable the floor.
 *
 * `deploy/docker-compose.yml` runs the reference deployment on signet, whose
 * powLimit target is easier than mainnet's, so the mainnet default refuses
 * every header that deployment serves. The option existed and nothing in the
 * environment reached it, which left the reference deployment with no verify
 * path at all.
 */
function envPowLimitBits(env: Record<string, string | undefined>): number | null | undefined {
  const raw = env.POW_LIMIT_BITS;
  if (raw === undefined || raw.trim() === '') return undefined;
  if (raw.trim().toLowerCase() === 'off') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(
      `POW_LIMIT_BITS=${raw} is not compact bits (e.g. 0x1e0377ae) or "off"; using the mainnet limit`,
    );
    return undefined;
  }
  return value;
}

/**
 * Read the checkpoint set out of the environment: `off` for no checkpoints, or
 * a comma-separated list of `height:hash` pairs in display order.
 *
 * `MAINNET_CHECKPOINTS` are mainnet block hashes, so a gateway on another chain
 * that reaches a checkpointed height would refuse every honest bundle its own
 * node served, the way the mainnet proof-of-work floor refused every signet
 * header before `POW_LIMIT_BITS` existed. `off` is what the reference signet
 * deployment sets; compiling a signet set is a separate decision.
 *
 * An unreadable pair leaves the whole variable on the mainnet default and says
 * so, because a partially applied checkpoint set is a weaker chain view than
 * either the set the operator asked for or the one the default gives.
 */
function envCheckpoints(
  env: Record<string, string | undefined>,
): ReadonlyMap<number, string> | undefined {
  const raw = env.CHECKPOINTS;
  if (raw === undefined || raw.trim() === '') return undefined;
  if (raw.trim().toLowerCase() === 'off') return new Map();
  const pairs = new Map<number, string>();
  for (const entry of raw.split(',')) {
    const [heightText, hash] = entry.trim().split(':');
    // digits before Number(), because `Number('')` is 0 and an entry that
    // stated no height at all would otherwise land on genesis, which is a real
    // checkpoint. The tip vote learned the same lesson at headertrust.ts
    const height = /^[0-9]+$/.test(heightText ?? '') ? Number(heightText) : NaN;
    if (!Number.isSafeInteger(height) || !/^[0-9a-f]{64}$/i.test(hash ?? '')) {
      console.error(
        `CHECKPOINTS entry "${entry.trim()}" is not <height>:<64-hex block hash> or "off"; ` +
          `using the mainnet checkpoints`,
      );
      return undefined;
    }
    pairs.set(height, hash.toLowerCase());
  }
  return pairs;
}

/**
 * Read a deployment's environment into gateway options.
 *
 * This is the layer where a typo becomes a running configuration, so it is
 * exported and takes the environment as an argument: the mapping is checkable
 * without a subprocess and without writing to `process.env`.
 *
 * Every count passes through `envCount`. `Number('abc')` is `NaN`, `??` does
 * not catch `NaN`, and every guard downstream is a `> 0` test that `NaN` fails,
 * so `RATE_LIMIT=abc` used to switch per-IP rate limiting off, `CACHE_MAX_BYTES=abc`
 * used to switch the LRU off, and `UPSTREAM_TIMEOUT_MS=abc` reached
 * `setTimeout(fn, NaN)`, which coerces to 1 ms and aborted every proxied fetch.
 * An unreadable value now lands on the documented default and says so.
 */
export function gatewayOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayOptions {
  return {
    port: envCount(env, 'PORT') ?? 8317,
    upstream: env.ORD_UPSTREAM,
    esplora: env.ESPLORA?.split(','),
    anchorSources: env.ANCHOR_SOURCES?.split(','),
    mode: normalizeMode(env.GATEWAY_MODE),
    verification: env.GATEWAY_LEVEL === 'L3' ? 'L3' : 'L2',
    powLimitBits: envPowLimitBits(env),
    checkpoints: envCheckpoints(env),
    cacheMaxBytes: envCount(env, 'CACHE_MAX_BYTES'),
    cacheMaxEntryBytes: envCount(env, 'CACHE_MAX_ENTRY_BYTES'),
    upstreamTimeoutMs: envCount(env, 'UPSTREAM_TIMEOUT_MS'),
    rateLimitPerSec: envCount(env, 'RATE_LIMIT'),
    rateBurst: envCount(env, 'RATE_BURST'),
    // TRUST_PROXY = number of trusted proxy hops (1 for a single LB/CDN)
    trustProxy: envCount(env, 'TRUST_PROXY'),
  };
}

/** CLI entry: npx tsx packages/gateway/src/index.ts */
if (import.meta.url === `file://${process.argv[1]}`) {
  const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));
  // the startup line reports these resolved options and never the environment
  // strings behind them, so it cannot echo a mode the gateway is not in
  const options = gatewayOptionsFromEnv();
  const gateway = createGateway({ ...options, log });
  installShutdown(gateway, undefined, log);
  gateway.listen(options.port, () => {
    log({
      t: new Date().toISOString(),
      msg: 'listening',
      port: options.port,
      mode: options.mode,
      verification: options.verification,
    });
  });
}
