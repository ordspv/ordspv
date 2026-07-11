import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyProofBundle, type ProofBundleJson } from '@ord-resolver/core';
import type { FetchFn } from '@ord-resolver/fetch';
import { createGateway } from '../src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insc0');
const read = (f: string) => readFileSync(join(FIXTURES, f), 'utf8').trim();

const INSC0 = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
const REVEAL = INSC0.slice(0, 64);
const COMMIT = '274bda6667e60bedede0d87f351220da4089427e6122f7d0bbd8e662b3796358';
const BLOCK = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';
const E = 'https://esplora.test';
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

const stub: FetchFn = async (url) => routes[url]?.() ?? new Response(`no stub: ${url}`, { status: 404 });

describe('gateway', () => {
  const server = createGateway({ upstream: U, esplora: [E], mode: 'verify', fetchFn: stub });
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
    expect((await res.arrayBuffer()).byteLength).toBe(793);
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
