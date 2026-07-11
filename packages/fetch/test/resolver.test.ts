import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  internalToDisplay,
  buildMerkleBranch,
  serializeBlock,
  sha256,
} from '@ordspv/core';
import { OrdResolver, OrdResolveError, toResponse } from '../src/index.js';
import type { FetchFn } from '../src/backends.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type TestBlock,
} from '../../core/test/helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insc0');
const read = (f: string) => readFileSync(join(FIXTURES, f), 'utf8').trim();

const INSC0 = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
const REVEAL = INSC0.slice(0, 64);
const COMMIT = '274bda6667e60bedede0d87f351220da4089427e6122f7d0bbd8e662b3796358';
const BLOCK = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';

type Route = string | Uint8Array | object;

function stubFetch(routes: Record<string, Route>): FetchFn {
  return async (url: string) => {
    const route = routes[url];
    if (route === undefined) return new Response(`no stub for ${url}`, { status: 404 });
    if (route instanceof Uint8Array) return new Response(route.slice());
    if (typeof route === 'string') return new Response(route);
    return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
  };
}

const E = 'https://esplora.test';

function insc0Routes(): Record<string, Route> {
  return {
    [`${E}/tx/${REVEAL}/status`]: { confirmed: true, block_height: 767430, block_hash: BLOCK },
    [`${E}/tx/${REVEAL}/hex`]: read('reveal.hex'),
    [`${E}/tx/${REVEAL}/merkle-proof`]: JSON.parse(read('merkle-proof.json')),
    [`${E}/block/${BLOCK}/header`]: read('header-767430.hex'),
    [`${E}/block/${BLOCK}`]: { id: BLOCK, height: 767430, tx_count: 2332 },
    [`${E}/tx/${COMMIT}/hex`]: read('commit.hex'),
  };
}

describe('OrdResolver L2 against real inscription 0 (stubbed transport)', () => {
  const resolver = new OrdResolver({
    esplora: [E],
    fetchFn: stubFetch(insc0Routes()),
    verification: 'L2',
  });

  it('resolves ord:<id> to verified PNG bytes', async () => {
    const result = await resolver.resolve(`ord:${INSC0}`);
    expect(result.body.length).toBe(793);
    expect(bytesToHex(result.body.slice(0, 8))).toBe('89504e470d0a1a0a');
    expect(result.contentType).toBe('image/png');
    expect(result.verification.level).toBe('L2');
    expect(result.verification.l2).toEqual({
      controlBlockDepth: 0,
      singleLeafTree: true,
      singleInputReveal: true,
    });
    // height 767430 is a compiled-in checkpoint: no live header sources needed
    expect(result.verification.headerTrust?.checkpointHit).toBe(true);
  });

  it('serves a proper Response with verification headers', async () => {
    const res = await resolver.fetch(`ord://${INSC0}/content`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-ord-verification')).toBe('L2');
    expect(res.headers.get('x-ord-height')).toBe('767430');
    expect((await res.arrayBuffer()).byteLength).toBe(793);
  });

  it('enforces integrity pins', async () => {
    const good = await resolver.resolve(`ord:${INSC0}`);
    const digest = good.verification.bodySha256!;
    const pinned = await resolver.resolve(`ord:${INSC0}#integrity=sha256-${digest}`);
    expect(pinned.verification.integrityChecked).toBe(true);

    await expect(
      resolver.resolve(`ord:${INSC0}#integrity=sha256-${'0'.repeat(64)}`),
    ).rejects.toMatchObject({ code: 'INTEGRITY' });
  });

  it('detects a corrupted reveal tx from a malicious backend', async () => {
    const routes = insc0Routes();
    const tampered = read('reveal.hex').replace('89504e47', '89504e48'); // flip a content byte
    routes[`${E}/tx/${REVEAL}/hex`] = tampered;
    const bad = new OrdResolver({ esplora: [E], fetchFn: stubFetch(routes), verification: 'L2' });
    await expect(bad.resolve(`ord:${INSC0}`)).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });
});

describe('OrdResolver synthetic flows', () => {
  function esploraRoutesForBlock(block: TestBlock, height: number): Record<string, Route> {
    const routes: Record<string, Route> = {
      [`${E}/block/${block.blockHash}/header`]: block.headerHex.trim(),
      [`${E}/block/${block.blockHash}`]: {
        id: block.blockHash,
        height,
        tx_count: block.txCount,
      },
      [`${E}/block-height/${height}`]: block.blockHash,
      [`${E}/blocks/tip/height`]: String(height + 10),
      [`${E}/block/${block.blockHash}/raw`]: serializeBlock(
        hexToBytes(block.headerHex),
        block.txs,
      ),
    };
    const txids = block.txs.map((t) => t.txidLE);
    block.txs.forEach((tx, pos) => {
      routes[`${E}/tx/${tx.txid}/status`] = {
        confirmed: true,
        block_height: height,
        block_hash: block.blockHash,
      };
      routes[`${E}/tx/${tx.txid}/hex`] = bytesToHex(tx.raw);
      routes[`${E}/tx/${tx.txid}/merkle-proof`] = {
        block_height: height,
        merkle: buildMerkleBranch(txids, pos).map(internalToDisplay),
        pos,
      };
    });
    return routes;
  }

  it('follows a delegate one hop under L2 and verifies both inscriptions', async () => {
    const scriptB = envelopeScript(
      { fields: [[1, 'text/html']], body: ['<h1>delegated</h1>'] },
      { checksigPrefix: true },
    );
    const tapB = taprootCommit(scriptB);
    const commitB = commitTx(tapB.scriptPubKey);
    const revealB = revealTx([{ script: scriptB, controlBlock: tapB.controlBlock }], {
      prevTxidLE: commitB.txidLE,
      vout: 0,
    });
    const idB = `${revealB.txid}i0`;

    // A delegates to B and has no body of its own
    const idValue = hexToBytes(idB.slice(0, 64)).reverse();
    const scriptA = envelopeScript(
      { fields: [[11, idValue]] },
      { checksigPrefix: true },
    );
    const tapA = taprootCommit(scriptA);
    const commitA = commitTx(tapA.scriptPubKey);
    const revealA = revealTx([{ script: scriptA, controlBlock: tapA.controlBlock }], {
      prevTxidLE: commitA.txidLE,
      vout: 0,
    });
    const idA = `${revealA.txid}i0`;

    const block = buildBlock([revealA, revealB]);
    const routes = esploraRoutesForBlock(block, 100);
    routes[`${E}/tx/${commitA.txid}/hex`] = bytesToHex(commitA.raw);
    routes[`${E}/tx/${commitB.txid}/hex`] = bytesToHex(commitB.raw);

    const resolver = new OrdResolver({ esplora: [E], fetchFn: stubFetch(routes) });

    // /content follows the delegate
    const viaContent = await resolver.resolve(`ord:${idA}/content`);
    expect(new TextDecoder().decode(viaContent.body)).toBe('<h1>delegated</h1>');
    expect(viaContent.contentType).toBe('text/html');
    expect(viaContent.viaDelegate).toBe(idB);

    // the bare URI referent is the ORIGINAL content, absent here
    await expect(resolver.resolve(`ord:${idA}`)).rejects.toMatchObject({ code: 'NO_CONTENT' });
  });

  it('verifies at L3 from a raw block fetch', async () => {
    const script = envelopeScript(
      { fields: [[1, 'text/plain']], body: ['strongest level'] },
      { checksigPrefix: true },
    );
    const tap = taprootCommit(script);
    const commit = commitTx(tap.scriptPubKey);
    const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    const block = buildBlock([reveal]);
    const routes = esploraRoutesForBlock(block, 100);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);

    const resolver = new OrdResolver({ esplora: [E], fetchFn: stubFetch(routes) });
    const result = await resolver.resolve(`ord:${reveal.txid}i0`, { verification: 'L3' });
    expect(result.verification.level).toBe('L3');
    expect(new TextDecoder().decode(result.body)).toBe('strongest level');
  });

  it('serves gateway mode with and without integrity pins', async () => {
    const content = new TextEncoder().encode('gateway bytes');
    const digest = bytesToHex(sha256(content));
    const O = 'https://ord.test';
    const fetchFn: FetchFn = async (url: string) => {
      if (url === `${O}/r/undelegated-content/${INSC0}`) {
        return new Response(content.slice(), { headers: { 'content-type': 'text/plain' } });
      }
      return new Response('nope', { status: 404 });
    };
    const resolver = new OrdResolver({ ordGateways: [O], fetchFn, verification: 'none' });

    const plain = await resolver.resolve(`ord:${INSC0}`);
    expect(new TextDecoder().decode(plain.body)).toBe('gateway bytes');
    expect(plain.verification.level).toBe('none');

    const pinned = await resolver.resolve(`ord:${INSC0}#integrity=sha256-${digest}`, {
      verification: 'L1',
    });
    expect(pinned.verification.level).toBe('L1');
    expect(pinned.verification.integrityChecked).toBe(true);

    await expect(
      resolver.resolve(`ord:${INSC0}#integrity=sha256-${'1'.repeat(64)}`, { verification: 'L1' }),
    ).rejects.toMatchObject({ code: 'INTEGRITY' });

    await expect(resolver.resolve(`ord:${INSC0}`, { verification: 'L1' })).rejects.toMatchObject({
      code: 'INTEGRITY',
    });
  });

  it('falls through failing backends to the next one', async () => {
    const routes = insc0Routes();
    const goodStub = stubFetch(routes);
    const flaky: FetchFn = async (url) => {
      if (url.startsWith('https://down.test')) return new Response('boom', { status: 500 });
      return goodStub(url.replace('https://esplora.test', E));
    };
    const resolver = new OrdResolver({
      esplora: ['https://down.test', E],
      fetchFn: flaky,
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${INSC0}`);
    expect(result.verification.level).toBe('L2');
  });

  it('toResponse carries delegate and hash metadata', async () => {
    const resolver = new OrdResolver({
      esplora: [E],
      fetchFn: stubFetch(insc0Routes()),
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${INSC0}`);
    const res = toResponse(result);
    expect(res.headers.get('x-ord-body-sha256')).toBe(result.verification.bodySha256);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });
});
