/**
 * The SPEC-VERIFICATION row that binds the servers this repository ships
 * rather than a library: §4's requirement that a verifier consult a
 * compiled-in checkpoint where one applies.
 *
 * It lives in the sidecar package because that is the only package which may
 * import both servers: the sidecar depends on the gateway, and neither of the
 * two packages holding the other conformance files may depend on either.
 *
 * The accounting table is shared with the core suite
 * (`packages/core/test/spec-verification.rows.ts`), and the accounting test
 * that sums the whole spec lives in
 * `packages/core/test/spec-verification.conformance.test.ts`.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  serializeBlock,
  verifyProofBundle,
  type ProofBundleJson,
} from '@ordspv/core';
import type { FetchFn } from '@ordspv/fetch';
import { createGateway } from '@ordspv/gateway';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  NO_POW_FLOOR,
  revealTx,
  taprootCommit,
  type TestBlock,
} from '../../core/test/helpers.js';
import {
  drivenIdsFor,
  anchor,
  row,
} from '../../core/test/spec-verification.rows.js';
import { CoreRpcError, createSidecar, type RpcCall } from '../src/index.js';

// ---------------------------------------------------------------------------
// the test wrapper
// ---------------------------------------------------------------------------

/** ids this file speaks for, compared against the table at the bottom */
const SPOKEN: string[] = [];

function conformance(id: string, body: () => void | Promise<void>): void {
  const r = row(id);
  if (r.file !== 'servers') throw new Error(`row ${id} is assigned to the ${r.file} file`);
  SPOKEN.push(id);
  it(`SPEC-VERIFICATION.md ${r.section}: ${r.title}`, async () => {
    anchor(r.quote);
    await body();
  });
}

// ---------------------------------------------------------------------------
// one synthetic chain, served to both servers under a claimed height a
// compiled-in checkpoint pins to another hash
// ---------------------------------------------------------------------------

/**
 * A mainnet checkpoint height. The block below is mined at regtest difficulty
 * and hashes to something else entirely, which is the whole arrangement: a
 * backend controls the height it reports, and relabelling a block it really
 * holds to a checkpointed height needs no forgery.
 */
const CHECKPOINT_HEIGHT = 767430;
const E = 'https://esplora.test';

interface Chain {
  block: TestBlock;
  inscriptionId: string;
  revealTxid: string;
  commitTxid: string;
}

function makeChain(): Chain {
  const script = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['checkpointed'] },
    { checksigPrefix: true },
  );
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  return {
    block: buildBlock([commit, reveal]),
    inscriptionId: `${reveal.txid}i0`,
    revealTxid: reveal.txid,
    commitTxid: commit.txid,
  };
}

const CHAIN = makeChain();

/** the esplora surface `buildProofBundle` reads, claiming the checkpoint height */
function esploraRoutes(chain: Chain): Record<string, () => Response> {
  const { block } = chain;
  const routes: Record<string, () => Response> = {
    [`${E}/block/${block.blockHash}/header`]: () => new Response(block.headerHex),
    [`${E}/block/${block.blockHash}`]: () =>
      Response.json({ id: block.blockHash, height: CHECKPOINT_HEIGHT, tx_count: block.txCount }),
  };
  block.txs.forEach((tx, pos) => {
    routes[`${E}/tx/${tx.txid}/status`] = () =>
      Response.json({
        confirmed: true,
        block_height: CHECKPOINT_HEIGHT,
        block_hash: block.blockHash,
      });
    routes[`${E}/tx/${tx.txid}/hex`] = () => new Response(bytesToHex(tx.raw));
    routes[`${E}/tx/${tx.txid}/merkle-proof`] = () =>
      Response.json({
        block_height: CHECKPOINT_HEIGHT,
        merkle: block.txidBranch(pos),
        pos,
      });
  });
  return routes;
}

function stubFetch(chain: Chain): FetchFn {
  const routes = esploraRoutes(chain);
  return async (url: string) => routes[url]?.() ?? new Response(`no stub: ${url}`, { status: 404 });
}

/** the Core RPC surface the sidecar reads, claiming the same height */
function stubRpc(chain: Chain): RpcCall {
  const { block } = chain;
  return async (method, params) => {
    const p0 = params[0] as string;
    switch (method) {
      case 'getblockchaininfo':
        return { chain: 'regtest', blocks: CHECKPOINT_HEIGHT, pruned: false };
      case 'getrawtransaction': {
        const tx = block.txs.find((t) => t.txid === p0);
        if (!tx) throw new CoreRpcError(-5, 'No such mempool or blockchain transaction');
        if (params[1] === true) return { txid: p0, blockhash: block.blockHash };
        return bytesToHex(tx.raw);
      }
      case 'getblockheader': {
        if (p0 !== block.blockHash) throw new Error('block not found');
        if (params[1] === false) return block.headerHex;
        return {
          hash: block.blockHash,
          height: CHECKPOINT_HEIGHT,
          nTx: block.txCount,
          time: 1_700_000_000,
          merkleroot: 'unused',
        };
      }
      case 'getblock': {
        if (p0 !== block.blockHash) throw new Error('block not found');
        if (params[1] === 0) return bytesToHex(serializeBlock(hexToBytes(block.headerHex), block.txs));
        return { tx: block.txs.map((t) => t.txid) };
      }
      default:
        throw new Error(`unstubbed rpc ${method}`);
    }
  };
}

// ---------------------------------------------------------------------------

const running: Server[] = [];

/** start a server, ask it for the bundle, stop it */
async function proof(server: Server, id: string): Promise<{ status: number; body: string }> {
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/ord/v1/proof/${id}?level=l2`);
  return { status: res.status, body: await res.text() };
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('SPEC-VERIFICATION conformance: the servers that verify before they relay', () => {
  conformance('checkpoint-consult', async () => {
    const { inscriptionId, block } = CHAIN;
    // the two servers, each on the checkpoint set it holds when an operator
    // configures nothing. The proof-of-work floor is disabled on all six
    // instances, so what refuses below is the checkpoint and never the floor
    const gateway = () =>
      createGateway({ esplora: [E], fetchFn: stubFetch(CHAIN), ...NO_POW_FLOOR });
    const sidecar = () => createSidecar({ rpc: stubRpc(CHAIN), ...NO_POW_FLOOR });

    for (const [name, server] of [
      ['gateway', gateway()],
      ['sidecar', sidecar()],
    ] as const) {
      const res = await proof(server, inscriptionId);
      // upstream data this server cannot stand behind, not an absent
      // inscription: the backend answered, and its answer contradicts a hash
      // compiled into the binary
      expect(res.status, name).toBe(502);
      expect(JSON.parse(res.body).error, name).toMatch(
        new RegExp(`at height ${CHECKPOINT_HEIGHT} contradicts checkpoint`),
      );
    }

    // an operator whose chain is not mainnet configures the set that chain
    // needs, and an empty one is what the reference signet deployment sets.
    // Same bundle, same height, served
    for (const [name, server] of [
      ['gateway', createGateway({
        esplora: [E],
        fetchFn: stubFetch(CHAIN),
        checkpoints: new Map(),
        ...NO_POW_FLOOR,
      })],
      ['sidecar', createSidecar({ rpc: stubRpc(CHAIN), checkpoints: new Map(), ...NO_POW_FLOOR })],
    ] as const) {
      const res = await proof(server, inscriptionId);
      expect(res.status, name).toBe(200);
      const bundle = JSON.parse(res.body) as ProofBundleJson;
      expect(bundle.block.height, name).toBe(CHECKPOINT_HEIGHT);
      expect(verifyProofBundle(bundle, NO_POW_FLOOR).height, name).toBe(CHECKPOINT_HEIGHT);
    }

    // and the arm that shows the refusal is the contradiction rather than the
    // height: a set naming the hash this chain really has at that height is
    // consulted, matches, and the bundle is served
    const agreeing = new Map([[CHECKPOINT_HEIGHT, block.blockHash]]);
    for (const [name, server] of [
      ['gateway', createGateway({
        esplora: [E],
        fetchFn: stubFetch(CHAIN),
        checkpoints: agreeing,
        ...NO_POW_FLOOR,
      })],
      ['sidecar', createSidecar({ rpc: stubRpc(CHAIN), checkpoints: agreeing, ...NO_POW_FLOOR })],
    ] as const) {
      const res = await proof(server, inscriptionId);
      expect(res.status, name).toBe(200);
    }
  });

  // -------------------------------------------------------------------------
  // the accounting: the whole-spec sum lives in the core file
  // -------------------------------------------------------------------------

  it('SPEC-VERIFICATION.md: this file speaks for exactly the server rows', () => {
    expect([...SPOKEN].sort()).toEqual(drivenIdsFor('servers').sort());
  });
});
