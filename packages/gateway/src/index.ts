import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isInscriptionId, parseInscriptionId } from '@ord-resolver/core';
import {
  buildProofBundle,
  EsploraBackend,
  OrdResolver,
  toResponse,
  type FetchFn,
} from '@ord-resolver/fetch';

/**
 * Reference ord gateway (SPEC-GATEWAY.md).
 *
 * Two personalities, switchable per deployment:
 *
 * - proxy   : replicate an upstream ord server's /content and /r/* surface
 *             with ord-parity headers. Availability play only; adds no trust.
 * - verify  : serve /content only after locally verifying the bytes against
 *             Bitcoin (L2 by default) via esplora backends. The gateway
 *             becomes trust-minimized: a compromised upstream cannot make it
 *             serve forged content.
 *
 * Both personalities additionally serve:
 *   GET /ord/v1/proof/<id>?level=l2|l3   proof bundles for client-side verification
 *   GET /ord/v1/verified/<id>            verified content with x-ord-* attestation headers
 *   GET /healthz
 *
 * This is a reference implementation: no rate limiting, no caching layer, no
 * TLS. Front it accordingly in production.
 */

export interface GatewayOptions {
  port?: number;
  upstream?: string;
  esplora?: string[];
  mode?: 'proxy' | 'verify';
  verification?: 'L2' | 'L3';
  fetchFn?: FetchFn;
}

// ord-parity security headers for /content (see research: ord server.rs)
const CONTENT_CSP = [
  "default-src 'self' 'unsafe-eval' 'unsafe-inline' data: blob:",
  "default-src *:*/content/ *:*/blockheight *:*/blockhash *:*/blockhash/ *:*/blocktime *:*/r/ 'unsafe-eval' 'unsafe-inline' data: blob:",
];
const IMMUTABLE = 'public, max-age=1209600, immutable';

function send(res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(typeof body === 'string' ? body : Buffer.from(body));
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(value, null, 2), { 'content-type': 'application/json', ...headers });
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

  async function proxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const url = `${upstream}${path}`;
    const upstreamRes = await fetchFn(url, {
      headers: { 'accept-encoding': req.headers['accept-encoding'] ?? 'identity' },
    });
    const body = new Uint8Array(await upstreamRes.arrayBuffer());
    const headers: Record<string, string | string[]> = {};
    for (const name of ['content-type', 'content-encoding', 'cache-control']) {
      const v = upstreamRes.headers.get(name);
      if (v) headers[name] = v;
    }
    if (path.startsWith('/content/')) {
      headers['cache-control'] = IMMUTABLE;
      headers['content-security-policy'] = CONTENT_CSP;
    }
    send(res, upstreamRes.status, body, headers);
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

    // proof bundles
    const proofMatch = path.match(/^\/ord\/v1\/proof\/([^/]+)$/);
    if (proofMatch) {
      const id = proofMatch[1];
      if (!isInscriptionId(id)) return sendJson(res, 400, { error: `invalid inscription id: ${id}` });
      const wanted = (url.searchParams.get('level') ?? 'l2').toUpperCase() === 'L3' ? 'L3' : 'L2';
      try {
        const bundle = await tryBackends(esploras, (e) => buildProofBundle(e, parseInscriptionId(id), wanted));
        return send(res, 200, JSON.stringify(bundle), {
          'content-type': 'application/vnd.ord.proof+json; version=1',
          'cache-control': IMMUTABLE,
        });
      } catch (e) {
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }

    // verified content
    const verifiedMatch = path.match(/^\/ord\/v1\/verified\/([^/]+)$/);
    if (verifiedMatch) {
      const id = verifiedMatch[1];
      if (!isInscriptionId(id)) return sendJson(res, 400, { error: `invalid inscription id: ${id}` });
      try {
        const result = await resolver.resolve(`ord:${id}/content`);
        const response = toResponse(result);
        const headers: Record<string, string | string[]> = { 'content-security-policy': CONTENT_CSP };
        response.headers.forEach((v, k) => (headers[k] = v));
        return send(res, 200, new Uint8Array(await response.arrayBuffer()), headers);
      } catch (e) {
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }

    // content: proxy or verify-then-serve
    const contentMatch = path.match(/^\/content\/([^/]+)$/);
    if (contentMatch && mode === 'verify') {
      const id = contentMatch[1];
      if (!isInscriptionId(id)) return sendJson(res, 400, { error: `invalid inscription id: ${id}` });
      try {
        const result = await resolver.resolve(`ord:${id}/content`);
        const response = toResponse(result);
        const headers: Record<string, string | string[]> = { 'content-security-policy': CONTENT_CSP };
        response.headers.forEach((v, k) => (headers[k] = v));
        return send(res, 200, new Uint8Array(await response.arrayBuffer()), headers);
      } catch (e) {
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
        return await proxy(req, res, path + url.search);
      } catch (e) {
        return sendJson(res, 502, { error: (e as Error).message });
      }
    }

    return sendJson(res, 404, {
      error: 'not found',
      routes: ['/content/<id>', '/r/*', '/ord/v1/proof/<id>?level=l2|l3', '/ord/v1/verified/<id>', '/healthz'],
    });
  }

  return createServer((req, res) => {
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

/** CLI entry: node --experimental-strip-types or tsx packages/gateway/src/index.ts */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8317);
  const gateway = createGateway({
    port,
    upstream: process.env.ORD_UPSTREAM,
    esplora: process.env.ESPLORA?.split(','),
    mode: (process.env.GATEWAY_MODE as 'proxy' | 'verify') ?? 'proxy',
  });
  gateway.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`ord gateway listening on :${port}`);
  });
}
