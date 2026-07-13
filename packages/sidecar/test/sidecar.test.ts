import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bytesToHex,
  verifyProofBundle,
  type ProofBundleJson,
} from '@ordspv/core';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type TestBlock,
} from '../../core/test/helpers.js';
import { serializeBlock } from '@ordspv/core';
import { CoreRpcBackend, CoreRpcError, coreRpc, createSidecar, type RpcCall } from '../src/index.js';

/**
 * Offline sidecar tests: a synthetic consensus-shaped block (mined header,
 * BIP-141 witness commitment) behind a stubbed Bitcoin Core RPC. The served
 * bundles are verified CLIENT-side with verifyProofBundle, so these tests
 * cover the entire loop node operators rely on.
 */

function makeChain(): {
  rpc: RpcCall;
  calls: string[];
  block: TestBlock;
  inscriptionId: string;
  height: number;
} {
  const script = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['sidecar proof'] },
    { checksigPrefix: true },
  );
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  const block = buildBlock([commit, reveal]);
  const height = 4242;
  const revealPos = block.txs.findIndex((t) => t.txid === reveal.txid);
  expect(revealPos).toBeGreaterThan(0);

  const headerHex = block.headerHex;
  const calls: string[] = [];
  const rpc: RpcCall = async (method, params) => {
    calls.push(method);
    const p0 = params[0] as string;
    switch (method) {
      case 'getblockchaininfo':
        return { chain: 'regtest', blocks: height, pruned: false };
      case 'getrawtransaction': {
        const tx = block.txs.find((t) => t.txid === p0);
        // real Core: RPC error -5 when the tx is unknown (or txindex is off)
        if (!tx) throw new CoreRpcError(-5, 'No such mempool or blockchain transaction');
        if (params[1] === true) return { txid: p0, blockhash: block.blockHash };
        return bytesToHex(tx.raw);
      }
      case 'getblockheader': {
        if (p0 !== block.blockHash) throw new Error('block not found');
        if (params[1] === false) return headerHex;
        return {
          hash: block.blockHash,
          height,
          nTx: block.txCount,
          time: 1_700_000_000,
          merkleroot: 'unused',
        };
      }
      case 'getblock': {
        if (p0 !== block.blockHash) throw new Error('block not found');
        if (params[1] === 0) {
          return bytesToHex(serializeBlock(hexToBytesLocal(headerHex), block.txs));
        }
        return { tx: block.txs.map((t) => t.txid) };
      }
      default:
        throw new Error(`unstubbed rpc ${method}`);
    }
  };
  return { rpc, calls, block, inscriptionId: `${reveal.txid}i0`, height };
}

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('CoreRpcBackend + sidecar service (stubbed Core RPC)', () => {
  const { rpc, inscriptionId, height, block } = makeChain();
  const server = createSidecar({ rpc });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('healthz reports the node view', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chain).toBe('regtest');
    expect(body.blocks).toBe(height);
  });

  it('serves an L2 bundle that verifies client-side', async () => {
    const res = await fetch(`${base}/ord/v1/proof/${inscriptionId}?level=l2`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/vnd.ord.proof+json');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const bundle = (await res.json()) as ProofBundleJson;
    expect(bundle.level).toBe('L2');
    const verified = verifyProofBundle(bundle);
    expect(new TextDecoder().decode(verified.inscription.body)).toBe('sidecar proof');
    expect(verified.height).toBe(height);
  });

  it('serves an L3 bundle (witness tree from the raw block) that verifies client-side', async () => {
    const res = await fetch(`${base}/ord/v1/proof/${inscriptionId}?level=l3`);
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as ProofBundleJson;
    expect(bundle.level).toBe('L3');
    expect(bundle.witness).toBeDefined();
    const verified = verifyProofBundle(bundle);
    expect(verified.level).toBe('L3');
    expect(new TextDecoder().decode(verified.inscription.body)).toBe('sidecar proof');
  });

  it('rejects malformed ids and 404s unknown inscriptions', async () => {
    expect((await fetch(`${base}/ord/v1/proof/zzz`)).status).toBe(400);
    const unknown = `${'ab'.repeat(32)}i0`;
    expect((await fetch(`${base}/ord/v1/proof/${unknown}`)).status).toBe(404);
  });

  it('caches immutable bundles: MISS then HIT (canonical key ignores junk params)', async () => {
    const cached = createSidecar({ rpc, rateLimitPerSec: 0 });
    await new Promise<void>((resolve) => cached.listen(0, () => resolve()));
    const cbase = `http://127.0.0.1:${(cached.address() as AddressInfo).port}`;
    const miss = await fetch(`${cbase}/ord/v1/proof/${inscriptionId}?level=l2`);
    expect(miss.headers.get('x-cache')).toBe('MISS');
    // same route, extra junk query param + redundant level => same cache entry
    const hit = await fetch(`${cbase}/ord/v1/proof/${inscriptionId}?level=l2&bust=1`);
    expect(hit.headers.get('x-cache')).toBe('HIT');
    const a = await miss.json();
    const b = await hit.json();
    expect(b).toEqual(a);
    // l3 is a distinct cache dimension
    const l3 = await fetch(`${cbase}/ord/v1/proof/${inscriptionId}?level=l3`);
    expect(l3.headers.get('x-cache')).toBe('MISS');
    await new Promise<void>((resolve) => cached.close(() => resolve()));
  });

  it('rate limits per client with 429 + retry-after (healthz included)', async () => {
    const limited = createSidecar({ rpc, rateLimitPerSec: 1, rateBurst: 2, cacheMaxBytes: 0 });
    await new Promise<void>((resolve) => limited.listen(0, () => resolve()));
    const lbase = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${lbase}/healthz`)).status);
    const limited429 = statuses.filter((s) => s === 429);
    expect(limited429.length).toBeGreaterThanOrEqual(1);
    const last = await fetch(`${lbase}/healthz`);
    if (last.status === 429) expect(Number(last.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  });

  it('never relays a bundle it cannot verify (lying node)', async () => {
    // same chain, but the node serves a TAMPERED header: the sidecar's own
    // verifyProofBundle must reject before anything is relayed
    const lyingRpc: RpcCall = async (method, params) => {
      if (method === 'getblockheader' && params[1] === false) {
        const tampered = hexToBytesLocal(block.headerHex);
        tampered[40] ^= 0x01; // merkle root byte
        return bytesToHex(tampered);
      }
      return rpc(method, params);
    };
    const lying = createSidecar({ rpc: lyingRpc });
    await new Promise<void>((resolve) => lying.listen(0, () => resolve()));
    const lyingBase = `http://127.0.0.1:${(lying.address() as AddressInfo).port}`;
    const res = await fetch(`${lyingBase}/ord/v1/proof/${inscriptionId}`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    await new Promise<void>((resolve) => lying.close(() => resolve()));
  });
});

describe('coreRpc client', () => {
  it('carries basic auth from the URL and unwraps JSON-RPC results/errors', async () => {
    const seen: { auth?: string; body?: string }[] = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        auth: (init?.headers as Record<string, string>)?.authorization,
        body: init?.body as string,
      });
      const req = JSON.parse(init?.body as string);
      if (req.method === 'ok') {
        return new Response(JSON.stringify({ result: 42, error: null, id: req.id }));
      }
      return new Response(
        JSON.stringify({ result: null, error: { code: -5, message: 'nope' }, id: req.id }),
        { status: 500 },
      );
    }) as typeof fetch;

    const rpc = coreRpc('http://user:hunter2@127.0.0.1:8332', fetchFn);
    expect(await rpc('ok', [1, 'a'])).toBe(42);
    expect(seen[0].auth).toBe(`Basic ${Buffer.from('user:hunter2').toString('base64')}`);
    await expect(rpc('missing', [])).rejects.toMatchObject({ code: -5 });
  });

  it('passes an abort signal (deadline) and caps the response body', async () => {
    let sawSignal = false;
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      const req = JSON.parse(init?.body as string);
      // a response body far larger than the tiny cap below
      return new Response(JSON.stringify({ result: 'x'.repeat(100_000), error: null, id: req.id }));
    }) as typeof fetch;
    const rpc = coreRpc('http://127.0.0.1:8332', fetchFn, { maxResponseBytes: 1024 });
    await expect(rpc('big', [])).rejects.toThrow(/exceeded cap|content-length/);
    expect(sawSignal).toBe(true);
  });
});

describe('CoreRpcBackend merkle parity', () => {
  it('produces display-order branches identical to the esplora convention', async () => {
    const { rpc, block } = makeChain();
    const backend = new CoreRpcBackend(rpc);
    const revealTxid = block.txs[2].txid;
    const proof = await backend.getMerkleProof(revealTxid);
    expect(proof.pos).toBe(2);
    // fixture-locked convention: same branch the test-block helper derives
    expect(proof.merkle).toEqual(block.txidBranch(2));
  });
});
