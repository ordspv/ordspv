import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  buildMerkleBranch,
  checkProofOfWork,
  computeMerkleRoot,
  CustodyUnsupportedError,
  firstSatOfBlock,
  hexToBytes,
  internalToDisplay,
  parseHeader,
  parseTx,
  satName,
  serializeFull,
  verifySatGenealogy,
  type ParsedTx,
} from '@ordspv/core';
import { EsploraBackend, type FetchFn } from '../src/backends.js';
import {
  buildSatGenealogyBundle,
  DEFAULT_MAX_STEPS,
  fetchSatIdentity,
  SatBuildError,
  SatIdentityError,
  SatStepLimitError,
} from '../src/index.js';
import { envelopeScript, taprootCommit } from '../../core/test/helpers.js';

/**
 * Sat genealogy building driven against a mock esplora. The backend here is
 * not even a pathfinder: every txid the walk asks for is named by an input it
 * has already proven, so a wrong answer is caught locally. Synthetic blocks
 * are regtest-difficulty, so powLimitBits is disabled and checkpoints are
 * empty, mirroring the custody suite.
 */

const E = 'https://esplora.test';
// attester-only stubs: E serves every proof ingredient and is therefore barred
// from voting on its own headers
const E2 = 'https://esplora2.test';
const E3 = 'https://esplora3.test';
// a second serving backend, for failover assertions
const EB = 'https://esplorab.test';

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

// ---------------------------------------------------------------------------
// local chain builders: the arithmetic only needs values, scripts and heights
// ---------------------------------------------------------------------------

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
function varint(n: number): Uint8Array {
  if (n > 0xfc) throw new Error('test varint only supports small counts');
  return new Uint8Array([n]);
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

interface OutSpec {
  value: bigint;
  spk?: Uint8Array;
}

interface Chained {
  hex: string;
  tx: ParsedTx;
}

/** legacy (no-witness) transaction over explicit outpoints */
function buildTx(
  inputs: { txid: string; vout: number; scriptSig?: Uint8Array }[],
  outputs: OutSpec[],
): Chained {
  const parts: Uint8Array[] = [u32le(2), varint(inputs.length)];
  for (const inp of inputs) {
    const sig = inp.scriptSig ?? new Uint8Array([0x51]);
    parts.push(hexToBytes(inp.txid).reverse(), u32le(inp.vout), varint(sig.length), sig, u32le(0xffffffff));
  }
  parts.push(varint(outputs.length));
  for (const o of outputs) {
    const spk = o.spk ?? new Uint8Array([0x51]);
    parts.push(u64le(o.value), varint(spk.length), spk);
  }
  parts.push(u32le(0));
  const raw = cat(...parts);
  return { hex: bytesToHex(raw), tx: parseTx(raw) };
}

/** BIP34 coinbase scriptSig: minimally encoded little-endian height push */
function bip34ScriptSig(height: number): Uint8Array {
  const bytes: number[] = [];
  let h = height;
  while (h > 0) {
    bytes.push(h & 0xff);
    h = Math.floor(h / 256);
  }
  if (bytes.length === 0) bytes.push(0);
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return new Uint8Array([bytes.length, ...bytes]);
}

/** A coinbase claiming `height` (BIP34) and paying `outputs`. */
function coinbaseTx(height: number, outputs: OutSpec[]): Chained {
  return buildTx([{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: bip34ScriptSig(height) }], outputs);
}

/** A segwit transaction; input 0 carries the reveal witness stack. */
function segwitTx(
  inputs: { txid: string; vout: number; witness?: Uint8Array[] }[],
  outputs: OutSpec[],
): Chained {
  const raw = serializeFull({
    version: 2,
    inputs: inputs.map((i) => ({
      prevTxidLE: hexToBytes(i.txid).reverse(),
      prevTxid: i.txid,
      vout: i.vout,
      scriptSig: new Uint8Array(0),
      sequence: 0xfffffffd,
      witness: i.witness ?? [],
    })),
    outputs: outputs.map((o) => ({ value: o.value, scriptPubKey: o.spk ?? new Uint8Array([0x51]) })),
    locktime: 0,
  });
  return { hex: bytesToHex(raw), tx: parseTx(raw) };
}

interface MinedBlock {
  headerHex: string;
  blockHash: string;
  txs: ParsedTx[];
  txCount: number;
}

/**
 * Mine a regtest-difficulty header over the given transactions. Genealogy
 * proofs only use the txid tree, so no witness commitment is needed here.
 */
function mineBlock(txs: ParsedTx[]): MinedBlock {
  const root = computeMerkleRoot(txs.map((t) => t.txidLE));
  for (let nonce = 0; nonce < 200_000; nonce++) {
    const h = new Uint8Array(80);
    const view = new DataView(h.buffer);
    view.setInt32(0, 4, true);
    h.set(root, 36);
    view.setUint32(68, 1_700_000_000, true);
    view.setUint32(72, 0x207fffff, true);
    view.setUint32(76, nonce, true);
    const header = parseHeader(h);
    if (checkProofOfWork(header)) {
      return { headerHex: bytesToHex(h), blockHash: header.hash, txs, txCount: txs.length };
    }
  }
  throw new Error('failed to mine test header');
}

function routesFor(block: MinedBlock, height: number, tipHeight: number): Record<string, Route> {
  const routes: Record<string, Route> = {
    [`${E}/block/${block.blockHash}/header`]: block.headerHex,
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

const SCRIPT = envelopeScript({ fields: [[1, 'text/plain']], body: ['sat'] }, { checksigPrefix: true });
const TAP = taprootCommit(SCRIPT);
const WITNESS = [new Uint8Array(64).fill(7), SCRIPT, TAP.controlBlock];

/**
 * Envelope script carrying a pointer (tag 2, trimmed little-endian), with the
 * commit scriptPubKey the envelope input has to spend for the binding to hold.
 */
function pointerCommit(pointer: number): { witness: Uint8Array[]; scriptPubKey: Uint8Array } {
  const le: number[] = [];
  let p = pointer;
  while (p > 0) {
    le.push(p & 0xff);
    p = Math.floor(p / 256);
  }
  const script = envelopeScript(
    { fields: [[1, 'text/plain'], [2, new Uint8Array(le)]], body: ['sat'] },
    { checksigPrefix: true },
  );
  const tap = taprootCommit(script);
  return {
    witness: [new Uint8Array(64).fill(7), script, tap.controlBlock],
    scriptPubKey: tap.scriptPubKey,
  };
}

const CB_HEIGHT = 700_000;
const SUBSIDY = 625_000_000n; // 50e8 >> 3
const REVEAL_HEIGHT = 700_010;
const TIP = 700_100;

const OPTS = {
  esplora: [E],
  anchorSources: [E2, E3],
  powLimitBits: null as null,
  checkpoints: new Map<number, string>(),
};

/**
 * Assemble routes for a chain whose terminal coinbase sits in its own block
 * and whose reveal sits in a later two-transaction block.
 */
function chainRoutes(
  coinbase: Chained,
  reveal: Chained,
  middle: Chained[],
  opts: { cbHeight?: number } = {},
): Record<string, Route> {
  const cbHeight = opts.cbHeight ?? CB_HEIGHT;
  const cbBlock = mineBlock([coinbase.tx]);
  const revealBlock = mineBlock([coinbaseTx(REVEAL_HEIGHT, [{ value: SUBSIDY }]).tx, reveal.tx]);
  const routes = {
    ...routesFor(cbBlock, cbHeight, TIP),
    ...routesFor(revealBlock, REVEAL_HEIGHT, TIP),
  };
  for (const m of middle) routes[`${E}/tx/${m.tx.txid}/hex`] = m.hex;
  return routes;
}

describe('fetchSatIdentity', () => {
  it('traces a reveal funded straight out of a coinbase', async () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(routes) });
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT));
    expect(res.identity.name).toBe(satName(firstSatOfBlock(CB_HEIGHT)));
    expect(res.identity.rarity).toBe('uncommon'); // first sat of a non-periodic block
    expect(res.identity.coinbaseHeight).toBe(CB_HEIGHT);
    expect(res.identity.depth).toBe(1);
    expect(res.identity.revealPosition).toBe(0n);

    // both endpoints anchored by two attesters that served none of the bundle
    expect(res.headerTrust.reveal.anchored).toBe(true);
    expect(res.headerTrust.reveal.independentSources).toBe(2);
    expect(res.headerTrust.reveal.builderIsSource).toBe(true);
    expect(res.headerTrust.coinbase.anchored).toBe(true);

    // the bundle stands alone: re-verifying it offline yields the same identity
    expect(verifySatGenealogy(res.bundle).sat).toBe(res.identity.sat);
    expect(res.bundle.funding).toHaveLength(1);
    expect(res.bundle.coinbase.tx.pos).toBe(0);
  });

  it('walks a multi-step chain, fetching only the prev txs the position needs', async () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const f1 = buildTx(
      [{ txid: coinbase.tx.txid, vout: 0 }],
      [{ value: 100_000_000n }, { value: 200_000_000n }],
    );
    // input 1 is a consolidation leg the traced sat never touches; no route is
    // registered for its funding tx, so fetching it at all would 404
    const f2 = buildTx(
      [
        { txid: f1.tx.txid, vout: 1 },
        { txid: '77'.repeat(32), vout: 0 },
      ],
      [{ value: 50_000_000n }, { value: 150_000_000n }],
    );
    const commit = buildTx([{ txid: f2.tx.txid, vout: 1 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit, f2, f1]);

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(routes) });
    // commit:0 -> f2:1 (+50e6) -> f1:1 (+100e6) -> coinbase:0 at 150e6
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT) + 150_000_000n);
    expect(res.identity.rarity).toBe('common');
    expect(res.identity.depth).toBe(3);
    expect(res.bundle.funding.map((f) => parseTx(hexToBytes(f.tx.hex)).txid)).toEqual([
      commit.tx.txid,
      f2.tx.txid,
      f1.tx.txid,
    ]);
    // f2 has two inputs but the position was covered by the first
    expect(res.bundle.funding[1].prevTxs).toHaveLength(1);
    expect(parseTx(hexToBytes(res.bundle.funding[1].tx.hex)).inputs).toHaveLength(2);
  });

  it('follows a pointer that lands past the envelope input', async () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const ptr = pointerCommit(1500);
    const fA = buildTx(
      [{ txid: coinbase.tx.txid, vout: 0 }],
      [{ value: 1000n, spk: ptr.scriptPubKey }, { value: 2000n }],
    );
    // envelope on input 0, pointer 1500 -> output space position 1500, which the
    // SECOND input funds; the reveal hop therefore needs prev txs past input 0
    const reveal = segwitTx(
      [
        { txid: fA.tx.txid, vout: 0, witness: ptr.witness },
        { txid: fA.tx.txid, vout: 1 },
      ],
      [{ value: 2500n }],
    );
    const routes = chainRoutes(coinbase, reveal, [fA]);

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(routes) });
    expect(res.identity.revealPosition).toBe(1500n);
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT) + 1500n);
    expect(res.identity.depth).toBe(1);
    // both reveal inputs are funded by the same transaction: identical hexes
    expect(res.bundle.reveal.prevTxs).toEqual([fA.hex, fA.hex]);
    expect(verifySatGenealogy(res.bundle).sat).toBe(res.identity.sat);
  });

  it('rejects a backend that serves different bytes on a second request', async () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const decoy = buildTx([{ txid: '55'.repeat(32), vout: 0 }], [{ value: 10_000n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    // first read (proving the reveal's input value) is honest, the walk's read
    // is not: the served bytes no longer hash to the txid the input names
    let served = 0;
    routes[`${E}/tx/${commit.tx.txid}/hex`] = () =>
      new Response(served++ === 0 ? commit.hex : decoy.hex);

    const backend = new EsploraBackend(E, stubFetch(routes), {});
    const p = buildSatGenealogyBundle(`${reveal.tx.txid}i0`, backend);
    await expect(p).rejects.toThrow(SatBuildError);
    await expect(p).rejects.toThrow(/backend served/);
  });

  it('completes a chain of exactly maxSteps and names the cap when it does not', async () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const f1 = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 400_000_000n }]);
    const commit = buildTx([{ txid: f1.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit, f1]);
    const id = `${reveal.tx.txid}i0`;

    const ok = await fetchSatIdentity(id, { ...OPTS, maxSteps: 2, fetchFn: stubFetch(routes) });
    expect(ok.identity.depth).toBe(2);

    // the cap is deterministic, so it surfaces as itself rather than as a
    // per-backend failure list, and it names the flag that raises it
    const p = fetchSatIdentity(id, { ...OPTS, maxSteps: 1, fetchFn: stubFetch(routes) });
    await expect(p).rejects.toThrow(SatStepLimitError);
    await expect(p).rejects.toThrow(/exceeds 1 funding steps/);
    await expect(p).rejects.toThrow(/--max-steps/);
    await expect(p).rejects.not.toThrow(SatIdentityError);
  });

  it('does not rewalk the ancestry on a second backend after hitting the cap', async () => {
    // every backend walks to the same step, so a second full walk buys
    // nothing: the request count with two backends pooled must match the
    // request count with one
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const f1 = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 400_000_000n }]);
    const commit = buildTx([{ txid: f1.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit, f1]);
    const id = `${reveal.tx.txid}i0`;

    const counting = () => {
      let calls = 0;
      const base = stubFetch(routes);
      const fetchFn: FetchFn = (url, init) => {
        if (!url.startsWith(E2) && !url.startsWith(E3)) calls++;
        return base(url.replace(EB, E), init);
      };
      return { fetchFn, count: () => calls };
    };

    const one = counting();
    await expect(
      fetchSatIdentity(id, { ...OPTS, esplora: [E], maxSteps: 1, fetchFn: one.fetchFn }),
    ).rejects.toThrow(SatStepLimitError);

    const two = counting();
    await expect(
      fetchSatIdentity(id, { ...OPTS, esplora: [E, EB], maxSteps: 1, fetchFn: two.fetchFn }),
    ).rejects.toThrow(SatStepLimitError);

    expect(two.count()).toBe(one.count());
  });

  it('walks past the old 512-step ceiling on the raised default', async () => {
    // 600 funding steps: refused before, built now without passing maxSteps
    expect(DEFAULT_MAX_STEPS).toBeGreaterThan(600);
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const middle: Chained[] = [];
    let prev = coinbase;
    for (let i = 0; i < 600; i++) {
      prev = buildTx([{ txid: prev.tx.txid, vout: 0 }], [{ value: SUBSIDY - BigInt(i + 1) }]);
      middle.push(prev);
    }
    const commit = buildTx([{ txid: prev.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit, ...middle]);

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(routes) });
    expect(res.identity.depth).toBe(601);
    expect(res.identity.coinbaseHeight).toBe(CB_HEIGHT);
  });

  it('keeps walk progress when a pool member fails mid-walk', async () => {
    // the old shape restarted the whole walk on the next backend; the pool
    // hands the failing REQUEST to the next member and carries on
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const f1 = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 400_000_000n }]);
    const commit = buildTx([{ txid: f1.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit, f1]);

    // E rate-limits the deepest funding tx; EB serves everything E serves
    const base = stubFetch(routes);
    let refusals = 0;
    const fetchFn: FetchFn = (url, init) => {
      if (url === `${E}/tx/${f1.tx.txid}/hex`) {
        refusals++;
        return Promise.resolve(new Response('slow down', { status: 429 }));
      }
      return base(url.replace(EB, E), init);
    };

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      // no waiting on a real backoff: rotation is what this asserts
      limits: { retry: { maxAttempts: 1 } },
      fetchFn,
    });
    expect(refusals).toBeGreaterThan(0);
    expect(res.identity.depth).toBe(2);
    expect(res.identity.coinbaseHeight).toBe(CB_HEIGHT);
  });

  it('bars every pool member that served bytes from attesting', async () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const base = stubFetch(routes);
    // EB serves proofs AND is offered as an attester; it must be filtered out
    const fetchFn: FetchFn = (url, init) => base(url.replace(EB, E), init);
    routes[`${EB}/block-height/${CB_HEIGHT}`] = routes[`${E}/block-height/${CB_HEIGHT}`];

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      anchorSources: [EB, E2, E3],
      fetchFn,
    });
    expect(res.headerTrust.coinbase.sourcesQueried).toBe(2); // E2 and E3 only
    expect(res.headerTrust.coinbase.independentSources).toBe(2);
    expect(res.headerTrust.coinbase.builderIsSource).toBe(true);
  });

  it('surfaces a fee-tail ancestry as CustodyUnsupportedError, not backend failover', async () => {
    // the coinbase pays subsidy plus 100k in fee sats; the traced sat sits at
    // the first fee sat, so numbering it would need whole-block accounting
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 100_000n }]);
    const f1 = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: SUBSIDY }, { value: 90_000n }]);
    const commit = buildTx([{ txid: f1.tx.txid, vout: 1 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit, f1]);

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(routes) });
    await expect(p).rejects.toThrow(CustodyUnsupportedError);
    await expect(p).rejects.toThrow(/fee sats in block 700000/);
  });

  it('reports a coinbase whose BIP34 height contradicts the bundle as VERIFY_FAILED', async () => {
    // the builder trusts the status endpoint for the height; the verifier does
    // not, and the coinbase itself says otherwise
    const coinbase = coinbaseTx(CB_HEIGHT + 1, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(routes) });
    await expect(p).rejects.toThrow(SatIdentityError);
    await expect(p).rejects.toThrow(/BIP34 height 700001 contradicts claimed height 700000/);
  });

  it('refuses an unbound inscription rather than inventing a sat', async () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 0n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 0n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(routes) });
    await expect(p).rejects.toThrow(CustodyUnsupportedError);
    await expect(p).rejects.toThrow(/unbound at reveal/);
  });
});
