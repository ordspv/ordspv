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
