import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  buildMerkleBranch,
  hexToBytes,
  internalToDisplay,
  parseTx,
  type ParsedTx,
} from '@ordspv/core';
import { fetchCustody, CustodyError } from '../src/index.js';
import type { FetchFn } from '../src/backends.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type TestBlock,
} from '../../core/test/helpers.js';

/**
 * Custody builder driven against a mock esplora: the backend is only a
 * pathfinder; every path it reports is re-proven locally. Synthetic blocks
 * are regtest-difficulty, so powLimitBits is disabled and checkpoints are
 * empty, mirroring the adversarial suite.
 */

const E = 'https://esplora.test';
const E2 = 'https://esplora2.test';

type Route = string | Uint8Array | object | (() => Promise<Response> | Response);

function stubFetch(routes: Record<string, Route>): FetchFn {
  return async (url: string) => {
    const route = routes[url];
    if (route === undefined) return new Response(`no stub for ${url}`, { status: 404 });
    if (typeof route === 'function') return route();
    if (route instanceof Uint8Array) return new Response(route.slice());
    if (typeof route === 'string') return new Response(route);
    return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
  };
}

function routesForBlock(block: TestBlock, height: number, tipHeight: number): Record<string, Route> {
  const routes: Record<string, Route> = {
    [`${E}/block/${block.blockHash}/header`]: block.headerHex.trim(),
    [`${E}/block/${block.blockHash}`]: { id: block.blockHash, height, tx_count: block.txCount },
    [`${E}/block-height/${height}`]: block.blockHash,
    [`${E}/blocks/tip/height`]: String(tipHeight),
    [`${E2}/block-height/${height}`]: block.blockHash,
    [`${E2}/blocks/tip/height`]: String(tipHeight),
  };
  const txids = block.txs.map((t) => t.txidLE);
  block.txs.forEach((tx, pos) => {
    routes[`${E}/tx/${tx.txid}/status`] = { confirmed: true, block_height: height, block_hash: block.blockHash };
    routes[`${E}/tx/${tx.txid}/hex`] = bytesToHex(tx.raw);
    routes[`${E}/tx/${tx.txid}/merkle-proof`] = {
      block_height: height,
      merkle: buildMerkleBranch(txids, pos).map(internalToDisplay),
      pos,
    };
  });
  return routes;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** legacy (no-witness) spend of a single outpoint into given output values */
function legacySpend(prevTxidDisplay: string, vout: number, outputValues: bigint[]): ParsedTx {
  const parts: Uint8Array[] = [u32le(2), new Uint8Array([1])];
  parts.push(hexToBytes(prevTxidDisplay).reverse(), u32le(vout), new Uint8Array([1, 0x51]), u32le(0xffffffff));
  parts.push(new Uint8Array([outputValues.length]));
  for (const v of outputValues) parts.push(u64le(v), new Uint8Array([1, 0x51]));
  parts.push(u32le(0));
  return parseTx(cat(...parts));
}

function inscriptionSetup() {
  const script = envelopeScript({ fields: [[1, 'text/plain']], body: ['custody'] }, { checksigPrefix: true });
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  const block = buildBlock([reveal]);
  return { commit, reveal, block, id: `${reveal.txid}i0` };
}

const OPTS = {
  esplora: [E, E2],
  powLimitBits: null as null,
  checkpoints: new Map<number, string>(),
};

describe('fetchCustody', () => {
  it('proves an unspent reveal as a single hop and reports tip liveness per source', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    const routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    routes[`${E2}/tx/${reveal.txid}/outspend/0`] = { spent: false };

    const res = await fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes) });
    expect(res.custody.hops).toBe(1);
    expect(res.custody.satpoint.txid).toBe(reveal.txid);
    expect(res.custody.satpoint.offset).toBe(0n);
    expect(res.headerTrust).toHaveLength(1);
    expect(res.tip.map((t) => t.state)).toEqual(['unspent', 'unspent']);
    expect(res.pendingSpendTxid).toBeUndefined();
  });

  it('walks a confirmed spend into a two-hop verified path', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    const value = reveal.outputs[0].value;
    const spend = legacySpend(reveal.txid, 0, [value]); // no fee: offset preserved
    const blockB = buildBlock([spend]);

    const routes = {
      ...routesForBlock(block, 100, 120),
      ...routesForBlock(blockB, 105, 120),
    };
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = {
      spent: true,
      txid: spend.txid,
      vin: 0,
      status: { confirmed: true, block_height: 105, block_hash: blockB.blockHash },
    };
    routes[`${E}/tx/${spend.txid}/outspend/0`] = { spent: false };
    routes[`${E2}/tx/${spend.txid}/outspend/0`] = { spent: false };

    const res = await fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes) });
    expect(res.custody.hops).toBe(2);
    expect(res.custody.satpoint.txid).toBe(spend.txid);
    expect(res.custody.satpoint.vout).toBe(0);
    expect(res.custody.satpoint.offset).toBe(0n);
    expect(res.custody.genesis.txid).toBe(reveal.txid);
    expect(res.headerTrust).toHaveLength(2);
    expect(res.tip.map((t) => t.state)).toEqual(['unspent', 'unspent']);
  });

  it('rejects a backend whose claimed spender does not spend the satpoint', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    const unrelated = legacySpend('44'.repeat(32), 0, [1000n]);
    const routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = {
      spent: true,
      txid: unrelated.txid,
      vin: 0,
      status: { confirmed: true, block_height: 105, block_hash: block.blockHash },
    };
    routes[`${E}/tx/${unrelated.txid}/hex`] = bytesToHex(unrelated.raw);

    await expect(fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes) })).rejects.toThrow(
      CustodyError,
    );
    await expect(fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes) })).rejects.toThrow(
      /BUILD_FAILED|does not/,
    );
  });

  it('stops at an unconfirmed spend and reports it as pending', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    const value = reveal.outputs[0].value;
    const spend = legacySpend(reveal.txid, 0, [value]);
    const routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = {
      spent: true,
      txid: spend.txid,
      vin: 0,
      status: { confirmed: false },
    };
    routes[`${E2}/tx/${reveal.txid}/outspend/0`] = {
      spent: true,
      txid: spend.txid,
      vin: 0,
      status: { confirmed: false },
    };

    const res = await fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes) });
    expect(res.custody.hops).toBe(1);
    expect(res.pendingSpendTxid).toBe(spend.txid);
    expect(res.tip.map((t) => t.state)).toEqual(['spent', 'spent']);
  });
});
