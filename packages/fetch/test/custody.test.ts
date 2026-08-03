import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  buildMerkleBranch,
  checkProofOfWork,
  hexToBytes,
  parseHeader,
  internalToDisplay,
  parseTx,
  serializeBlock,
  tapLeafHash,
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
  HopConsistencyError,
  WitnessSectionUnavailableError,
  type AnchorBackend,
  type AttemptInfo,
} from '../src/index.js';
import { CustodyUnsupportedError, EnvelopeIndexUnprovenError } from '@ordspv/core';
import { EsploraBackend, type FetchFn } from '../src/backends.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  mineHeader,
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

/** copy every route registered for `from` onto `to` */
function mirror(routes: Record<string, Route>, from: string, to: string): Record<string, Route> {
  const out = { ...routes };
  for (const [url, route] of Object.entries(routes)) {
    if (url.startsWith(from)) out[to + url.slice(from.length)] = route;
  }
  return out;
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

  it('surfaces a fee-spillover path as CustodyUnsupportedError once every backend reports it', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    // the confirmed spend burns everything to fees (single zero-value output),
    // so the tracked sat leaves v1's domain. Both backends serve the same
    // chain, so both report it, and only then is it the chain's answer rather
    // than one server's
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

    // E2 answers everything E answers, so the refusal is not one server's word
    const base = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) => base(url.replace(E2, E), init);

    const p = fetchCustody(id, { ...OPTS, fetchFn });
    await expect(p).rejects.toThrow(CustodyUnsupportedError);
    await expect(p).rejects.toThrow(/does not track sats through fees/);
    await expect(p).rejects.toThrow(/each configured backend led an attempt/);
    await expect(p).rejects.toThrow(new RegExp(`${E},.*${E2}`));
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

/**
 * A hop is assembled from four separate answers, and nothing makes a backend
 * keep them consistent. The bundle verifier proves they are, and it runs after
 * the loop has been left, so a well formed wrong answer used to buy the whole
 * walk and then report the bundle invalid with the other backends never asked.
 * The builder folds each hop against itself now, and a disagreement is that
 * backend producing no usable answer.
 */
describe('fetchCustody when one backend answers inconsistently', () => {
  const E4 = 'https://esplora4.test';
  // E2 serves the bundle after the rotation, so neither serving backend can
  // attest; these two serve nothing
  const ANCHORS = { anchorSources: [E3, E4] };
  const { commit, reveal, block, id } = inscriptionSetup();

  /** both backends honest, and attesters that served no bytes */
  function honestRoutes(): Record<string, Route> {
    const r = routesForBlock(block, 100, 120);
    r[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    r[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    r[`${E2}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    const mirrored = mirror(r, E, E2);
    mirrored[`${E4}/block-height/100`] = block.blockHash;
    mirrored[`${E4}/blocks/tip/height`] = '120';
    return mirrored;
  }

  /** the branch and position of another transaction in the same block */
  function proofOfOtherTx(): object {
    const txids = block.txs.map((t) => t.txidLE);
    return { block_height: 100, merkle: buildMerkleBranch(txids, 0).map(internalToDisplay), pos: 0 };
  }

  const cases: [string, (r: Record<string, Route>) => void][] = [
    [
      'a merkle proof at a wrong position',
      (r) => {
        r[`${E}/tx/${reveal.txid}/merkle-proof`] = proofOfOtherTx();
      },
    ],
    [
      'a status naming a real but wrong block',
      (r) => {
        const decoy = buildBlock([commit]);
        r[`${E}/tx/${reveal.txid}/status`] = {
          confirmed: true,
          block_height: 100,
          block_hash: decoy.blockHash,
        };
        r[`${E}/block/${decoy.blockHash}/header`] = decoy.headerHex.trim();
        r[`${E}/block/${decoy.blockHash}`] = {
          id: decoy.blockHash,
          height: 100,
          tx_count: decoy.txCount,
        };
      },
    ],
    [
      'a merkle proof whose height contradicts the status',
      (r) => {
        r[`${E}/tx/${reveal.txid}/merkle-proof`] = {
          ...(r[`${E}/tx/${reveal.txid}/merkle-proof`] as object),
          block_height: 101,
        };
      },
    ],
  ];

  for (const [what, doctor] of cases) {
    it(`rotates past ${what} and resolves through the next backend`, async () => {
      const r = honestRoutes();
      doctor(r);
      const attempts: AttemptInfo[] = [];
      const res = await fetchCustody(id, {
        ...OPTS,
        ...ANCHORS,
        fetchFn: stubFetch(r),
        onAttempt: (info) => attempts.push(info),
      });
      // the honest backend answers the same question the walk asked
      expect(res.custody.hops).toBe(1);
      expect(res.custody.satpoint.txid).toBe(reveal.txid);
      expect(attempts.map((a) => a.baseUrl)).toEqual([E, E2]);
      expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
      expect(attempts[1].cause?.message).toMatch(new RegExp(`^${E}: `));
    });
  }

  it('ends at the build-failure path when every backend answers inconsistently', async () => {
    // no backend produced an answer, so nothing was refused and nothing was
    // verified. INCOMPLETE with every cause named is the honest report, and
    // exit 1 on a bundle that failed verification is what this replaced
    const r = honestRoutes();
    for (const base of [E, E2]) {
      r[`${base}/tx/${reveal.txid}/merkle-proof`] = proofOfOtherTx();
    }
    const p = fetchCustody(id, { ...OPTS, ...ANCHORS, fetchFn: stubFetch(r) });
    const e = (await p.catch((x: unknown) => x)) as CustodyError & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyError);
    expect(e.code).toBe('BUILD_FAILED');
    // a refusal was never recorded, so nothing claims to be the chain's answer
    expect(e.unanimous).toBeUndefined();
    expect(e.message).toMatch(new RegExp(`${E}: .*does not fold`));
    expect(e.message).toMatch(new RegExp(`${E2}: .*does not fold`));
  });
});

/**
 * The build-time self-check now covers every check `verifyAnchoredHop` runs on
 * the same four answers, so a backend that fabricates a whole block, with a
 * header hashing to the hash its own status named and a branch folding to that
 * header's root, no longer buys the walk and then a bundle the verifier refuses
 * at exit 1 with the other backends never asked.
 */
describe('fetchCustody when one backend answers off the configured chain', () => {
  const E4 = 'https://esplora4.test';
  const ANCHORS = { anchorSources: [E3, E4] };
  // an intermediate floor: the fixtures are mined at it, so a regtest header
  // over the same merkle root is under the floor and the honest one is not
  const FLOOR = 0x2000ffff;
  const script = envelopeScript({ fields: [[1, 'text/plain']], body: ['pow'] }, { checksigPrefix: true });
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  const block = buildBlock([reveal], { bits: FLOOR });
  const id = `${reveal.txid}i0`;
  const FLOORED = { ...OPTS, ...ANCHORS, powLimitBits: FLOOR };

  function honestRoutes(): Record<string, Route> {
    const r = routesForBlock(block, 100, 120);
    r[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    r[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    const m = mirror(r, E, E2);
    m[`${E4}/block-height/100`] = block.blockHash;
    m[`${E4}/blocks/tip/height`] = '120';
    return m;
  }

  /**
   * Point E's own answers at a header over the same merkle root, so its branch
   * still folds and only the header itself is wrong. Everything a backend
   * needs to be internally consistent, and nothing else.
   */
  function serveHeader(r: Record<string, Route>, headerBytes: Uint8Array): string {
    const hash = parseHeader(headerBytes).hash;
    r[`${E}/tx/${reveal.txid}/status`] = { confirmed: true, block_height: 100, block_hash: hash };
    r[`${E}/block/${hash}/header`] = bytesToHex(headerBytes);
    r[`${E}/block/${hash}`] = { id: hash, height: 100, tx_count: block.txCount };
    return hash;
  }

  const root = hexToBytes(block.headerHex).slice(36, 68);

  /** the same merkle root under an easier target than the configured floor */
  function weakHeader(): Uint8Array {
    return mineHeader(root, 0x207fffff);
  }

  /** the honest header with its nonce spoiled, so it fails its own target */
  function badNonceHeader(): Uint8Array {
    const h = hexToBytes(block.headerHex).slice();
    const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
    for (let nonce = 0; nonce < 1_000_000; nonce++) {
      view.setUint32(76, nonce, true);
      if (!checkProofOfWork(parseHeader(h))) return h;
    }
    throw new Error('every nonce satisfied the target');
  }

  it('rotates past a header under the configured proof-of-work floor', async () => {
    const r = honestRoutes();
    serveHeader(r, weakHeader());
    const attempts: AttemptInfo[] = [];
    const res = await fetchCustody(id, {
      ...FLOORED,
      fetchFn: stubFetch(r),
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.custody.hops).toBe(1);
    expect(res.custody.satpoint.txid).toBe(reveal.txid);
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, E2]);
    expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
    expect(attempts[1].cause?.message).toMatch(/easier than the proof-of-work limit/);
  });

  it('rotates past a header that fails the target it states itself', async () => {
    const r = honestRoutes();
    serveHeader(r, badNonceHeader());
    const attempts: AttemptInfo[] = [];
    const res = await fetchCustody(id, {
      ...FLOORED,
      fetchFn: stubFetch(r),
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.custody.satpoint.txid).toBe(reveal.txid);
    expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
    expect(attempts[1].cause?.message).toMatch(/fails the proof-of-work target it states itself/);
  });

  for (const [what, count] of [['zero', 0], ['fractional', 1.5]] as const) {
    it(`rotates past a ${what} transaction count`, async () => {
      const r = honestRoutes();
      r[`${E}/block/${block.blockHash}`] = { id: block.blockHash, height: 100, tx_count: count };
      const attempts: AttemptInfo[] = [];
      const res = await fetchCustody(id, {
        ...FLOORED,
        fetchFn: stubFetch(r),
        onAttempt: (info) => attempts.push(info),
      });
      expect(res.custody.satpoint.txid).toBe(reveal.txid);
      expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
      expect(attempts[1].cause?.message).toMatch(
        new RegExp(`has no valid transaction count \\(got ${count}\\)`),
      );
    });
  }

  it('ends at the build-failure path when every backend answers under the floor', async () => {
    const r = honestRoutes();
    const weak = weakHeader();
    const hash = serveHeader(r, weak);
    // E2 answers the same way, so no backend produced a usable answer and
    // nothing was refused on domain grounds
    r[`${E2}/tx/${reveal.txid}/status`] = { confirmed: true, block_height: 100, block_hash: hash };
    r[`${E2}/block/${hash}/header`] = bytesToHex(weak);
    r[`${E2}/block/${hash}`] = { id: hash, height: 100, tx_count: block.txCount };

    const p = fetchCustody(id, { ...FLOORED, fetchFn: stubFetch(r) });
    const e = (await p.catch((x: unknown) => x)) as CustodyError & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyError);
    expect(e.code).toBe('BUILD_FAILED');
    // the three accounting groups still sum: both backends are noAnswer, so
    // nothing claims to be the chain's answer
    expect(e.unanimous).toBeUndefined();
    expect(e.message).toMatch(new RegExp(`${E}: .*easier than the proof-of-work limit`));
    expect(e.message).toMatch(new RegExp(`${E2}: .*easier than the proof-of-work limit`));
  });

  it('refuses every regtest fixture at the mainnet default, and builds at powLimitBits null', async () => {
    // the only new test that runs with the floor at its mainnet default. The
    // fixtures elsewhere in this suite are regtest-difficulty, so every hop
    // they serve is under it and every attempt ends the same way
    const setup = inscriptionSetup();
    const r = routesForBlock(setup.block, 100, 120);
    r[`${E}/tx/${setup.commit.txid}/hex`] = bytesToHex(setup.commit.raw);
    r[`${E}/tx/${setup.reveal.txid}/outspend/0`] = { spent: false };
    const m = mirror(r, E, E2);
    m[`${E4}/block-height/100`] = setup.block.blockHash;
    m[`${E4}/blocks/tip/height`] = '120';
    const routes = stubFetch(m);

    const p = fetchCustody(setup.id, {
      esplora: [E, E2],
      ...ANCHORS,
      checkpoints: new Map<number, string>(),
      fetchFn: routes,
    });
    const e = (await p.catch((x: unknown) => x)) as CustodyError;
    expect(e).toBeInstanceOf(CustodyError);
    expect(e.code).toBe('BUILD_FAILED');
    expect(e.message).toMatch(/easier than the proof-of-work limit 0x1d00ffff/);
    expect(e.message).toMatch(new RegExp(`${E}: `));
    expect(e.message).toMatch(new RegExp(`${E2}: `));

    // and the same fixtures build when the caller disables the floor
    const ok = await fetchCustody(setup.id, {
      esplora: [E, E2],
      ...ANCHORS,
      checkpoints: new Map<number, string>(),
      powLimitBits: null,
      fetchFn: routes,
    });
    expect(ok.custody.satpoint.txid).toBe(setup.reveal.txid);
  });
});

/**
 * A domain refusal the builder raises comes out of the reveal witness, and the
 * txid does not commit to that witness, so one backend can produce it where
 * another does not. Until a verifier has bound the witness, such a refusal is
 * that backend's claim and the wrapper must ask the next one.
 */
describe('fetchCustody build-time domain refusals', () => {
  const E4 = 'https://esplora4.test';
  // attesters that serve no bytes, so failover to E2 still anchors
  const ANCHORS = { anchorSources: [E3, E4] };

  /** the same transaction with input 0's witness replaced (txid unchanged) */
  function withWitness(tx: ParsedTx, witness: Uint8Array[]): ParsedTx {
    return parseTx(
      serializeFull({
        version: tx.version,
        inputs: tx.inputs.map((inp, n) => (n === 0 ? { ...inp, witness } : inp)),
        outputs: tx.outputs,
        locktime: tx.locktime,
      }),
    );
  }

  /** an envelope ord treats as UNBOUND: tag 22 is even and unrecognized */
  const UNBOUND_SCRIPT = envelopeScript(
    { fields: [[1, 'text/plain'], [22, new Uint8Array([1])]], body: ['unbound'] },
    { checksigPrefix: true },
  );
  const HONEST_SCRIPT = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['custody'] },
    { checksigPrefix: true },
  );

  /**
   * A reveal whose commit output committed TWO leaves, the honest envelope and
   * the unbound one. Both witnesses satisfy BIP-341 against the same
   * scriptPubKey, so the build's own envelope binding accepts either and what
   * a backend serving the unbound leaf is doing is choosing among leaves the
   * inscriber committed. That is the shape a domain refusal can rest on; a
   * witness the commit output never committed is caught at build now and
   * recorded as no usable answer instead.
   */
  function twoLeafSetup() {
    const honest = taprootCommit(HONEST_SCRIPT, [tapLeafHash(UNBOUND_SCRIPT, 0xc0)]);
    const unbound = taprootCommit(UNBOUND_SCRIPT, [tapLeafHash(HONEST_SCRIPT, 0xc0)]);
    const commit = commitTx(honest.scriptPubKey);
    const reveal = revealTx([{ script: HONEST_SCRIPT, controlBlock: honest.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    return {
      commit,
      reveal,
      block: buildBlock([reveal]),
      id: `${reveal.txid}i0`,
      unboundWitness: [new Uint8Array(64).fill(7), UNBOUND_SCRIPT, unbound.controlBlock],
    };
  }

  /** E serves a reveal whose envelope is unbound; E2 serves the honest one */
  function poisonedSetup() {
    const { commit, reveal, block, id, unboundWitness } = twoLeafSetup();
    const poisoned = withWitness(reveal, unboundWitness);
    expect(poisoned.txid).toBe(reveal.txid);
    let routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    routes[`${E4}/block-height/100`] = block.blockHash;
    routes[`${E4}/blocks/tip/height`] = '120';
    routes = mirror(routes, E, E2);
    // only after mirroring, so E2 keeps the honest bytes
    routes[`${E}/tx/${reveal.txid}/hex`] = bytesToHex(poisoned.raw);
    return { commit, reveal, block, id, routes };
  }

  /**
   * A witness the commit output never committed: an envelope under a taptree
   * of its own, served under the honest reveal's txid. Nothing in the txid
   * binds it, so the honest move is to ask another backend rather than to
   * build a whole bundle and let the verifier call it a forgery at exit 1.
   */
  function uncommittedWitness(): Uint8Array[] {
    const rogue = envelopeScript(
      { fields: [[1, 'text/plain']], body: ['rogue'] },
      { checksigPrefix: true },
    );
    return [new Uint8Array(64).fill(7), rogue, taprootCommit(rogue).controlBlock];
  }

  it('asks the next backend when one serves a reveal whose tapscript is not committed', async () => {
    const { commit, reveal, block, id } = twoLeafSetup();
    const poisoned = withWitness(reveal, uncommittedWitness());
    expect(poisoned.txid).toBe(reveal.txid);
    let routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    routes[`${E4}/block-height/100`] = block.blockHash;
    routes[`${E4}/blocks/tip/height`] = '120';
    routes = mirror(routes, E, E2);
    routes[`${E}/tx/${reveal.txid}/hex`] = bytesToHex(poisoned.raw);

    const attempts: AttemptInfo[] = [];
    const res = await fetchCustody(id, {
      ...OPTS,
      ...ANCHORS,
      fetchFn: stubFetch(routes),
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.custody.satpoint.txid).toBe(reveal.txid);
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, E2]);
    expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
    expect(attempts[1].cause?.message).toMatch(/taproot commitment/);

    // and with every backend serving it, nothing was refused and nothing was
    // verified: INCOMPLETE with each cause named, rather than exit 1 on a
    // bundle the caller's own build produced
    routes[`${E2}/tx/${reveal.txid}/hex`] = bytesToHex(poisoned.raw);
    const p = fetchCustody(id, { ...OPTS, ...ANCHORS, fetchFn: stubFetch(routes) });
    const e = (await p.catch((x: unknown) => x)) as CustodyError & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyError);
    expect(e.code).toBe('BUILD_FAILED');
    expect(e.unanimous).toBeUndefined();
    expect(e.message).toMatch(new RegExp(`${E}: .*taproot commitment`));
    expect(e.message).toMatch(new RegExp(`${E2}: .*taproot commitment`));
  });

  it('asks the next backend when one serves an unbound envelope', async () => {
    const { reveal, id, routes } = poisonedSetup();
    const res = await fetchCustody(id, { ...OPTS, ...ANCHORS, fetchFn: stubFetch(routes) });
    // E2's honest reveal built the bundle, and it verified
    expect(res.custody.hops).toBe(1);
    expect(res.custody.satpoint.txid).toBe(reveal.txid);
    expect(res.custody.genesis.offset).toBe(0n);
  });

  it('records a backend serving another transaction for the reveal as its wrong answer', async () => {
    // the inscription id commits to the reveal's stripped hash, so bytes
    // hashing to some other transaction are E's wrong answer, recorded as no
    // usable answer with that as the cause, and E2's honest reveal builds
    const { commit, reveal, block, id } = inscriptionSetup();
    const decoy = legacySpend('55'.repeat(32), 0, [546n]);
    let routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    routes[`${E4}/block-height/100`] = block.blockHash;
    routes[`${E4}/blocks/tip/height`] = '120';
    routes = mirror(routes, E, E2);
    // only after mirroring, so E2 keeps the honest bytes
    routes[`${E}/tx/${reveal.txid}/hex`] = bytesToHex(decoy.raw);

    const attempts: AttemptInfo[] = [];
    const res = await fetchCustody(id, {
      ...OPTS,
      ...ANCHORS,
      fetchFn: stubFetch(routes),
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.custody.satpoint.txid).toBe(reveal.txid);
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, E2]);
    expect((attempts[1].cause as Error).message).toMatch(/backend served .* for requested/);
  });

  it('never records a refusal derived from wrong-txid reveal bytes', async () => {
    // both backends serve, for the requested txid, a valid parse of a
    // DIFFERENT transaction whose envelope is unbound, with the decoy's
    // status and merkle proof registered so the walk would reach the domain
    // refusal. One local hash reclassifies the bytes as served-wrong-bytes:
    // both backends land in noAnswer and no CustodyUnsupportedError is ever
    // recorded, where before the check the build called the refusal
    // unanimous, the exit 4 upgrade
    const { commit, reveal, block, id, unboundWitness } = twoLeafSetup();
    // one sat more on the output, so the stripped txid differs from the id's
    const poisoned = parseTx(
      serializeFull({
        version: reveal.version,
        inputs: reveal.inputs.map((inp, n) => (n === 0 ? { ...inp, witness: unboundWitness } : inp)),
        outputs: reveal.outputs.map((o, n) => (n === 0 ? { ...o, value: o.value + 1n } : o)),
        locktime: reveal.locktime,
      }),
    );
    expect(poisoned.txid).not.toBe(reveal.txid);
    let routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${poisoned.txid}/status`] = routes[`${E}/tx/${reveal.txid}/status`];
    routes[`${E}/tx/${poisoned.txid}/merkle-proof`] = routes[`${E}/tx/${reveal.txid}/merkle-proof`];
    routes[`${E}/tx/${reveal.txid}/hex`] = bytesToHex(poisoned.raw);
    routes = mirror(routes, E, E2);

    const p = fetchCustody(id, { ...OPTS, ...ANCHORS, fetchFn: stubFetch(routes) });
    const e = (await p.catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(CustodyError);
    expect((e as CustodyError).code).toBe('BUILD_FAILED');
    expect(e).not.toBeInstanceOf(CustodyUnsupportedError);
    expect(e.message).toMatch(/backend served .* for requested/);
    expect(e.message).toMatch(new RegExp(E));
    expect(e.message).toMatch(new RegExp(E2));
  });

  it('surfaces the refusal when the poisoning backend is the only one', async () => {
    // one configured backend agreeing with itself is one server's word, and
    // the message says that rather than claiming every backend reached it
    const { id, routes } = poisonedSetup();
    const p = fetchCustody(id, { ...OPTS, ...ANCHORS, esplora: [E], fetchFn: stubFetch(routes) });
    await expect(p).rejects.toThrow(CustodyUnsupportedError);
    await expect(p).rejects.toThrow(/unbound at reveal/);
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(new RegExp(`the single configured backend reported it: ${E}`));
    expect(e.message).toMatch(/a second configured backend is what would make it more/);
    expect(e.message).not.toMatch(/each configured backend led an attempt/);
  });

  /** every route the given backend serves, dropped */
  function without(routes: Record<string, Route>, base: string): Record<string, Route> {
    const stripped: Record<string, Route> = {};
    for (const [url, route] of Object.entries(routes)) {
      if (!url.startsWith(base) || url.includes('/block-height/') || url.includes('/tip/')) {
        stripped[url] = route;
      }
    }
    return stripped;
  }

  it('keeps the class when the other backend could not be reached at all', async () => {
    const { id, routes } = poisonedSetup();
    // E refuses on domain grounds, E2 serves nothing at all. No backend
    // answered with a bundle, so the refusal is the most informative thing the
    // build has, and it says what it rests on
    const p = fetchCustody(id, { ...OPTS, ...ANCHORS, fetchFn: stubFetch(without(routes, E2)) });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/unbound at reveal/);
    expect(e.message).toMatch(/1 of 2 configured backends/);
    expect(e.message).toMatch(new RegExp(`ended this way: ${E}`));
    // E2 answered nothing usable, which is what is said about it, and its own
    // cause is carried rather than dropped
    expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${E2}: `));
    expect(e.message).toMatch(/HTTP 404/);
    expect(e.message).not.toMatch(/could not be reached/);
  });

  it('agrees with the sat wrapper on a refusal beside two that answered nothing', async () => {
    // the same shape the genealogy suite drives: one backend refuses on domain
    // grounds and the other two produce nothing usable. Both wrappers report
    // the refusal's own class marked non-unanimous, which the CLI table turns
    // into one exit code, so the two commands cannot disagree about the same
    // inscription
    const E5 = 'https://esplora5.test';
    const { id, routes } = poisonedSetup();
    const p = fetchCustody(id, {
      ...OPTS,
      ...ANCHORS,
      esplora: [E, E2, E5],
      fetchFn: stubFetch(without(routes, E2)),
    });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e).not.toBeInstanceOf(CustodyError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/1 of 3 configured backends/);
    expect(e.message).toMatch(new RegExp(`ended this way: ${E}`));
    expect(e.message).toMatch(new RegExp(`2 produced no usable answer: ${E2}: `));
    expect(e.message).toMatch(new RegExp(`${E5}: `));
  });

  it('reports BUILD_FAILED when no backend refused on domain grounds', async () => {
    const { id, routes } = poisonedSetup();
    // neither backend serves the reveal, so nothing was refused and nothing
    // was proven; the caller gets every cause
    const blind = without(without(routes, E2), E);
    const p = fetchCustody(id, { ...OPTS, ...ANCHORS, fetchFn: stubFetch(blind) });
    await expect(p).rejects.toThrow(CustodyError);
    await expect(p).rejects.toThrow(/all backends failed/);
    await expect(p).rejects.toThrow(/HTTP 404/);
  });
});

describe('fetchCustody with multi-input reveals', () => {
  // attesters that serve no bytes, so a build through either backend anchors
  const E4 = 'https://esplora4.test';
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
    const built = await buildCustodyBundle(id, new EsploraBackend(E, stubFetch(routes(true))), {
      powLimitBits: null,
    });
    expect(built.bundle.hops[0].witness).toBeDefined();
    expect(verifyCustodyBundle(built.bundle, NO_POW_FLOOR).indexProof).toBe('wtxid');

    const res = await fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes(true)) });
    expect(res.custody.indexProof).toBe('wtxid');
    expect(res.custody.singleInputReveal).toBe(false);
    expect(res.custody.genesis.offset).toBe(10_000n);
  });

  it('surfaces WitnessSectionUnavailableError once every backend led an attempt into it', async () => {
    // no raw-block route anywhere: the builder emits no unverifiable bundle,
    // every attempt ends the same way, and the failure reaches the caller as
    // itself. It is availability, so it is NOT the verifier's refusal class
    const p = fetchCustody(id, {
      ...OPTS,
      anchorSources: [E3, E4],
      fetchFn: stubFetch(mirror(routes(false), E, E2)),
    });
    await expect(p).rejects.toThrow(WitnessSectionUnavailableError);
    await expect(p).rejects.not.toThrow(EnvelopeIndexUnprovenError);
    await expect(p).rejects.toThrow(/spends 2 input/);
    // the real cause is a backend failure, not an unprovable reveal
    await expect(p).rejects.toThrow(/HTTP 404/);
    await expect(p).rejects.toThrow(new RegExp(`${E},.*${E2}`));
    // every backend reached it, so the sentence is the one it has always been
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e.unanimous).toBe(true);
    expect(e.message).toMatch(
      /\(each configured backend led an attempt that ended this way, so it is not one server's word: /,
    );
    expect(e.message).not.toMatch(/could not be reached/);
  });

  it('keeps the witness-section class when the other backend could not be reached', async () => {
    // E walks the path and no backend serves the raw block, so E's attempt
    // ends in the availability refusal. E2 serves nothing at all, so its
    // attempt ends on transport. Reporting the refusal is honest as long as it
    // says how far it reaches, and BUILD_FAILED would throw that away
    const p = fetchCustody(id, {
      ...OPTS,
      anchorSources: [E3, E4],
      fetchFn: stubFetch(routes(false)),
    });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(WitnessSectionUnavailableError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/spends 2 input/);
    expect(e.message).toMatch(/1 of 2 configured backends/);
    expect(e.message).toMatch(new RegExp(`ended this way: ${E}`));
    expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${E2}: `));
    expect(e.message).not.toMatch(/could not be reached/);
  });

  it('walks again on the next backend when one names a wrong block for the reveal', async () => {
    // E's own status names a real but WRONG block for the reveal. The block it
    // named is not the block its own merkle proof folds into, so the hop is
    // caught as E's answers disagreeing with each other, before the walk
    // spends anything more on it. E2 walks honestly and the bundle verifies
    // through its block. The class is availability either way, and the
    // stronger reading is that E produced no answer rather than that it
    // refused: a backend contradicting itself stands behind nothing
    const decoy = buildBlock([commit]);
    const r = mirror(routes(true), E, E2);
    r[`${E}/tx/${reveal.txid}/status`] = {
      confirmed: true,
      block_height: 100,
      block_hash: decoy.blockHash,
    };
    r[`${E}/block/${decoy.blockHash}/header`] = decoy.headerHex.trim();
    r[`${E}/block/${decoy.blockHash}`] = { id: decoy.blockHash, height: 100, tx_count: decoy.txCount };
    r[`${E}/block/${decoy.blockHash}/raw`] = serializeBlock(hexToBytes(decoy.headerHex), decoy.txs);
    r[`${E4}/block-height/100`] = block.blockHash;
    r[`${E4}/blocks/tip/height`] = '120';

    const attempts: AttemptInfo[] = [];
    const res = await fetchCustody(id, {
      ...OPTS,
      anchorSources: [E3, E4],
      witnessSection: 'always',
      fetchFn: stubFetch(r),
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.custody.hops).toBe(1);
    expect(res.custody.indexProof).toBe('wtxid');
    // one line per attempt, and the second says what ended the first
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, E2]);
    expect(attempts[0].cause).toBeUndefined();
    expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
    expect(attempts[1].total).toBe(2);

    // and with E alone there is nothing to move on to. Nothing was refused
    // here, so the report is the build failure with E's own contradiction
    // named, rather than a refusal E never stood behind
    const p = fetchCustody(id, {
      ...OPTS,
      esplora: [E],
      anchorSources: [E3, E4],
      witnessSection: 'always',
      fetchFn: stubFetch(r),
    });
    const e = (await p.catch((x: unknown) => x)) as CustodyError;
    expect(e).toBeInstanceOf(CustodyError);
    expect(e.code).toBe('BUILD_FAILED');
    expect(e.message).toMatch(/folds to a root the header of block .* does not carry/);
  });

  /**
   * The same block with one byte of the coinbase's witness reserved value
   * flipped. A txid commits to no witness byte, so the coinbase's txid, the
   * header's merkle root and the reveal's position are all unchanged, and both
   * of the tests the builder ran before this pass still succeed on it.
   */
  function flippedReservedBlock(): Uint8Array {
    const cb = block.txs[0];
    const reserved = cb.inputs[0].witness[0].slice();
    reserved[0] ^= 0x01;
    const doctored = parseTx(
      serializeFull({
        version: cb.version,
        inputs: [{ ...cb.inputs[0], witness: [reserved] }],
        outputs: cb.outputs,
        locktime: cb.locktime,
      }),
    );
    expect(doctored.txid).toBe(cb.txid);
    return serializeBlock(hexToBytes(block.headerHex), [doctored, ...block.txs.slice(1)]);
  }

  /** a hop for the reveal, as the builder assembles it before the section */
  function revealHop(): CustodyHopJson {
    return {
      block: { height: 100, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
      tx: { hex: bytesToHex(reveal.raw), pos: 1, txidBranch: [] },
      prevTxs: [],
    };
  }

  it('rotates past a backend serving a rewritten witness and completes on the next', async () => {
    const E4 = 'https://esplora4.test';
    const r = mirror(routes(false), E, E2);
    r[`${E}/block/${block.blockHash}/raw`] = flippedReservedBlock();
    r[`${E2}/block/${block.blockHash}/raw`] = serializeBlock(hexToBytes(block.headerHex), block.txs);
    r[`${E4}/block-height/100`] = block.blockHash;
    r[`${E4}/blocks/tip/height`] = '120';

    const res = await fetchCustody(id, { ...OPTS, anchorSources: [E3, E4], fetchFn: stubFetch(r) });
    expect(res.custody.indexProof).toBe('wtxid');
    expect(res.custody.genesis.offset).toBe(10_000n);
  });

  it('names a served block whose tx count disagrees with the hop, and rotates', async () => {
    const extra = legacyTxOut('66'.repeat(32), 0, [{ value: 500n }]);
    const r = routes(false);
    r[`${E}/block/${block.blockHash}/raw`] = serializeBlock(hexToBytes(block.headerHex), [
      ...block.txs,
      extra,
    ]);
    const bad = new EsploraBackend(E, stubFetch(r));
    const hop = revealHop();
    // the count is named for what it is; folding a branch over three leaves
    // against a two-leaf tree would report a branch depth instead
    await expect(attachRevealWitnessSection([bad], reveal, hop)).rejects.toThrow(
      /served a block of 3 transaction\(s\).*whose block info says 2/s,
    );
    expect(hop.witness).toBeUndefined();

    const good = new EsploraBackend(E2, stubFetch(mirror(routes(true), E, E2)));
    await attachRevealWitnessSection([bad, good], reveal, hop);
    expect(hop.witness).toBeDefined();
  });

  it('ends at the witness-section class when every backend serves a rewritten witness', async () => {
    const E4 = 'https://esplora4.test';
    const flipped = flippedReservedBlock();
    const r = mirror(routes(false), E, E2);
    r[`${E}/block/${block.blockHash}/raw`] = flipped;
    r[`${E2}/block/${block.blockHash}/raw`] = flipped;
    r[`${E4}/block-height/100`] = block.blockHash;
    r[`${E4}/blocks/tip/height`] = '120';

    const p = fetchCustody(id, { ...OPTS, anchorSources: [E3, E4], fetchFn: stubFetch(r) });
    const e = (await p.catch((x: unknown) => x)) as Error;
    // nothing was proven and another backend may serve the honest block, which
    // is UNPROVEN with a remedy, rather than the caller's own bundle called a
    // forgery at exit 1
    expect(e).toBeInstanceOf(WitnessSectionUnavailableError);
    expect(e).not.toBeInstanceOf(CustodyError);
    expect(e.message).toMatch(/witness commitment mismatch/);
    expect(e.message).toMatch(new RegExp(`${E}: the witness section built from its block`));
    expect(e.message).toMatch(new RegExp(`${E2}: the witness section built from its block`));
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
    const built = await buildCustodyBundle(setup.id, new EsploraBackend(E, stubFetch(r)), {
      powLimitBits: null,
    });
    expect('witness' in built.bundle.hops[0]).toBe(false);
    expect(verifyCustodyBundle(built.bundle, NO_POW_FLOOR).indexProof).toBe('single-input');
  });

  it('witnessSection always attaches a section to a single-input reveal', async () => {
    const setup = inscriptionSetup();
    const r = routesForBlock(setup.block, 100, 120);
    r[`${E}/tx/${setup.commit.txid}/hex`] = bytesToHex(setup.commit.raw);
    r[`${E}/tx/${setup.reveal.txid}/outspend/0`] = { spent: false };
    r[`${E}/block/${setup.block.blockHash}/raw`] = serializeBlock(
      hexToBytes(setup.block.headerHex),
      setup.block.txs,
    );
    const backend = new EsploraBackend(E, stubFetch(r));
    const always = await buildCustodyBundle(setup.id, backend, {
      witnessSection: 'always',
      powLimitBits: null,
    });
    expect(always.bundle.hops[0].witness).toBeDefined();
    const verified = verifyCustodyBundle(always.bundle, NO_POW_FLOOR);
    expect(verified.indexProof).toBe('wtxid');
    expect(verified.singleInputReveal).toBe(true);

    // when-needed on the same reveal emits the same bytes as before the option
    const needed = await buildCustodyBundle(setup.id, backend, {
      witnessSection: 'when-needed',
      powLimitBits: null,
    });
    const dflt = await buildCustodyBundle(setup.id, backend, { powLimitBits: null });
    expect(JSON.stringify(needed.bundle)).toBe(JSON.stringify(dflt.bundle));
    expect('witness' in needed.bundle.hops[0]).toBe(false);
  });

  it('bars the raw-block server from the header vote, not just the walker', async () => {
    // E walks the path; only E2 serves the raw block behind the witness
    // section. Both served bytes for this bundle, so neither may vote for its
    // header. E2 was offered as an attester and must be filtered out
    const E4 = 'https://esplora4.test';
    const r = routes(false);
    const raw = serializeBlock(hexToBytes(block.headerHex), block.txs);
    const withRaw: Record<string, Route> = {
      ...r,
      [`${E2}/block/${block.blockHash}/raw`]: raw,
      [`${E2}/tx/${reveal.txid}/outspend/0`]: { spent: false },
      [`${E4}/block-height/100`]: block.blockHash,
      [`${E4}/blocks/tip/height`]: '120',
    };
    const fetchFn = stubFetch(withRaw);

    // E2 and E3 attest; E2 served the raw block, so one vote is left and the
    // default threshold of two is not met
    const p = fetchCustody(id, { ...OPTS, fetchFn });
    await expect(p).rejects.toThrow(/not independently anchored: 1 independent source/);
    await expect(p).rejects.toThrow(/2 serving backend\(s\) excluded/);

    // with a fourth attester that served nothing, the vote carries
    const res = await fetchCustody(id, { ...OPTS, anchorSources: [E2, E3, E4], fetchFn });
    expect(res.custody.indexProof).toBe('wtxid');
    expect(res.headerTrust[0].sourcesQueried).toBe(2); // E3 and E4 only
    expect(res.headerTrust[0].independentSources).toBe(2);
    expect(res.headerTrust[0].builderIsSource).toBe(true);
  });

  it('witnessSection always with every backend failing throws with each cause', async () => {
    const setup = inscriptionSetup();
    const r = routesForBlock(setup.block, 100, 120);
    r[`${E}/tx/${setup.commit.txid}/hex`] = bytesToHex(setup.commit.raw);
    r[`${E}/tx/${setup.reveal.txid}/outspend/0`] = { spent: false };
    // no raw-block route at all: every backend fails to serve it
    const one = new EsploraBackend(E, stubFetch(r));
    const two = new EsploraBackend(E2, stubFetch(r));
    const p = buildCustodyBundle(setup.id, one, {
      witnessSection: 'always',
      witnessBackends: [one, two],
      powLimitBits: null,
    });
    await expect(p).rejects.toThrow(WitnessSectionUnavailableError);
    await expect(p).rejects.toThrow(new RegExp(E));
    await expect(p).rejects.toThrow(new RegExp(E2));
    await expect(p).rejects.toThrow(/HTTP 404/);
    await expect(p).rejects.toThrow(/always/);
  });
});

/**
 * Three checks the verifier runs that the build had no equivalent for. Each is
 * the same shape as the ones the tenth review closed: one backend's well
 * formed wrong answer used to buy the whole walk and then a bundle the
 * verifier refused at exit 1, with the other configured backends never asked.
 */
describe('fetchCustody on answers the verifier refuses and the build did not', () => {
  const E4 = 'https://esplora4.test';
  const ANCHORS = { anchorSources: [E3, E4] };
  const { commit, reveal, block, id } = inscriptionSetup();

  /** both backends honest, plus attesters that served nothing */
  function honestRoutes(): Record<string, Route> {
    const r = routesForBlock(block, 100, 120);
    r[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    r[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    r[`${E2}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    const m = mirror(r, E, E2);
    m[`${E4}/block-height/100`] = block.blockHash;
    m[`${E4}/blocks/tip/height`] = '120';
    return m;
  }

  /**
   * A legacy spend whose stripped serialization is exactly 64 bytes: 4 version,
   * 1 input count, 36 outpoint, 2 scriptSig, 4 sequence, 1 output count, 8
   * value, 4 scriptPubKey, 4 locktime. That length is the leaf/node ambiguity
   * class the txid tree has, and both verifiers reject it.
   */
  function spend64(prevTxidDisplay: string, vout: number, value: bigint): ParsedTx {
    const parts: Uint8Array[] = [u32le(2), new Uint8Array([1])];
    parts.push(hexToBytes(prevTxidDisplay).reverse(), u32le(vout), new Uint8Array([1, 0x51]), u32le(0xffffffff));
    parts.push(new Uint8Array([1]), u64le(value), new Uint8Array([3, 0x51, 0x51, 0x51]));
    parts.push(u32le(0));
    const tx = parseTx(cat(...parts));
    expect(tx.strippedRaw.length).toBe(64);
    return tx;
  }

  it('rotates past a 64-byte hop transaction and resolves through the next backend', async () => {
    const value = reveal.outputs[0].value;
    const bad = spend64(reveal.txid, 0, value);
    const blockB = buildBlock([bad]);
    const r = honestRoutes();
    // only E claims the reveal was spent, and it names a transaction no
    // verifier will read; E2 answers that the reveal is still unspent
    for (const [url, route] of Object.entries(routesForBlock(blockB, 105, 120))) {
      if (url.startsWith(E)) r[url] = route;
    }
    r[`${E}/tx/${reveal.txid}/outspend/0`] = {
      spent: true,
      txid: bad.txid,
      vin: 0,
      status: { confirmed: true, block_height: 105, block_hash: blockB.blockHash },
    };
    // the rest of E's story is complete, so without the build-time rule the
    // walk finished and the caller's own bundle was refused at verification
    r[`${E}/tx/${bad.txid}/outspend/0`] = { spent: false };

    const attempts: AttemptInfo[] = [];
    const res = await fetchCustody(id, {
      ...OPTS,
      ...ANCHORS,
      fetchFn: stubFetch(r),
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.custody.hops).toBe(1);
    expect(res.custody.satpoint.txid).toBe(reveal.txid);
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, E2]);
    expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
    expect(attempts[1].cause?.message).toMatch(/64-byte stripped serialization/);
    expect(attempts[1].cause?.message).toMatch(new RegExp(`^${E}: hop 1 transaction`));
  });

  it('rotates past a hop the backend places before the hop it spends', async () => {
    // strict chain order is a MUST on verifiers (SPEC-CUSTODY): increasing
    // height, or equal height with strictly increasing position. The walk
    // follows this backend's own outspend answers, so it can be pointed at a
    // spend it also claims was mined five blocks BEFORE the reveal
    const value = reveal.outputs[0].value;
    const spend = legacySpend(reveal.txid, 0, [value]);
    const blockB = buildBlock([spend]);
    const r = honestRoutes();
    for (const [url, route] of Object.entries(routesForBlock(blockB, 95, 120))) {
      if (url.startsWith(E)) r[url] = route;
    }
    r[`${E}/tx/${reveal.txid}/outspend/0`] = {
      spent: true,
      txid: spend.txid,
      vin: 0,
      status: { confirmed: true, block_height: 95, block_hash: blockB.blockHash },
    };
    // the rest of E's story is complete, so without the build-time rule the
    // walk finished and the caller's own bundle was refused at verification
    r[`${E}/tx/${spend.txid}/outspend/0`] = { spent: false };

    const attempts: AttemptInfo[] = [];
    const res = await fetchCustody(id, {
      ...OPTS,
      ...ANCHORS,
      fetchFn: stubFetch(r),
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.custody.hops).toBe(1);
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, E2]);
    expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
    expect(attempts[1].cause?.message).toMatch(
      /hop 1 sits at height 95 position 1 and hop 0 at height 100 position 1/,
    );
    expect(attempts[1].cause?.message).toMatch(/does not come after what it spends/);
  });

  /**
   * The block info a backend already served carries three fields past
   * `tx_count`, and the build discarded them. Each is checked against another
   * answer the same backend gave. What this cannot catch is a backend that
   * lies consistently; that is the BIP34 residual, and it is closed by
   * hash-at-height anchoring after the loop instead.
   */
  describe('block info fields the same backend contradicts', () => {
    const trueRoot = internalToDisplay(parseHeader(hexToBytes(block.headerHex)).merkleRootLE);

    /** the block info E serves, complete and honest unless a field is doctored */
    function blockInfo(over: Record<string, unknown> = {}): object {
      return {
        id: block.blockHash,
        height: 100,
        tx_count: block.txCount,
        merkle_root: trueRoot,
        ...over,
      };
    }

    const cases: [string, Record<string, unknown>, RegExp][] = [
      [
        'an id naming another block',
        { id: 'aa'.repeat(32) },
        /identifies itself as aa+, and the status of .* named/,
      ],
      ['a height contradicting the status', { height: 101 }, /says height 101, its status says height 100/],
      [
        'a merkle root the header does not carry',
        { merkle_root: 'bb'.repeat(32) },
        /says merkle root bb+, and the header it served for that block carries/,
      ],
    ];

    for (const [what, over, message] of cases) {
      it(`rotates past ${what}`, async () => {
        const r = honestRoutes();
        // E2's copy stays honest and complete, so only the named field differs
        r[`${E2}/block/${block.blockHash}`] = blockInfo();
        r[`${E}/block/${block.blockHash}`] = blockInfo(over);
        const attempts: AttemptInfo[] = [];
        const res = await fetchCustody(id, {
          ...OPTS,
          ...ANCHORS,
          fetchFn: stubFetch(r),
          onAttempt: (info) => attempts.push(info),
        });
        expect(res.custody.hops).toBe(1);
        expect(res.custody.satpoint.txid).toBe(reveal.txid);
        expect(attempts.map((a) => a.baseUrl)).toEqual([E, E2]);
        expect(attempts[1].cause).toBeInstanceOf(HopConsistencyError);
        expect(attempts[1].cause?.message).toMatch(message);
      });
    }

    it('builds when all three agree with the other answers', async () => {
      const r = honestRoutes();
      r[`${E}/block/${block.blockHash}`] = blockInfo();
      const res = await fetchCustody(id, { ...OPTS, ...ANCHORS, fetchFn: stubFetch(r) });
      expect(res.custody.satpoint.txid).toBe(reveal.txid);
    });
  });
});
