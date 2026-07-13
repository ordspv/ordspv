import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  buildMerkleBranch,
  internalToDisplay,
  isInscriptionId,
  parseInscriptionId,
  hexToBytes,
  verifyProofBundle,
} from '@ordspv/core';
import {
  buildProofBundle,
  readBodyCapped,
  DEFAULT_HTTP_TIMEOUT_MS,
  type EsploraBlockInfo,
  type EsploraMerkleProof,
  type EsploraTxStatus,
  type ProofBackend,
} from '@ordspv/fetch';
import { ByteLru, TokenBucketLimiter } from '@ordspv/gateway';

/**
 * Proof sidecar: SPEC-VERIFICATION proof bundles served straight from a
 * Bitcoin Core node. Node operators get `/ord/v1/proof/<id>?level=l2|l3`
 * (SPEC-GATEWAY §3) without hosting an esplora/electrs stack; Core with
 * `txindex=1` is the only requirement.
 *
 * Trust model: identical to a gateway's proof endpoint. Bundles are
 * self-verifying, so the sidecar cannot forge content even if compromised;
 * it verifies every bundle before serving (availability + honesty of your
 * own node are all it adds).
 *
 *   CORE_RPC_URL=http://user:pass@127.0.0.1:8332 npx tsx packages/sidecar/src/index.ts
 */

// ---------------------------------------------------------------------------
// minimal Bitcoin Core JSON-RPC client
// ---------------------------------------------------------------------------

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export class CoreRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CoreRpcError';
  }
}

/**
 * JSON-RPC over HTTP with basic auth from the URL (http://user:pass@host:port).
 * Requests carry a deadline and the response read is size-capped (a raw
 * 4MB block arrives as ~8MB of hex inside the JSON envelope, hence the
 * generous default).
 */
export function coreRpc(
  url: string,
  fetchFn: typeof fetch = fetch,
  opts: { timeoutMs?: number; maxResponseBytes?: number } = {},
): RpcCall {
  const parsed = new URL(url);
  const auth =
    parsed.username || parsed.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`
      : undefined;
  const endpoint = `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '/' : parsed.pathname}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? 20 * 1024 * 1024;
  let nextId = 1;
  return async (method, params) => {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await readBodyCapped(res, maxResponseBytes, `${endpoint} ${method}`);
    const body = JSON.parse(new TextDecoder().decode(raw)) as {
      result?: unknown;
      error?: { code: number; message: string } | null;
    };
    if (body.error) throw new CoreRpcError(body.error.code, `${method}: ${body.error.message}`);
    if (!res.ok) throw new CoreRpcError(-1, `${method}: HTTP ${res.status}`);
    return body.result;
  };
}

// ---------------------------------------------------------------------------
// ProofBackend over Core RPC
// ---------------------------------------------------------------------------

const RPC_INVALID_ADDRESS_OR_KEY = -5; // Core: tx not found (or txindex off)

/**
 * Satisfies the same surface buildProofBundle consumes from esplora, from
 * four Core RPCs: getrawtransaction (txindex=1 REQUIRED for arbitrary
 * lookups), getblockheader, getblock (verbosity 0 and 1). Merkle branches
 * are computed locally from the block's txid list: no gettxoutproof
 * parsing, and the output is byte-compatible with esplora's display-order
 * convention.
 */
export class CoreRpcBackend implements ProofBackend {
  constructor(private readonly rpc: RpcCall) {}

  async getTxStatus(txid: string): Promise<EsploraTxStatus> {
    try {
      const verbose = (await this.rpc('getrawtransaction', [txid, true])) as {
        blockhash?: string;
      };
      if (!verbose.blockhash) return { confirmed: false };
      const header = (await this.rpc('getblockheader', [verbose.blockhash, true])) as {
        height: number;
        time: number;
      };
      return {
        confirmed: true,
        block_hash: verbose.blockhash,
        block_height: header.height,
        block_time: header.time,
      };
    } catch (e) {
      if (e instanceof CoreRpcError && e.code === RPC_INVALID_ADDRESS_OR_KEY) {
        throw new Error(
          `tx ${txid} not found. Is txindex=1 enabled on the node? (${e.message})`,
        );
      }
      throw e;
    }
  }

  async getTxHex(txid: string): Promise<string> {
    return (await this.rpc('getrawtransaction', [txid, false])) as string;
  }

  async getMerkleProof(txid: string): Promise<EsploraMerkleProof> {
    const status = await this.getTxStatus(txid);
    if (!status.confirmed || !status.block_hash || status.block_height === undefined) {
      throw new Error(`tx ${txid} is not confirmed`);
    }
    const block = (await this.rpc('getblock', [status.block_hash, 1])) as { tx: string[] };
    const pos = block.tx.indexOf(txid);
    if (pos === -1) throw new Error(`tx ${txid} not in block ${status.block_hash}`);
    const leavesLE = block.tx.map((t) => hexToBytes(t).reverse());
    return {
      block_height: status.block_height,
      merkle: buildMerkleBranch(leavesLE, pos).map(internalToDisplay),
      pos,
    };
  }

  async getHeaderHex(blockHash: string): Promise<string> {
    return (await this.rpc('getblockheader', [blockHash, false])) as string;
  }

  async getBlockInfo(blockHash: string): Promise<EsploraBlockInfo> {
    const header = (await this.rpc('getblockheader', [blockHash, true])) as {
      hash: string;
      height: number;
      nTx: number;
      time: number;
      merkleroot: string;
    };
    return {
      id: header.hash,
      height: header.height,
      tx_count: header.nTx,
      timestamp: header.time,
      merkle_root: header.merkleroot,
    };
  }

  async getBlockRaw(blockHash: string): Promise<Uint8Array> {
    const hex = (await this.rpc('getblock', [blockHash, 0])) as string;
    return hexToBytes(hex);
  }
}

// ---------------------------------------------------------------------------
// the HTTP service
// ---------------------------------------------------------------------------

export interface SidecarOptions {
  rpc: RpcCall;
  /** sustained requests/second per client IP (default 10; 0 disables) */
  rateLimitPerSec?: number;
  /** burst size per client IP (default 40) */
  rateBurst?: number;
  /** LRU byte budget across cached proof bundles (default 32 MiB; 0 disables) */
  cacheMaxBytes?: number;
  /** largest single cacheable bundle (default 4 MiB) */
  cacheMaxEntryBytes?: number;
}

const IMMUTABLE = 'public, max-age=1209600, immutable';

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'content-type': 'application/json',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

export function createSidecar(options: SidecarOptions): Server {
  const backend = new CoreRpcBackend(options.rpc);
  const ratePerSec = options.rateLimitPerSec ?? 10;
  const limiter = new TokenBucketLimiter(ratePerSec, options.rateBurst ?? 40);
  const cacheMaxBytes = options.cacheMaxBytes ?? 32 * 1024 * 1024;
  const cache = new ByteLru(cacheMaxBytes, options.cacheMaxEntryBytes ?? 4 * 1024 * 1024);

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://sidecar.local');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // every route is rate limited, /healthz included (it costs an RPC)
      if (ratePerSec > 0) {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!limiter.take(ip)) {
          return sendJson(
            res,
            429,
            { error: 'rate limited' },
            { 'retry-after': String(limiter.retryAfterSeconds(ip)) },
          );
        }
      }

      if (url.pathname === '/healthz') {
        try {
          const info = (await options.rpc('getblockchaininfo', [])) as {
            chain: string;
            blocks: number;
            pruned?: boolean;
          };
          return sendJson(res, 200, {
            ok: true,
            chain: info.chain,
            blocks: info.blocks,
            pruned: info.pruned ?? false,
          });
        } catch (e) {
          return sendJson(res, 502, { ok: false, error: (e as Error).message });
        }
      }
      const match = url.pathname.match(/^\/ord\/v1\/proof\/([^/]+)$/);
      if (!match) {
        return sendJson(res, 404, { error: 'not found', routes: ['/ord/v1/proof/<id>?level=l2|l3', '/healthz'] });
      }
      const id = match[1];
      if (!isInscriptionId(id)) {
        return sendJson(res, 400, { error: `invalid inscription id: ${id}` });
      }
      const level = (url.searchParams.get('level') ?? 'l2').toUpperCase() === 'L3' ? 'L3' : 'L2';

      // canonicalized cache key: pathname + normalized level, never raw search
      const cacheKey = `${url.pathname}?level=${level.toLowerCase()}`;
      if (cacheMaxBytes > 0) {
        const hit = cache.get(cacheKey);
        if (hit) {
          res.writeHead(hit.status, { ...hit.headers, 'x-cache': 'HIT' });
          return res.end(Buffer.from(hit.body));
        }
      }
      try {
        const bundle = await buildProofBundle(backend, parseInscriptionId(id), level);
        verifyProofBundle(bundle); // never relay a bundle we cannot verify
        const body = new TextEncoder().encode(JSON.stringify(bundle));
        const headers = {
          'access-control-allow-origin': '*',
          'content-type': 'application/vnd.ord.proof+json; version=1',
          'cache-control': IMMUTABLE,
        };
        if (cacheMaxBytes > 0) cache.set(cacheKey, { status: 200, headers, body });
        res.writeHead(200, { ...headers, 'x-cache': 'MISS' });
        return res.end(Buffer.from(body));
      } catch (e) {
        const message = (e as Error).message;
        const status = /not found|not confirmed|no envelope/i.test(message) ? 404 : 502;
        return sendJson(res, status, { error: message });
      }
    })().catch((e) => sendJson(res, 500, { error: (e as Error).message }));
  });
}

/** CLI entry */
if (import.meta.url === `file://${process.argv[1]}`) {
  const rpcUrl = process.env.CORE_RPC_URL;
  if (!rpcUrl) {
    console.error('CORE_RPC_URL required, e.g. http://user:pass@127.0.0.1:8332 (txindex=1)');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8318);
  // loopback by default: proof bundles are public data, but an RPC-backed
  // service should only face a wider network when explicitly told to
  const host = process.env.BIND ?? '127.0.0.1';
  createSidecar({ rpc: coreRpc(rpcUrl) }).listen(port, host, () => {
    console.log(`ord proof sidecar listening on ${host}:${port}`);
  });
}
