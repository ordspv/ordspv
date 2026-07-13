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

import { DEFAULT_HTTP_TIMEOUT_MS, fetchCapped, type CappedResponse } from './http.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

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
}

export const DEFAULT_BACKEND_LIMITS: BackendLimits = {
  timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
  smallMaxBytes: 64 * 1024,
  headerMaxBytes: 16 * 1024,
  txMaxBytes: 9 * 1024 * 1024,
  blockMaxBytes: 4_100_000,
  contentMaxBytes: 9 * 1024 * 1024,
};

export interface EsploraMerkleProof {
  block_height: number;
  merkle: string[];
  pos: number;
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
    limits: Partial<BackendLimits> = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.limits = { ...DEFAULT_BACKEND_LIMITS, ...limits };
  }

  private async get(path: string, maxBytes: number): Promise<CappedResponse> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetchCapped(url, {
      fetchFn: this.fetchFn,
      timeoutMs: this.limits.timeoutMs,
      maxBytes,
    });
    return okCapped(res, url);
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

  async getBlockRaw(blockHash: string): Promise<Uint8Array> {
    return (await this.get(`/block/${blockHash}/raw`, this.limits.blockMaxBytes)).bytes;
  }

  /** txid of the transaction at index `pos` in the block (esplora /txid endpoint) */
  getTxidAtBlockIndex(blockHash: string, pos: number): Promise<string> {
    return this.text(`/block/${blockHash}/txid/${pos}`, this.limits.smallMaxBytes);
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
    limits: Partial<BackendLimits> = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.limits = { ...DEFAULT_BACKEND_LIMITS, ...limits };
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
