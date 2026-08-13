/**
 * Custody builder driven against a mock esplora: the backend is only a
 * pathfinder; every path it reports is re-proven locally. Synthetic blocks
 * are regtest-difficulty, so powLimitBits is disabled and checkpoints are
 * empty, mirroring the adversarial suite.
 *
 * These were local to `custody.test.ts` until the SPEC-CUSTODY conformance
 * suite needed the same stub: several of its builder rows are only honest if
 * they drive a real build, and a second copy of the routing table is how two
 * files drift apart.
 */

import { bytesToHex, buildMerkleBranch, hexToBytes, internalToDisplay, parseTx } from '@ordspv/core';
import type { ParsedTx } from '@ordspv/core';
import type { FetchFn } from '../src/backends.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type TestBlock,
} from '../../core/test/helpers.js';

export const E = 'https://esplora.test';
export const E2 = 'https://esplora2.test';
// attester-only stub: anchoring needs two agreeing sources that did not build
// the bundle, and E is the builder
export const E3 = 'https://esplora3.test';

export type Route = string | Uint8Array | object | (() => Promise<Response> | Response);

export function stubFetch(routes: Record<string, Route>): FetchFn {
  return async (url: string) => {
    const route = routes[url];
    if (route === undefined) return new Response(`no stub for ${url}`, { status: 404 });
    if (typeof route === 'function') return route();
    if (route instanceof Uint8Array) return new Response(route.slice());
    if (typeof route === 'string') return new Response(route);
    return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
  };
}

export function routesForBlock(
  block: TestBlock,
  height: number,
  tipHeight: number,
): Record<string, Route> {
  const routes: Record<string, Route> = {
    [`${E}/block/${block.blockHash}/header`]: block.headerHex.trim(),
    [`${E}/block/${block.blockHash}`]: { id: block.blockHash, height, tx_count: block.txCount },
    [`${E}/block-height/${height}`]: block.blockHash,
    [`${E}/blocks/tip/height`]: String(tipHeight),
    [`${E2}/block-height/${height}`]: block.blockHash,
    [`${E2}/blocks/tip/height`]: String(tipHeight),
    [`${E3}/block-height/${height}`]: block.blockHash,
    [`${E3}/blocks/tip/height`]: String(tipHeight),
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

/** copy every route registered for `from` onto `to` */
export function mirror(
  routes: Record<string, Route>,
  from: string,
  to: string,
): Record<string, Route> {
  const out = { ...routes };
  for (const [url, route] of Object.entries(routes)) {
    if (url.startsWith(from)) out[to + url.slice(from.length)] = route;
  }
  return out;
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** legacy (no-witness) spend of a single outpoint into given output values */
export function legacySpend(
  prevTxidDisplay: string,
  vout: number,
  outputValues: bigint[],
): ParsedTx {
  const parts: Uint8Array[] = [u32le(2), new Uint8Array([1])];
  parts.push(
    hexToBytes(prevTxidDisplay).reverse(),
    u32le(vout),
    new Uint8Array([1, 0x51]),
    u32le(0xffffffff),
  );
  parts.push(new Uint8Array([outputValues.length]));
  for (const v of outputValues) parts.push(u64le(v), new Uint8Array([1, 0x51]));
  parts.push(u32le(0));
  return parseTx(cat(...parts));
}

/** a single-input reveal in its own block, the shape most rows start from */
export function inscriptionSetup(): {
  commit: ParsedTx;
  reveal: ParsedTx;
  block: TestBlock;
  id: string;
} {
  const script = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['custody'] },
    { checksigPrefix: true },
  );
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  const block = buildBlock([reveal]);
  return { commit, reveal, block, id: `${reveal.txid}i0` };
}

export const OPTS = {
  esplora: [E, E2],
  anchorSources: [E2, E3],
  powLimitBits: null as null,
  checkpoints: new Map<number, string>(),
};
