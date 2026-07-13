import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hexToBytes, parseTx, verifyProofBundle, type ProofBundleJson } from '@ordspv/core';
import type { FetchFn } from '@ordspv/fetch';
import { createGateway } from '../src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insc0');
const EXTENDED = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/extended');
const read = (f: string) => readFileSync(join(FIXTURES, f), 'utf8').trim();

const INSC0 = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
const REVEAL = INSC0.slice(0, 64);
const COMMIT = '274bda6667e60bedede0d87f351220da4089427e6122f7d0bbd8e662b3796358';
const BLOCK = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';
const BR = '6dc2c16a74dedcae46300b2058ebadc7ca78aea78236459662375c8d7d9804dbi0';
const E = 'https://esplora.test';
// independent attester: fail-closed anchoring needs a second source for
// non-checkpoint heights (the proof builder cannot vote for itself)
const E2 = 'https://esplora2.test';
const U = 'https://upstream.test';

const routes: Record<string, () => Response> = {
  [`${E}/tx/${REVEAL}/status`]: () =>
    Response.json({ confirmed: true, block_height: 767430, block_hash: BLOCK }),
  [`${E}/tx/${REVEAL}/hex`]: () => new Response(read('reveal.hex')),
  [`${E}/tx/${REVEAL}/merkle-proof`]: () => new Response(read('merkle-proof.json')),
  [`${E}/block/${BLOCK}/header`]: () => new Response(read('header-767430.hex')),
  [`${E}/block/${BLOCK}`]: () => Response.json({ id: BLOCK, height: 767430, tx_count: 2332 }),
  [`${E}/tx/${COMMIT}/hex`]: () => new Response(read('commit.hex')),
  [`${U}/r/blockheight`]: () => new Response('767430', { headers: { 'content-type': 'text/plain' } }),
};

// routes for the vendored brotli vector (tag-9 content-encoding attestation)
const brBundle = JSON.parse(
  readFileSync(join(EXTENDED, `${BR}.bundle.json`), 'utf8'),
) as ProofBundleJson;
const brSummary = JSON.parse(readFileSync(join(EXTENDED, `${BR}.json`), 'utf8'));
{
  const txid = BR.slice(0, 64);
  const commitTxid = parseTx(hexToBytes(brBundle.commit!.hex)).txid;
  Object.assign(routes, {
    [`${E}/tx/${txid}/status`]: () =>
      Response.json({ confirmed: true, block_height: brBundle.block.height, block_hash: brBundle.block.hash }),
    [`${E}/tx/${txid}/hex`]: () => new Response(brBundle.reveal.hex),
    [`${E}/tx/${txid}/merkle-proof`]: () =>
      Response.json({ block_height: brBundle.block.height, merkle: brBundle.reveal.txidBranch, pos: brBundle.reveal.pos }),
    [`${E}/block/${brBundle.block.hash}/header`]: () => new Response(brBundle.block.header),
    [`${E}/block/${brBundle.block.hash}`]: () =>
      Response.json({ id: brBundle.block.hash, height: brBundle.block.height, tx_count: brBundle.block.txCount }),
    [`${E}/tx/${commitTxid}/hex`]: () => new Response(brBundle.commit!.hex),
    [`${E}/block-height/${brBundle.block.height}`]: () => new Response(brBundle.block.hash),
    [`${E}/blocks/tip/height`]: () => new Response(String(brBundle.block.height + 100)),
    [`${E2}/block-height/${brBundle.block.height}`]: () => new Response(brBundle.block.hash),
    [`${E2}/blocks/tip/height`]: () => new Response(String(brBundle.block.height + 100)),
  });
}

const stub: FetchFn = async (url) => routes[url]?.() ?? new Response(`no stub: ${url}`, { status: 404 });

describe('gateway', () => {
  const server = createGateway({ upstream: U, esplora: [E, E2], mode: 'verify', fetchFn: stub });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('serves health', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('verify');
  });

  it('serves a valid L2 proof bundle that verifies client-side', async () => {
    const res = await fetch(`${base}/ord/v1/proof/${INSC0}?level=l2`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/vnd.ord.proof+json');
    const bundle = (await res.json()) as ProofBundleJson;
    const verified = verifyProofBundle(bundle);
    expect(verified.inscription.contentType).toBe('image/png');
  });

  it('verify mode serves /content only after verification, with attestation headers', async () => {
    const res = await fetch(`${base}/content/${INSC0}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ord-verification')).toBe('L2');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    // unencoded inscription: no tag-9, so no encoding attestation
    expect(res.headers.get('x-ord-content-encoding')).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(793);
  });

  it('attests tag-9 encoding via x-ord-content-encoding from the envelope, not transport', async () => {
    const res = await fetch(`${base}/content/${BR}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ord-verification')).toBe('L2');
    // the attestation survives server-side decompression…
    expect(res.headers.get('x-ord-content-encoding')).toBe('br');
    // …while transport Content-Encoding reflects the DECODED body being served
    expect(res.headers.get('content-encoding')).toBeNull();
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(brSummary.served.length); // decoded js, not the 1614 stored bytes
  });

  it('proxies recursion endpoints', async () => {
    const res = await fetch(`${base}/r/blockheight`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('767430');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects malformed ids', async () => {
    const res = await fetch(`${base}/ord/v1/proof/zzz`);
    expect(res.status).toBe(400);
  });
});
