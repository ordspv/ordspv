/**
 * Data-source adapters. Two families:
 *
 * - EsploraBackend: any esplora-API instance (mempool.space, blockstream.info,
 *   self-hosted electrs/esplora). Serves every proof ingredient: raw txs,
 *   txid merkle proofs, headers, block metadata, raw blocks. CANNOT serve
 *   content by inscription id. That's fine; the resolver derives content
 *   from the reveal tx itself.
 *
 * - OrdBackend: any ord server (ordinals.com, self-hosted). Serves content,
 *   recursion endpoints, and raw txs (/r/tx). Treated as UNTRUSTED: anything
 *   consumed from it is either re-verified or explicitly marked unverified.
 *
 * All requests carry a deadline and a per-endpoint response-size cap
 * (see http.ts): a hung or oversized backend rejects, which is what lets the
 * resolver fail over to the next one.
 */

import {
  DEFAULT_HTTP_TIMEOUT_MS,
  fetchCapped,
  ResponseCapExceededError,
  type CappedResponse,
} from './http.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Bounded retry for transient failures (rate limits, 503s, network errors). */
export interface RetryLimits {
  /** attempts per request INCLUDING the first (1 disables retry) */
  maxAttempts: number;
  /** exponential backoff base; the delay is jittered across [0, base*2^n] */
  baseDelayMs: number;
  /** backoff ceiling before jitter */
  maxDelayMs: number;
}

/** Per-request deadline and per-endpoint response-size caps. */
export interface BackendLimits {
  /** whole-request deadline (connect + body), ms */
  timeoutMs: number;
  /** small JSON/text endpoints: status, block info, merkle proofs, heights */
  smallMaxBytes: number;
  /** block header hex */
  headerMaxBytes: number;
  /** raw transaction hex (a consensus-maximal tx is ~4MB, i.e. ~8MB hex) */
  txMaxBytes: number;
  /** raw block bytes (consensus maximum 4,000,000) */
  blockMaxBytes: number;
  /** inscription content / metadata bodies */
  contentMaxBytes: number;
  retry: RetryLimits;
}

/** BackendLimits as callers pass it: every field optional, retry included. */
export type BackendLimitsInit = Partial<Omit<BackendLimits, 'retry'>> & {
  retry?: Partial<RetryLimits>;
};

export const DEFAULT_BACKEND_LIMITS: BackendLimits = {
  timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
  smallMaxBytes: 64 * 1024,
  headerMaxBytes: 16 * 1024,
  txMaxBytes: 9 * 1024 * 1024,
  blockMaxBytes: 4_100_000,
  contentMaxBytes: 9 * 1024 * 1024,
  retry: { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 8_000 },
};

/** Fill a partial limits object, merging the nested retry group. */
export function resolveLimits(init: BackendLimitsInit = {}): BackendLimits {
  return {
    ...DEFAULT_BACKEND_LIMITS,
    ...init,
    retry: { ...DEFAULT_BACKEND_LIMITS.retry, ...init.retry },
  };
}

/**
 * Canonical form of a backend base URL, for comparing one endpoint to another.
 *
 * Header anchoring excludes the backends that served a bundle from the vote,
 * and that exclusion is a set membership test. Host names are case-insensitive
 * in DNS and HTTP, so two spellings that differ only in case address the same
 * server; comparing raw strings let such a spelling pass as an independent
 * attester and vote for the header it had just served. Scheme and host are
 * lowercased, a single trailing dot on the host folds away (a root-anchored
 * FQDN resolves to the same name), and trailing slashes go. The URL parser has
 * already dropped a default port (:443 on https, :80 on http) by the time this
 * code sees the parts; a non-default port stays, since it is a different
 * endpoint. The path keeps its case, since path components are case-sensitive.
 *
 * This is canonicalization for comparison and not a general URL cleaner. Two
 * hostnames belonging to one operator stay two entries, because no string
 * function can know they are related. Operator diversity remains the caller's
 * responsibility.
 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '') + (parsed.port ? `:${parsed.port}` : '');
  return `${scheme}//${host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
}

/** Statuses worth trying again: the server said "later", not "no". */
const RETRYABLE_STATUS = new Set([429, 503]);

/** Retry-After is honored up to this; beyond it the header is ignored. */
const MAX_RETRY_AFTER_MS = 30_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry-After as milliseconds: delta-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const seconds = Number(trimmed);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_RETRY_AFTER_MS) return undefined;
  return ms;
}

export interface EsploraMerkleProof {
  block_height: number;
  merkle: string[];
  pos: number;
}

export interface EsploraOutspend {
  spent: boolean;
  /** spending txid, present when spent */
  txid?: string;
  vin?: number;
  status?: EsploraTxStatus;
}

export interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraBlockInfo {
  id: string;
  height: number;
  tx_count: number;
  timestamp: number;
  merkle_root: string;
}

function okCapped(res: CappedResponse, url: string): CappedResponse {
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

const utf8 = new TextDecoder();

export class EsploraBackend {
  private readonly limits: BackendLimits;

  constructor(
    public readonly baseUrl: string,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    limits: BackendLimitsInit = {},
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.limits = resolveLimits(limits);
  }

  /** full jitter over the exponential window, or the server's own Retry-After */
  private backoffMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return retryAfterMs;
    const { baseDelayMs, maxDelayMs } = this.limits.retry;
    return Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  }

  /**
   * One bounded request, retried on rate limits, 503s and network errors.
   * Every attempt calls fetchCapped afresh, so each gets its own deadline and
   * its own AbortController; a retry loop wrapped around a single fetchCapped
   * would inherit the first attempt's already-fired abort.
   */
  private async get(path: string, maxBytes: number): Promise<CappedResponse> {
    const url = `${this.baseUrl}${path}`;
    const { maxAttempts } = this.limits.retry;
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= maxAttempts;
      let res: CappedResponse | undefined;
      let failure: unknown;
      try {
        res = await fetchCapped(url, {
          fetchFn: this.fetchFn,
          timeoutMs: this.limits.timeoutMs,
          maxBytes,
        });
      } catch (e) {
        failure = e;
      }
      let retryAfterMs: number | undefined;
      if (res !== undefined) {
        // okCapped throws for any non-2xx not worth trying again; that throw
        // must escape the loop rather than land in the catch above
        if (res.ok || last || !RETRYABLE_STATUS.has(res.status)) return okCapped(res, url);
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      } else if (last || failure instanceof ResponseCapExceededError) {
        // an oversized body is a property of the response, not a hiccup
        throw failure;
      }
      await this.sleep(this.backoffMs(attempt, retryAfterMs));
    }
  }

  private async text(path: string, maxBytes: number): Promise<string> {
    return utf8.decode((await this.get(path, maxBytes)).bytes);
  }

  private async json<T>(path: string, maxBytes: number): Promise<T> {
    return JSON.parse(await this.text(path, maxBytes)) as T;
  }

  getTxHex(txid: string): Promise<string> {
    return this.text(`/tx/${txid}/hex`, this.limits.txMaxBytes);
  }

  getTxStatus(txid: string): Promise<EsploraTxStatus> {
    return this.json(`/tx/${txid}/status`, this.limits.smallMaxBytes);
  }

  getMerkleProof(txid: string): Promise<EsploraMerkleProof> {
    return this.json(`/tx/${txid}/merkle-proof`, this.limits.smallMaxBytes);
  }

  getHeaderHex(blockHash: string): Promise<string> {
    return this.text(`/block/${blockHash}/header`, this.limits.headerMaxBytes);
  }

  getBlockInfo(blockHash: string): Promise<EsploraBlockInfo> {
    return this.json(`/block/${blockHash}`, this.limits.smallMaxBytes);
  }

  getBlockHashAtHeight(height: number): Promise<string> {
    return this.text(`/block-height/${height}`, this.limits.smallMaxBytes);
  }

  getTipHeight(): Promise<string> {
    return this.text('/blocks/tip/height', this.limits.smallMaxBytes);
  }

  getOutspend(txid: string, vout: number): Promise<EsploraOutspend> {
    return this.json(`/tx/${txid}/outspend/${vout}`, this.limits.smallMaxBytes);
  }

  async getBlockRaw(blockHash: string): Promise<Uint8Array> {
    return (await this.get(`/block/${blockHash}/raw`, this.limits.blockMaxBytes)).bytes;
  }
}

/**
 * Every member of a pool failed one request.
 *
 * `PooledEsploraBackend.run` asks each member in turn and returns the first
 * answer that does not throw, so this class is raised only after all of them
 * have failed the same request. A caller looping over leads has nothing to
 * gain by leading again with another member, because the pool behind each
 * attempt holds the same members. The class exists so that caller can tell
 * pool exhaustion from a failure raised outside `run`, which is one attempt's
 * bad answer and worth another lead.
 */
export class PoolExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}

/**
 * N esplora backends behind one backend-shaped surface, rotating per request.
 *
 * The genealogy walk spends thousands of requests on one build, so a failure
 * partway through used to discard everything walked so far: fetchSatIdentity
 * looped over backends and restarted the walk from the reveal. Here a failing
 * request rotates to the next member and retries THAT REQUEST, so the walk
 * keeps its progress and only the request is repeated. A request fails when
 * every member has failed it.
 *
 * The starting member rotates per request so load spreads instead of always
 * landing on member 0, and `usedBaseUrls` records every member that actually
 * served bytes, which is what header anchoring must exclude from its vote.
 */
export class PooledEsploraBackend {
  readonly baseUrl: string;
  /** every member that served bytes for this pool's requests */
  readonly usedBaseUrls = new Set<string>();
  private cursor = 0;

  constructor(readonly members: EsploraBackend[]) {
    if (members.length === 0) throw new Error('PooledEsploraBackend needs at least one backend');
    this.baseUrl = `pool(${members.map((m) => m.baseUrl).join(', ')})`;
  }

  private async run<T>(label: string, call: (m: EsploraBackend) => Promise<T>): Promise<T> {
    const n = this.members.length;
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % n;
    const errors: string[] = [];
    for (let i = 0; i < n; i++) {
      const member = this.members[(start + i) % n];
      try {
        const value = await call(member);
        this.usedBaseUrls.add(member.baseUrl);
        return value;
      } catch (e) {
        errors.push(`${member.baseUrl}: ${(e as Error).message}`);
      }
    }
    throw new PoolExhaustedError(
      `all ${n} pooled backend(s) failed for ${label}:\n${errors.join('\n')}`,
    );
  }

  getTxHex(txid: string): Promise<string> {
    return this.run(`tx ${txid}`, (m) => m.getTxHex(txid));
  }

  getTxStatus(txid: string): Promise<EsploraTxStatus> {
    return this.run(`status ${txid}`, (m) => m.getTxStatus(txid));
  }

  getMerkleProof(txid: string): Promise<EsploraMerkleProof> {
    return this.run(`merkle-proof ${txid}`, (m) => m.getMerkleProof(txid));
  }

  getHeaderHex(blockHash: string): Promise<string> {
    return this.run(`header ${blockHash}`, (m) => m.getHeaderHex(blockHash));
  }

  getBlockInfo(blockHash: string): Promise<EsploraBlockInfo> {
    return this.run(`block ${blockHash}`, (m) => m.getBlockInfo(blockHash));
  }

  getBlockHashAtHeight(height: number): Promise<string> {
    return this.run(`block-height ${height}`, (m) => m.getBlockHashAtHeight(height));
  }

  getTipHeight(): Promise<string> {
    return this.run('tip height', (m) => m.getTipHeight());
  }

  getOutspend(txid: string, vout: number): Promise<EsploraOutspend> {
    return this.run(`outspend ${txid}:${vout}`, (m) => m.getOutspend(txid, vout));
  }

  getBlockRaw(blockHash: string): Promise<Uint8Array> {
    return this.run(`raw block ${blockHash}`, (m) => m.getBlockRaw(blockHash));
  }
}

export interface OrdInscriptionInfo {
  charms: string[];
  content_type: string | null;
  content_length: number | null;
  delegate: string | null;
  fee: number;
  height: number;
  id: string;
  number: number;
  output: string;
  sat: number | null;
  satpoint: string;
  timestamp: number;
  value: number | null;
  address: string | null;
}

export class OrdBackend {
  private readonly limits: BackendLimits;

  constructor(
    public readonly baseUrl: string,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    limits: BackendLimitsInit = {},
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.limits = resolveLimits(limits);
  }

  private async get(
    path: string,
    maxBytes: number,
    headers?: Record<string, string>,
  ): Promise<CappedResponse> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetchCapped(url, {
      fetchFn: this.fetchFn,
      timeoutMs: this.limits.timeoutMs,
      maxBytes,
      headers,
    });
    return okCapped(res, url);
  }

  /** buffered, bounded Response (headers preserved for content-type/encoding) */
  private toResponse(res: CappedResponse): Response {
    return new Response(res.bytes.slice(), { status: res.status, headers: res.headers });
  }

  /** raw content response (delegation applied by the server) */
  async content(id: string, acceptEncoding = 'br, gzip, identity'): Promise<Response> {
    const res = await this.get(`/content/${id}`, this.limits.contentMaxBytes, {
      'accept-encoding': acceptEncoding,
    });
    return this.toResponse(res);
  }

  /** original content, no delegate substitution */
  async undelegatedContent(id: string, acceptEncoding = 'br, gzip, identity'): Promise<Response> {
    const res = await this.get(`/r/undelegated-content/${id}`, this.limits.contentMaxBytes, {
      'accept-encoding': acceptEncoding,
    });
    return this.toResponse(res);
  }

  async inscriptionInfo(id: string): Promise<OrdInscriptionInfo> {
    const res = await this.get(`/r/inscription/${id}`, this.limits.smallMaxBytes);
    return JSON.parse(utf8.decode(res.bytes)) as OrdInscriptionInfo;
  }

  /** hex-encoded CBOR metadata (ord serves it as a JSON string) */
  async metadataHex(id: string): Promise<string> {
    const res = await this.get(`/r/metadata/${id}`, this.limits.contentMaxBytes);
    return JSON.parse(utf8.decode(res.bytes)) as string;
  }

  /** hex-encoded raw transaction (ord serves it as a JSON string) */
  async txHex(txid: string): Promise<string> {
    const res = await this.get(`/r/tx/${txid}`, this.limits.txMaxBytes);
    return JSON.parse(utf8.decode(res.bytes)) as string;
  }
}
