/**
 * Data-source adapters. Two families:
 *
 * - EsploraBackend: any esplora-API instance (mempool.space, blockstream.info,
 *   self-hosted electrs/esplora). Serves every proof ingredient: raw txs,
 *   txid merkle proofs, headers, block metadata, raw blocks. CANNOT serve
 *   content by inscription id — that's fine; the resolver derives content
 *   from the reveal tx itself.
 *
 * - OrdBackend: any ord server (ordinals.com, self-hosted). Serves content,
 *   recursion endpoints, and raw txs (/r/tx). Treated as UNTRUSTED: anything
 *   consumed from it is either re-verified or explicitly marked unverified.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

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

async function ok(res: Response, url: string): Promise<Response> {
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

export class EsploraBackend {
  constructor(
    public readonly baseUrl: string,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async text(path: string): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    return (await ok(await this.fetchFn(url), url)).text();
  }

  private async json<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return (await ok(await this.fetchFn(url), url)).json() as Promise<T>;
  }

  getTxHex(txid: string): Promise<string> {
    return this.text(`/tx/${txid}/hex`);
  }

  getTxStatus(txid: string): Promise<EsploraTxStatus> {
    return this.json(`/tx/${txid}/status`);
  }

  getMerkleProof(txid: string): Promise<EsploraMerkleProof> {
    return this.json(`/tx/${txid}/merkle-proof`);
  }

  getHeaderHex(blockHash: string): Promise<string> {
    return this.text(`/block/${blockHash}/header`);
  }

  getBlockInfo(blockHash: string): Promise<EsploraBlockInfo> {
    return this.json(`/block/${blockHash}`);
  }

  getBlockHashAtHeight(height: number): Promise<string> {
    return this.text(`/block-height/${height}`);
  }

  getTipHeight(): Promise<string> {
    return this.text('/blocks/tip/height');
  }

  async getBlockRaw(blockHash: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}/block/${blockHash}/raw`;
    const res = await ok(await this.fetchFn(url), url);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** txid of the transaction at index `pos` in the block (esplora /txid endpoint) */
  getTxidAtBlockIndex(blockHash: string, pos: number): Promise<string> {
    return this.text(`/block/${blockHash}/txid/${pos}`);
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
  constructor(
    public readonly baseUrl: string,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** raw content response (delegation applied by the server) */
  async content(id: string, acceptEncoding = 'br, gzip, identity'): Promise<Response> {
    const url = this.url(`/content/${id}`);
    return ok(await this.fetchFn(url, { headers: { 'accept-encoding': acceptEncoding } }), url);
  }

  /** original content, no delegate substitution */
  async undelegatedContent(id: string, acceptEncoding = 'br, gzip, identity'): Promise<Response> {
    const url = this.url(`/r/undelegated-content/${id}`);
    return ok(await this.fetchFn(url, { headers: { 'accept-encoding': acceptEncoding } }), url);
  }

  async inscriptionInfo(id: string): Promise<OrdInscriptionInfo> {
    const url = this.url(`/r/inscription/${id}`);
    return (await ok(await this.fetchFn(url), url)).json() as Promise<OrdInscriptionInfo>;
  }

  /** hex-encoded CBOR metadata (ord serves it as a JSON string) */
  async metadataHex(id: string): Promise<string> {
    const url = this.url(`/r/metadata/${id}`);
    return (await ok(await this.fetchFn(url), url)).json() as Promise<string>;
  }

  /** hex-encoded raw transaction (ord serves it as a JSON string) */
  async txHex(txid: string): Promise<string> {
    const url = this.url(`/r/tx/${txid}`);
    return (await ok(await this.fetchFn(url), url)).json() as Promise<string>;
  }
}
