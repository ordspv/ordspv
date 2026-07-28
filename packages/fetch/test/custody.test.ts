import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  buildMerkleBranch,
  hexToBytes,
  internalToDisplay,
  parseTx,
  serializeBlock,
  serializeFull,
  verifyCustodyBundle,
  type CustodyHopJson,
  type ParsedTx,
} from '@ordspv/core';
import {
  attachRevealWitnessSection,
  buildCustodyBundle,
  fetchCustody,
  CustodyError,
  type AnchorBackend,
} from '../src/index.js';
import { CustodyUnsupportedError, EnvelopeIndexUnprovenError } from '@ordspv/core';
import { EsploraBackend, type FetchFn } from '../src/backends.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  NO_POW_FLOOR,
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
// attester-only stub: anchoring needs two agreeing sources that did not build
// the bundle, and E is the builder
const E3 = 'https://esplora3.test';

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
    [`${E3}/block-height/${height}`]: block.blockHash,
    [`${E3}/blocks/tip/height`]: String(tipHeight),
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
  anchorSources: [E2, E3],
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

  it('completes a path of exactly maxHops transfers', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    const value = reveal.outputs[0].value;
    const spend1 = legacySpend(reveal.txid, 0, [value]);
    const spend2 = legacySpend(spend1.txid, 0, [value]);
    const blockB = buildBlock([spend1]);
    const blockC = buildBlock([spend2]);

    const routes = {
      ...routesForBlock(block, 100, 120),
      ...routesForBlock(blockB, 105, 120),
      ...routesForBlock(blockC, 106, 120),
    };
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = {
      spent: true,
      txid: spend1.txid,
      vin: 0,
      status: { confirmed: true, block_height: 105, block_hash: blockB.blockHash },
    };
    routes[`${E}/tx/${spend1.txid}/outspend/0`] = {
      spent: true,
      txid: spend2.txid,
      vin: 0,
      status: { confirmed: true, block_height: 106, block_hash: blockC.blockHash },
    };
    routes[`${E}/tx/${spend2.txid}/outspend/0`] = { spent: false };
    routes[`${E2}/tx/${spend2.txid}/outspend/0`] = { spent: false };

    const res = await fetchCustody(id, { ...OPTS, maxHops: 2, fetchFn: stubFetch(routes) });
    expect(res.custody.hops).toBe(3);
    expect(res.custody.satpoint.txid).toBe(spend2.txid);
    expect(res.pendingSpendTxid).toBeUndefined();
  });

  it('errors only when the walk is truncated at maxHops, naming the cap', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    const value = reveal.outputs[0].value;
    const spend1 = legacySpend(reveal.txid, 0, [value]);
    const spend2 = legacySpend(spend1.txid, 0, [value]);
    const blockB = buildBlock([spend1]);

    const routes = {
      ...routesForBlock(block, 100, 120),
      ...routesForBlock(blockB, 105, 120),
    };
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = {
      spent: true,
      txid: spend1.txid,
      vin: 0,
      status: { confirmed: true, block_height: 105, block_hash: blockB.blockHash },
    };
    // a further confirmed spend exists past the cap, so the walk is truncated
    routes[`${E}/tx/${spend1.txid}/outspend/0`] = {
      spent: true,
      txid: spend2.txid,
      vin: 0,
      status: { confirmed: true, block_height: 106, block_hash: '11'.repeat(32) },
    };

    const p = fetchCustody(id, { ...OPTS, maxHops: 1, fetchFn: stubFetch(routes) });
    await expect(p).rejects.toThrow(CustodyError);
    await expect(p).rejects.toThrow(/exceeds 1 hops/);
  });

  it('surfaces a fee-spillover path as CustodyUnsupportedError, not backend failover', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    // the confirmed spend burns everything to fees (single zero-value output),
    // so the tracked sat leaves v1's domain: a deterministic refusal that must
    // not be retried against, or masked by, other backends
    const spend = legacySpend(reveal.txid, 0, [0n]);
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

    const p = fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes) });
    await expect(p).rejects.toThrow(CustodyUnsupportedError);
    await expect(p).rejects.toThrow(/does not track sats through fees/);
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

describe('fetchCustody with multi-input reveals', () => {
  // key-path funding leg on input 0, the envelope on input 1: an ordinary
  // wallet-funded reveal, and the shape the wtxid proof exists for
  const env = envelopeScript({ fields: [[1, 'text/plain']], body: ['multi'] }, { checksigPrefix: true });
  const tap = taprootCommit(env);

  function legacyTxOut(
    prevTxidDisplay: string,
    vout: number,
    outputs: { value: bigint; spk?: Uint8Array }[],
  ): ParsedTx {
    const parts: Uint8Array[] = [u32le(2), new Uint8Array([1])];
    parts.push(hexToBytes(prevTxidDisplay).reverse(), u32le(vout), new Uint8Array([1, 0x51]), u32le(0xffffffff));
    parts.push(new Uint8Array([outputs.length]));
    for (const o of outputs) {
      const spk = o.spk ?? new Uint8Array([0x51]);
      parts.push(u64le(o.value), new Uint8Array([spk.length]), spk);
    }
    parts.push(u32le(0));
    return parseTx(cat(...parts));
  }

  const commit = legacyTxOut('11'.repeat(32), 0, [
    { value: 10_000n },
    { value: 20_000n, spk: tap.scriptPubKey },
  ]);
  const reveal = parseTx(
    serializeFull({
      version: 2,
      inputs: [
        {
          prevTxidLE: commit.txidLE,
          prevTxid: commit.txid,
          vout: 0,
          scriptSig: new Uint8Array(0),
          sequence: 0xfffffffd,
          witness: [new Uint8Array(64).fill(7)],
        },
        {
          prevTxidLE: commit.txidLE,
          prevTxid: commit.txid,
          vout: 1,
          scriptSig: new Uint8Array(0),
          sequence: 0xfffffffd,
          witness: [new Uint8Array(64).fill(7), env, tap.controlBlock],
        },
      ],
      outputs: [{ value: 25_000n, scriptPubKey: new Uint8Array([0x51]) }],
      locktime: 0,
    }),
  );
  const block = buildBlock([reveal]);
  const id = `${reveal.txid}i0`;

  function routes(withRawBlock: boolean): Record<string, Route> {
    const r = routesForBlock(block, 100, 120);
    r[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    r[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    r[`${E2}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    if (withRawBlock) {
      r[`${E}/block/${block.blockHash}/raw`] = serializeBlock(hexToBytes(block.headerHex), block.txs);
    }
    return r;
  }

  it('builds the reveal wtxid proof and verifies through it', async () => {
    const built = await buildCustodyBundle(id, new EsploraBackend(E, stubFetch(routes(true))));
    expect(built.bundle.hops[0].witness).toBeDefined();
    expect(verifyCustodyBundle(built.bundle, NO_POW_FLOOR).indexProof).toBe('wtxid');

    const res = await fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes(true)) });
    expect(res.custody.indexProof).toBe('wtxid');
    expect(res.custody.singleInputReveal).toBe(false);
    expect(res.custody.genesis.offset).toBe(10_000n);
  });

  it('passes EnvelopeIndexUnprovenError through, naming the backend cause', async () => {
    // no raw-block route: the builder emits no unverifiable bundle, and the
    // refusal reaches the caller as itself the way CustodyUnsupportedError
    // does
    const p = fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes(false)) });
    await expect(p).rejects.toThrow(EnvelopeIndexUnprovenError);
    await expect(p).rejects.toThrow(/spends 2 inputs/);
    // the real cause is a backend failure, not an unprovable reveal
    await expect(p).rejects.toThrow(/HTTP 404/);
  });

  it('names a backend that exposes no getBlockRaw as its own cause', async () => {
    const full = new EsploraBackend(E, stubFetch(routes(true)));
    // an AnchorBackend may omit getBlockRaw entirely; that is a cause too
    const noRaw: AnchorBackend = {
      baseUrl: 'https://noraw.test',
      getTxHex: (t) => full.getTxHex(t),
      getTxStatus: (t) => full.getTxStatus(t),
      getMerkleProof: (t) => full.getMerkleProof(t),
      getHeaderHex: (h) => full.getHeaderHex(h),
      getBlockInfo: (h) => full.getBlockInfo(h),
    };
    const hop: CustodyHopJson = {
      block: { height: 100, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
      tx: { hex: bytesToHex(reveal.raw), pos: 1, txidBranch: [] },
      prevTxs: [],
    };
    await expect(attachRevealWitnessSection([noRaw], reveal, hop)).rejects.toThrow(
      /serves no raw blocks/,
    );
    // and it succeeds through a backend that does serve them
    await attachRevealWitnessSection([noRaw, full], reveal, hop);
    expect(hop.witness).toBeDefined();
  });

  it('emits no witness section for a single-input reveal even with the block available', async () => {
    const setup = inscriptionSetup();
    const r = routesForBlock(setup.block, 100, 120);
    r[`${E}/tx/${setup.commit.txid}/hex`] = bytesToHex(setup.commit.raw);
    r[`${E}/tx/${setup.reveal.txid}/outspend/0`] = { spent: false };
    r[`${E}/block/${setup.block.blockHash}/raw`] = serializeBlock(
      hexToBytes(setup.block.headerHex),
      setup.block.txs,
    );
    const built = await buildCustodyBundle(setup.id, new EsploraBackend(E, stubFetch(r)));
    expect('witness' in built.bundle.hops[0]).toBe(false);
    expect(verifyCustodyBundle(built.bundle, NO_POW_FLOOR).indexProof).toBe('single-input');
  });
});
