import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  buildMerkleBranch,
  checkProofOfWork,
  computeMerkleRoot,
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  firstSatOfBlock,
  hexToBytes,
  internalToDisplay,
  parseHeader,
  parseTx,
  satName,
  serializeBlock,
  serializeFull,
  verifySatGenealogy,
  type ParsedTx,
} from '@ordspv/core';
import { EsploraBackend, type FetchFn } from '../src/backends.js';
import {
  buildSatGenealogyBundle,
  DEFAULT_MAX_STEPS,
  fetchCustody,
  fetchSatIdentity,
  RevealSourceError,
  SatBuildError,
  SatIdentityError,
  perHeaderAttestation,
  SatPositionError,
  SatStepLimitError,
  WitnessSectionUnavailableError,
  type AttemptInfo,
} from '../src/index.js';
import {
  buildBlock,
  envelopeScript,
  taprootCommit,
  NO_POW_FLOOR,
} from '../../core/test/helpers.js';

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
// a third, for the accounting that has to cover members no attempt ever led
const EC = 'https://esplorac.test';

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
    expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).sat).toBe(res.identity.sat);
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
    // two inputs, so the numbering needs the block's witness commitment
    const revealBlock = buildBlock([reveal.tx]);
    const routes = {
      ...chainRoutes(coinbase, reveal, [fA]),
      ...routesFor(revealBlock, REVEAL_HEIGHT, TIP),
      [`${E}/block/${revealBlock.blockHash}/raw`]: serializeBlock(
        hexToBytes(revealBlock.headerHex),
        revealBlock.txs,
      ),
    };

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(routes) });
    expect(res.identity.indexProof).toBe('wtxid');
    expect(res.identity.revealPosition).toBe(1500n);
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT) + 1500n);
    expect(res.identity.depth).toBe(1);
    // both reveal inputs are funded by the same transaction: identical hexes
    expect(res.bundle.reveal.prevTxs).toEqual([fA.hex, fA.hex]);
    expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).sat).toBe(res.identity.sat);
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

  it('records a lead serving another transaction for the reveal as no usable answer', async () => {
    // the inscription id commits to the reveal's stripped hash, so bytes
    // hashing to some other transaction are the lead's wrong answer rather
    // than anything to reason from: E lands in noAnswer with its cause and EB
    // leads the next attempt. Before the check the decoy's missing envelope
    // was a plain build error that ended the whole build with EB never led
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const decoy = buildTx([{ txid: '55'.repeat(32), vout: 0 }], [{ value: 10_000n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const honest = stubFetch(routes);
    const base = stubFetch({ ...routes, [`${E}/tx/${reveal.tx.txid}/hex`]: decoy.hex });
    const fetchFn: FetchFn = (url, init) =>
      url.startsWith(EB) ? honest(url.replace(EB, E), init) : base(url, init);

    const attempts: AttemptInfo[] = [];
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT));
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, EB]);
    expect(attempts[1].cause).toBeInstanceOf(RevealSourceError);
    expect((attempts[1].cause as Error).message).toMatch(/backend served .* for requested/);
    expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).sat).toBe(res.identity.sat);
  });

  it('never records a refusal derived from wrong-txid reveal bytes', async () => {
    // both members serve, for the requested txid, a valid parse of a
    // DIFFERENT transaction whose envelope is unbound, with the decoy's
    // status and merkle proof registered so the walk would reach the domain
    // refusal. One local hash reclassifies the bytes as served-wrong-bytes:
    // both members land in noAnswer and no CustodyUnsupportedError is ever
    // recorded. Before the check both attempts recorded the refusal the
    // decoy's witness decided and the build called it unanimous, the exit 4
    // upgrade
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const evenField = envelopeScript(
      { fields: [[1, 'text/plain'], [22, new Uint8Array([1])]], body: ['unbound'] },
      { checksigPrefix: true },
    );
    // one sat more on the output, so the stripped txid differs from the id's
    const poisoned = segwitTx(
      [
        {
          txid: commit.tx.txid,
          vout: 0,
          witness: [new Uint8Array(64).fill(7), evenField, taprootCommit(evenField).controlBlock],
        },
      ],
      [{ value: 547n }],
    );
    expect(poisoned.tx.txid).not.toBe(reveal.tx.txid);

    const routes = chainRoutes(coinbase, reveal, [commit]);
    routes[`${E}/tx/${reveal.tx.txid}/hex`] = poisoned.hex;
    routes[`${E}/tx/${poisoned.tx.txid}/status`] = routes[`${E}/tx/${reveal.tx.txid}/status`];
    routes[`${E}/tx/${poisoned.tx.txid}/merkle-proof`] =
      routes[`${E}/tx/${reveal.tx.txid}/merkle-proof`];
    const base = stubFetch(routes);
    // EB mirrors E, wrong-txid reveal included
    const fetchFn: FetchFn = (url, init) => base(url.replace(EB, E), init);

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
    const e = (await p.catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(SatIdentityError);
    expect((e as SatIdentityError).code).toBe('BUILD_FAILED');
    expect(e).not.toBeInstanceOf(CustodyUnsupportedError);
    expect(e.message).toMatch(/backend served .* for requested/);
    expect(e.message).toMatch(new RegExp(E));
    expect(e.message).toMatch(new RegExp(EB));
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

  it('rewalks on the next backend after the cap, and names both when both agree', async () => {
    // the depth that reached the cap is a function of a start position read
    // out of an unbound witness, so one backend's cap is one backend's claim.
    // The walk is repeated leading with the second member, at the cost of a
    // second full walk, and only then is the refusal the ancestry's answer
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
    const single = fetchSatIdentity(id, { ...OPTS, esplora: [E], maxSteps: 1, fetchFn: one.fetchFn });
    await expect(single).rejects.toThrow(SatStepLimitError);
    // one configured backend is one server's word, whatever the loop did
    await expect(single).rejects.toThrow(
      new RegExp(`the single configured backend reported it: ${E}`),
    );

    const two = counting();
    const pair = fetchSatIdentity(id, { ...OPTS, esplora: [E, EB], maxSteps: 1, fetchFn: two.fetchFn });
    await expect(pair).rejects.toThrow(SatStepLimitError);
    await expect(pair).rejects.toThrow(new RegExp(`${E},.*${EB}`));

    expect(two.count()).toBe(one.count() * 2);
  });

  it('reads its own deep build under the raised cap, not the verifier default', async () => {
    // --max-steps is documented as the bound the verifier reads a genealogy
    // under. It reached the walk alone, so an ancestry past the verifier's own
    // default of 10,000 built and was then refused by the verification the
    // same call runs, and the caller was told the bundle was invalid
    const DEPTH = 10_001;
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const middle: Chained[] = [];
    let prev = coinbase;
    for (let i = 0; i < DEPTH - 1; i++) {
      prev = buildTx([{ txid: prev.tx.txid, vout: 0 }], [{ value: SUBSIDY - BigInt(i + 1) }]);
      middle.push(prev);
    }
    const commit = buildTx([{ txid: prev.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit, ...middle]);

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      maxSteps: 20_000,
      fetchFn: stubFetch(routes),
    });
    expect(res.identity.depth).toBe(DEPTH);
    expect(res.bundle.funding.length).toBe(DEPTH);

    // the bundle really is past the default, which is what the live path was
    // refusing: read back with no cap named it is the step-cap class and not a
    // verdict on the document
    expect(() => verifySatGenealogy(res.bundle, NO_POW_FLOOR)).toThrow(SatStepLimitError);
    expect(verifySatGenealogy(res.bundle, { ...NO_POW_FLOOR, maxSteps: 20_000 }).depth).toBe(DEPTH);
  }, 120_000);

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

  it('bars a lead that served only the deciding requests from attesting', async () => {
    // the deciding requests do not pass through the pool, so a lead that
    // serves them and refuses every pooled request never enters
    // usedBaseUrls. Offered as an anchor source it could then vote on the
    // bytes it chose, turning 2-of-N agreement into one genuine outsider
    // plus its own voice. The lead is barred by name: anchoring that then
    // falls short of the minimum reports HEADER_TRUST instead of counting
    // the self-vote
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const honest = stubFetch(routes);
    // E answers the four deciding requests and the attester endpoints, and
    // refuses every pooled proof request; EB serves everything
    const deciding = new Set([
      `${E}/tx/${reveal.tx.txid}/hex`,
      `${E}/tx/${reveal.tx.txid}/status`,
      `${E}/tx/${reveal.tx.txid}/merkle-proof`,
      `${E}/tx/${coinbase.tx.txid}/status`,
    ]);
    const fetchFn: FetchFn = (url, init) => {
      if (url.startsWith(E) && !deciding.has(url) && !url.includes('/block-height/') && !url.includes('/tip/')) {
        return Promise.resolve(new Response('lead serves proofs to no pool', { status: 404 }));
      }
      return honest(url.replace(EB, E), init);
    };

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      anchorSources: [E, E2],
      fetchFn,
      limits: { retry: { maxAttempts: 1 } },
    });
    const e = (await p.catch((x: unknown) => x)) as SatIdentityError;
    expect(e).toBeInstanceOf(SatIdentityError);
    expect(e.code).toBe('HEADER_TRUST');
    expect(e.message).toMatch(/1 independent source/);
    expect(e.message).toMatch(/excluded from the vote/);
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

  it('carries the anchor attestation into a sub-BIP34 coinbase height', async () => {
    // below 230,000 the coinbase carries no height push, so acceptance rests
    // on the anchoring this wrapper did before verifying, reported to the core
    // verifier as the hook's return value
    const low = 100_000;
    const coinbase = coinbaseTx(low, [{ value: 5_000_000_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit], { cbHeight: low });

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      fetchFn: stubFetch(routes),
    });
    expect(res.identity.coinbaseHeight).toBe(low);
    expect(res.identity.sat).toBe(firstSatOfBlock(low));
    expect(res.headerTrust.coinbase.attests).toBe('hash-at-height');

    // the same build with an anchor that only rejects: it cannot attest the
    // height, so the identity is refused rather than reported on the server's
    // word about which block mined the sat
    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      fetchFn: stubFetch(routes),
      trustHeader: async () => ({
        checkpointHit: false,
        sourcesQueried: 0,
        sourcesAgreed: 0,
        independentSources: 0,
        builderIsSource: false,
        anchored: true,
        attests: undefined,
      }),
    });
    // the refusal passes through unwrapped: the bundle may be honest and
    // merely unanchored, which the caller has to tell from a forgery
    await expect(p).rejects.toThrow(CoinbaseHeightUnprovenError);
    await expect(p).rejects.not.toThrow(SatIdentityError);
    await expect(p).rejects.toThrow(/below the BIP34 boundary 230000/);
    await expect(p).rejects.toThrow(/hash-at-height/);
    // and the core class itself is what refused
    expect(() =>
      verifySatGenealogy(res.bundle, { ...NO_POW_FLOOR, trustHeader: () => {} }),
    ).toThrow(CoinbaseHeightUnprovenError);
  });

  it('asks the next backend when one serves an unbound envelope', async () => {
    // the reveal's envelope is read out of a witness the txid does not commit
    // to, so E can serve an unbound one and keep the txid. EB serves the
    // honest witness, and the identity comes from EB
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    // tag 22 is even and unrecognized, which is what makes ord call it unbound
    const evenField = envelopeScript(
      { fields: [[1, 'text/plain'], [22, new Uint8Array([1])]], body: ['unbound'] },
      { checksigPrefix: true },
    );
    const poisoned = segwitTx(
      [
        {
          txid: commit.tx.txid,
          vout: 0,
          witness: [new Uint8Array(64).fill(7), evenField, taprootCommit(evenField).controlBlock],
        },
      ],
      [{ value: 546n }],
    );
    expect(poisoned.tx.txid).toBe(reveal.tx.txid);

    const routes = chainRoutes(coinbase, reveal, [commit]);
    // EB answers everything E answers, except that E serves the unbound reveal
    const base = stubFetch({ ...routes, [`${E}/tx/${reveal.tx.txid}/hex`]: poisoned.hex });
    const honest = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) =>
      url.startsWith(EB) ? honest(url.replace(EB, E), init) : base(url, init);

    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
    });
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT));
    expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).sat).toBe(res.identity.sat);
  });

  it('asks the next member when one serves a pointer outside the reveal', async () => {
    // the pointer and the envelope input are read out of a witness the txid
    // does not commit to, so the start position they imply is one member's
    // word. A position outside the reveal's sat space used to end the whole
    // build at attempt 0, with every other member unasked
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    // outputs past the inputs, so a pointer can be inside output space and
    // still past every sat the reveal spends
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 50_000n }]);
    const outside = pointerCommit(40_000);
    const poisoned = segwitTx(
      [{ txid: commit.tx.txid, vout: 0, witness: outside.witness }],
      [{ value: 50_000n }],
    );
    expect(poisoned.tx.txid).toBe(reveal.tx.txid);

    const routes = chainRoutes(coinbase, reveal, [commit]);
    const base = stubFetch({ ...routes, [`${E}/tx/${reveal.tx.txid}/hex`]: poisoned.hex });
    const honest = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) =>
      url.startsWith(EB) ? honest(url.replace(EB, E), init) : base(url, init);

    // the position the poisoned witness implies is refused in its own class
    await expect(
      buildSatGenealogyBundle(`${reveal.tx.txid}i0`, new EsploraBackend(E, base)),
    ).rejects.toThrow(SatPositionError);

    const attempts: AttemptInfo[] = [];
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT));
    expect(res.identity.revealPosition).toBe(0n);
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, EB]);
    expect(attempts[1].cause).toBeInstanceOf(SatPositionError);
    expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).sat).toBe(res.identity.sat);
  });

  it('keeps the class when the next lead member could not be reached at all', async () => {
    // E serves an unbound reveal, so its attempt ends in the domain refusal.
    // The attempt led by EB reads the honest reveal and then walks into a
    // funding tx no member serves, which ends that attempt on transport. No
    // attempt produced a bundle, so the refusal is what the build has, and it
    // says how many backends reached it
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const evenField = envelopeScript(
      { fields: [[1, 'text/plain'], [22, new Uint8Array([1])]], body: ['unbound'] },
      { checksigPrefix: true },
    );
    const poisoned = segwitTx(
      [
        {
          txid: commit.tx.txid,
          vout: 0,
          witness: [new Uint8Array(64).fill(7), evenField, taprootCommit(evenField).controlBlock],
        },
      ],
      [{ value: 546n }],
    );

    const routes = chainRoutes(coinbase, reveal, [commit]);
    // the funding tx behind the commit is served by nobody
    delete routes[`${E}/tx/${coinbase.tx.txid}/hex`];
    const base = stubFetch({ ...routes, [`${E}/tx/${reveal.tx.txid}/hex`]: poisoned.hex });
    const honest = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) =>
      url.startsWith(EB) ? honest(url.replace(EB, E), init) : base(url, init);

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/unbound at reveal/);
    expect(e.message).toMatch(/1 of 2 configured backends/);
    expect(e.message).toMatch(new RegExp(`ended this way: ${E}`));
    // EB answered, and what it answered with is carried rather than dropped
    expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${EB}: `));
    expect(e.message).toMatch(/HTTP 404/);
    expect(e.message).not.toMatch(/could not be reached/);
  });

  it('counts the members a break skipped, and reports the refusal over them', async () => {
    // E refuses on domain grounds. The attempt led by EB reads an honest reveal
    // and walks into a transaction no member serves, which ends the build,
    // and EC is never led. The three groups account for all three members, so
    // the refusal is reported over them and says EC stood behind nothing.
    // Before this the two skipped members were dropped, the count did not add
    // up, and the caller got a build failure with no class at all
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const evenField = envelopeScript(
      { fields: [[1, 'text/plain'], [22, new Uint8Array([1])]], body: ['unbound'] },
      { checksigPrefix: true },
    );
    const poisoned = segwitTx(
      [
        {
          txid: commit.tx.txid,
          vout: 0,
          witness: [new Uint8Array(64).fill(7), evenField, taprootCommit(evenField).controlBlock],
        },
      ],
      [{ value: 546n }],
    );

    const routes = chainRoutes(coinbase, reveal, [commit]);
    // the coinbase behind the commit is served by nobody
    delete routes[`${E}/tx/${coinbase.tx.txid}/hex`];
    const base = stubFetch({ ...routes, [`${E}/tx/${reveal.tx.txid}/hex`]: poisoned.hex });
    const honest = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) =>
      url.startsWith(EB) || url.startsWith(EC)
        ? honest(url.replace(EB, E).replace(EC, E), init)
        : base(url, init);

    const attempts: AttemptInfo[] = [];
    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB, EC],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e).not.toBeInstanceOf(SatIdentityError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/1 of 3 configured backends/);
    expect(e.message).toMatch(new RegExp(`ended this way: ${E}`));
    expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${EB}: `));
    expect(e.message).toMatch(new RegExp(`1 never led an attempt: ${EC}`));
    // and the loop really did stop before EC, which is why it is named apart
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, EB]);
  });

  it('refuses unanimity over a refusal one member alone decided with its reveal bytes', async () => {
    // the seventh review's case: EB is unreachable and E serves a doctored
    // reveal whose envelope is unbound. The reveal's deciding requests come
    // from the lead alone, so the attempt EB leads ends as EB's own transport
    // failure instead of recording E's refusal under EB's name through pool
    // fallover. One refusal, one no-answer, and the refusal is one server's
    // word. Before the fix both attempts recorded the refusal E's bytes
    // decided and the build called it unanimous, which the CLI reported at
    // OUT OF SCOPE, exit 4
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const evenField = envelopeScript(
      { fields: [[1, 'text/plain'], [22, new Uint8Array([1])]], body: ['unbound'] },
      { checksigPrefix: true },
    );
    const poisoned = segwitTx(
      [
        {
          txid: commit.tx.txid,
          vout: 0,
          witness: [new Uint8Array(64).fill(7), evenField, taprootCommit(evenField).controlBlock],
        },
      ],
      [{ value: 546n }],
    );
    expect(poisoned.tx.txid).toBe(reveal.tx.txid);

    const routes = chainRoutes(coinbase, reveal, [commit]);
    // EB has no routes at all, so every EB request fails in transport
    const fetchFn = stubFetch({ ...routes, [`${E}/tx/${reveal.tx.txid}/hex`]: poisoned.hex });

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [EB, E], fetchFn });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/unbound at reveal/);
    expect(e.message).toMatch(new RegExp(`1 of 2 configured backends led an attempt that ended this way: ${E}`));
    // EB's entry carries its own transport cause, from the deciding request
    expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${EB}: `));
    expect(e.message).toMatch(/failed at the leading backend/);
    expect(e.message).toMatch(/HTTP 404/);
    expect(e.message).not.toMatch(/each configured backend led an attempt/);
  });

  it('still builds from the second member when the first lead is unreachable', async () => {
    // the availability half of the same fix: EB unreachable and E honest used
    // to succeed through pool fallover inside EB's attempt, and now succeeds
    // on the attempt E leads after EB's failure is recorded as its own
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);

    const attempts: AttemptInfo[] = [];
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [EB, E],
      fetchFn: stubFetch(routes),
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT));
    expect(attempts.map((a) => a.baseUrl)).toEqual([EB, E]);
    expect(attempts[1].cause).toBeInstanceOf(RevealSourceError);
    expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).sat).toBe(res.identity.sat);
  });

  it('keeps unanimity when each member served the refused reveal bytes itself', async () => {
    // two members each serving the refused bytes themselves is what unanimity
    // means, and the fix leaves it standing
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const evenField = envelopeScript(
      { fields: [[1, 'text/plain'], [22, new Uint8Array([1])]], body: ['unbound'] },
      { checksigPrefix: true },
    );
    const poisoned = segwitTx(
      [
        {
          txid: commit.tx.txid,
          vout: 0,
          witness: [new Uint8Array(64).fill(7), evenField, taprootCommit(evenField).controlBlock],
        },
      ],
      [{ value: 546n }],
    );
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const base = stubFetch({ ...routes, [`${E}/tx/${reveal.tx.txid}/hex`]: poisoned.hex });
    // EB mirrors E, doctored reveal included
    const fetchFn: FetchFn = (url, init) => base(url.replace(EB, E), init);

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e.unanimous).toBe(true);
    expect(e.message).toMatch(/each configured backend led an attempt that ended this way/);
  });

  it('reports a build failure when no lead can serve the reveal at all', async () => {
    // both members unreachable: each lead's deciding request fails as its own,
    // no refusal is ever recorded, and the build is INCOMPLETE with both
    // members named beside their transport cause
    const p = fetchSatIdentity(`${'ab'.repeat(32)}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn: stubFetch({}),
    });
    const e = (await p.catch((x: unknown) => x)) as SatIdentityError;
    expect(e).toBeInstanceOf(SatIdentityError);
    expect(e.code).toBe('BUILD_FAILED');
    expect(e.message).toMatch(new RegExp(`${E}: .*failed at the leading backend`));
    expect(e.message).toMatch(new RegExp(`${EB}: .*failed at the leading backend`));
  });

  it('still ends the build through the break when a pooled request exhausts the pool', async () => {
    // both leads serve the reveal hop and its prev-tx coverage; the funding
    // tx one step past the reveal hop is served by nobody, so a pooled
    // mid-walk request outside the lead-derived span fails at every member
    // and the break ends the build with the second member never led
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const f1 = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 400_000_000n }]);
    const commit = buildTx([{ txid: f1.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit, f1]);
    delete routes[`${E}/tx/${f1.tx.txid}/hex`];
    const base = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) => base(url.replace(EB, E), init);

    const attempts: AttemptInfo[] = [];
    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    const e = (await p.catch((x: unknown) => x)) as SatIdentityError;
    expect(e).toBeInstanceOf(SatIdentityError);
    expect(e.code).toBe('BUILD_FAILED');
    expect(e.message).toMatch(/all 2 pooled backend\(s\) failed/);
    // the break fired at attempt 0 and EB was never led
    expect(attempts.map((a) => a.baseUrl)).toEqual([E]);
  });

  it('rotates when the lead answers that the reveal is unconfirmed', async () => {
    // the first of the three lead-derived value failures: the status request
    // succeeded and the VALUE the lead served says unconfirmed. That is one
    // member's answer, so the lead lands in noAnswer with its cause and the
    // next member leads. Before the phase rule it was a plain build error
    // that hit the pool-exhaustion break with EB never led
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    routes[`${E}/tx/${reveal.tx.txid}/outspend/0`] = { spent: false };
    const honest = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) => {
      if (url === `${E}/tx/${reveal.tx.txid}/status`) {
        return Promise.resolve(
          new Response(JSON.stringify({ confirmed: false }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return honest(url.replace(EB, E), init);
    };

    const attempts: AttemptInfo[] = [];
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT));
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, EB]);
    expect(attempts[1].cause).toBeInstanceOf(RevealSourceError);
    expect((attempts[1].cause as Error).message).toMatch(/is not confirmed/);

    // the custody loop rotates on the identical condition, so the two
    // commands agree about the same inscription
    const custody = await fetchCustody(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
    });
    expect(custody.custody.satpoint.txid).toBe(reveal.tx.txid);
  });

  it('rotates when the lead serves a matching-txid reveal without the envelope', async () => {
    // the second value failure: the witness is outside the stripped txid, so
    // the lead can serve bytes that pass the id check and carry no envelope
    // at the requested index. That is the lead's word about uncommitted
    // bytes, so the lead lands in noAnswer and the next member leads
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const stripped = segwitTx(
      [{ txid: commit.tx.txid, vout: 0, witness: [new Uint8Array(64).fill(7)] }],
      [{ value: 546n }],
    );
    expect(stripped.tx.txid).toBe(reveal.tx.txid);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    routes[`${E}/tx/${reveal.tx.txid}/outspend/0`] = { spent: false };
    const honest = stubFetch(routes);
    const base = stubFetch({ ...routes, [`${E}/tx/${reveal.tx.txid}/hex`]: stripped.hex });
    const fetchFn: FetchFn = (url, init) =>
      url.startsWith(EB) ? honest(url.replace(EB, E), init) : base(url, init);

    const attempts: AttemptInfo[] = [];
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT));
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, EB]);
    expect(attempts[1].cause).toBeInstanceOf(RevealSourceError);
    expect((attempts[1].cause as Error).message).toMatch(/has no envelope with index/);

    const custody = await fetchCustody(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
    });
    expect(custody.custody.satpoint.txid).toBe(reveal.tx.txid);
  });

  it('records a reveal naming a missing prev output as each lead\'s own failure', async () => {
    // the third value failure: the reveal, served consistently by every
    // member for its own txid, names a prev-tx output that does not exist in
    // the hash-checked prev bytes. Each lead's attempt fails on data that
    // lead served, so both land in noAnswer and the build is INCOMPLETE with
    // both causes named, instead of the break ending it with EB never led.
    // The custody wrapper reports the same code, so the two commands agree
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    // input names commit:3, which commit does not have
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 3, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const base = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) => base(url.replace(EB, E), init);

    const attempts: AttemptInfo[] = [];
    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    const e = (await p.catch((x: unknown) => x)) as SatIdentityError;
    expect(e).toBeInstanceOf(SatIdentityError);
    expect(e.code).toBe('BUILD_FAILED');
    expect(e.message).toMatch(/has no output 3/);
    expect(e.message).toMatch(new RegExp(`${E}: .*failed at the leading backend`));
    expect(e.message).toMatch(new RegExp(`${EB}: .*failed at the leading backend`));
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, EB]);

    const pc = fetchCustody(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
    const ec = (await pc.catch((x: unknown) => x)) as { code?: string };
    expect(ec.code).toBe('BUILD_FAILED');
  });

  it('refuses unanimity over a coinbase height one member alone served', async () => {
    // the seventh review's priority 2 on the one deciding request its fix did
    // not reach: the terminal coinbase's status names the height coinbaseSatAt
    // reads, which decides the subsidy boundary and with it the fee-tail
    // refusal. E fails exactly that request; EB answers it with a height deep
    // enough past the true one (900,000, one more halving) to flip the traced
    // position into the fee tail. Before the fix the pool fell over to EB
    // inside E's attempt, the doctored answer decided it, the refusal was
    // recorded under E's name, and the build called it unanimous at exit 4.
    // After the fix the request is lead-only: E lands in noAnswer with its own
    // transport cause, EB's attempt decides on its own answers, and the
    // refusal is one server's word
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const commit = buildTx(
      [{ txid: coinbase.tx.txid, vout: 0 }],
      [{ value: 400_000_000n }, { value: 10_000n, spk: TAP.scriptPubKey }],
    );
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 1, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const honest = stubFetch(routes);
    const st = routes[`${E}/tx/${coinbase.tx.txid}/status`] as { block_hash: string };
    const doctored = { confirmed: true, block_height: 900_000, block_hash: st.block_hash };
    // the hop is folded against itself at build time now, so a height only the
    // status carries is caught as that member contradicting itself. The
    // doctored height therefore reaches the merkle proof too, which is the
    // pooled request every member here answers the same way. What the test is
    // about is unchanged: one member's own answer decides the subsidy boundary
    // inside the attempt that member leads
    (routes[`${E}/tx/${coinbase.tx.txid}/merkle-proof`] as { block_height: number }).block_height =
      900_000;
    const fetchFn: FetchFn = (url, init) => {
      if (url === `${E}/tx/${coinbase.tx.txid}/status`) {
        return Promise.resolve(new Response('no coinbase status', { status: 404 }));
      }
      if (url === `${EB}/tx/${coinbase.tx.txid}/status`) {
        return Promise.resolve(
          new Response(JSON.stringify(doctored), { headers: { 'content-type': 'application/json' } }),
        );
      }
      return honest(url.replace(EB, E), init);
    };

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/fee sats in block 900000/);
    expect(e.message).toMatch(
      new RegExp(`1 of 2 configured backends led an attempt that ended this way: ${EB}`),
    );
    expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${E}: `));
    expect(e.message).toMatch(/coinbase status .* failed at the leading backend/);
    expect(e.message).not.toMatch(/each configured backend led an attempt/);
  });

  it('keeps unanimity when each member served the fee-tail coinbase status itself', async () => {
    // a genuinely fee-tail ancestry with both members honest: each attempt's
    // refusal now rests on the coinbase status its own lead served, so the
    // refusal stays unanimous and the CLI's OUT OF SCOPE reading stands
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 500_000_000n }]);
    const commit = buildTx(
      [{ txid: coinbase.tx.txid, vout: 0 }],
      [{ value: 700_000_000n }, { value: 10_000n, spk: TAP.scriptPubKey }],
    );
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 1, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const honest = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) => honest(url.replace(EB, E), init);

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e.unanimous).toBe(true);
    expect(e.message).toMatch(/fee sats in block 700000/);
    expect(e.message).toMatch(/each configured backend led an attempt that ended this way/);
  });

  it('still builds from the second member when the lead fails the coinbase status alone', async () => {
    // the availability half: a lead that cannot answer its own coinbase-status
    // request is one member's failure, recorded as that, and the next attempt
    // completes the build from its own lead's answers
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const commit = buildTx(
      [{ txid: coinbase.tx.txid, vout: 0 }],
      [{ value: 400_000_000n }, { value: 10_000n, spk: TAP.scriptPubKey }],
    );
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 1, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const honest = stubFetch(routes);
    const fetchFn: FetchFn = (url, init) => {
      if (url === `${E}/tx/${coinbase.tx.txid}/status`) {
        return Promise.resolve(new Response('no coinbase status', { status: 404 }));
      }
      return honest(url.replace(EB, E), init);
    };

    const attempts: AttemptInfo[] = [];
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [E, EB],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT) + 400_000_000n);
    expect(attempts.map((a) => a.baseUrl)).toEqual([E, EB]);
    expect(attempts[1].cause).toBeInstanceOf(RevealSourceError);
    expect((attempts[1].cause as Error).message).toMatch(/coinbase status/);
    expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).sat).toBe(res.identity.sat);
  });

  it('sums the groups over three members when a served height decided two attempts', async () => {
    // three configured members: E fails its own coinbase-status request, EB
    // and EC each serve the doctored height themselves. Two refusals and one
    // no-answer account for all three, so the refusal is reported over them
    // and stays short of unanimity
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
    const commit = buildTx(
      [{ txid: coinbase.tx.txid, vout: 0 }],
      [{ value: 400_000_000n }, { value: 10_000n, spk: TAP.scriptPubKey }],
    );
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 1, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);
    const honest = stubFetch(routes);
    const st = routes[`${E}/tx/${coinbase.tx.txid}/status`] as { block_hash: string };
    const doctored = { confirmed: true, block_height: 900_000, block_hash: st.block_hash };
    // the hop is folded against itself at build time now, so a height only the
    // status carries is caught as that member contradicting itself. The
    // doctored height therefore reaches the merkle proof too, which is the
    // pooled request every member here answers the same way. What the test is
    // about is unchanged: one member's own answer decides the subsidy boundary
    // inside the attempt that member leads
    (routes[`${E}/tx/${coinbase.tx.txid}/merkle-proof`] as { block_height: number }).block_height =
      900_000;
    const fetchFn: FetchFn = (url, init) => {
      if (url === `${E}/tx/${coinbase.tx.txid}/status`) {
        return Promise.resolve(new Response('no coinbase status', { status: 404 }));
      }
      if (
        url === `${EB}/tx/${coinbase.tx.txid}/status` ||
        url === `${EC}/tx/${coinbase.tx.txid}/status`
      ) {
        return Promise.resolve(
          new Response(JSON.stringify(doctored), { headers: { 'content-type': 'application/json' } }),
        );
      }
      return honest(url.replace(EB, E).replace(EC, E), init);
    };

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB, EC], fetchFn });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(CustodyUnsupportedError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/fee sats in block 900000/);
    expect(e.message).toMatch(
      new RegExp(`2 of 3 configured backends led an attempt that ended this way: ${EB}, ${EC}`),
    );
    expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${E}: `));
    expect(e.message).not.toMatch(/never led an attempt/);
  });

  it('answers the header marker per header, and throws on one it never anchored', async () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const routes = chainRoutes(coinbase, reveal, [commit]);

    // the hook the wrapper hands the verifier reports each anchored hop's own
    // verdict, so the reveal hop's call cannot answer with the coinbase's
    const asked: { hash: string; height: number }[] = [];
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      fetchFn: stubFetch(routes),
      trustHeader: async (header, height) => {
        asked.push({ hash: header.hash, height });
        return {
          checkpointHit: false,
          sourcesQueried: 2,
          sourcesAgreed: 2,
          independentSources: 2,
          builderIsSource: false,
          anchored: true,
          // only the coinbase anchor attests hash-at-height here
          attests: height === CB_HEIGHT ? ('hash-at-height' as const) : undefined,
        };
      },
    });
    expect(asked.map((a) => a.height)).toEqual([REVEAL_HEIGHT, CB_HEIGHT]);
    expect(res.headerTrust.reveal.attests).toBeUndefined();
    expect(res.headerTrust.coinbase.attests).toBe('hash-at-height');

    // the marker itself: each hop's own verdict, and a refusal to answer for
    // a header this build never anchored
    const revealHeader = parseHeader(hexToBytes(res.bundle.reveal.block.header));
    const coinbaseHeader = parseHeader(hexToBytes(res.bundle.coinbase.block.header));
    const marker = perHeaderAttestation([
      {
        hash: res.bundle.reveal.block.hash,
        height: res.bundle.reveal.block.height,
        report: res.headerTrust.reveal,
      },
      {
        hash: res.bundle.coinbase.block.hash,
        height: res.bundle.coinbase.block.height,
        report: res.headerTrust.coinbase,
      },
    ]);
    expect(marker(revealHeader, REVEAL_HEIGHT)).toBeUndefined();
    expect(marker(coinbaseHeader, CB_HEIGHT)).toBe('hash-at-height');
    const foreign = parseHeader(hexToBytes(mineBlock([commit.tx]).headerHex));
    expect(() => marker(foreign, 1)).toThrow(/anchored neither endpoint for/);
    // the value means hash AT HEIGHT, so the anchored hash at another height is
    // a pair nobody attested to and the hook refuses it
    expect(() => marker(coinbaseHeader, CB_HEIGHT + 1)).toThrow(
      /anchored neither endpoint for at that height/,
    );
  });

  /**
   * A hop's four answers are folded against each other before the walk goes on,
   * so a member whose status, merkle proof and header do not describe one block
   * costs one attempt rather than the whole walk and a bundle the verifier
   * refuses. Both hops this builder assembles sit inside the lead-derived span,
   * so what the loop records is `RevealSourceError` carrying the hop's cause.
   */
  describe('when one member answers inconsistently', () => {
    const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 50_000n }]);
    const commit = buildTx(
      [{ txid: coinbase.tx.txid, vout: 0 }],
      [{ value: 10_000n, spk: TAP.scriptPubKey }],
    );
    const reveal = segwitTx([{ txid: commit.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);

    /** E leads first and answers inconsistently; EB answers one block */
    function doctoredAt(base: string, doctor: (r: Record<string, Route>) => object): FetchFn {
      const routes = chainRoutes(coinbase, reveal, [commit]);
      const doctored = doctor(routes);
      const honest = stubFetch(routes);
      const url = `${base}/tx/${reveal.tx.txid}/${
        'pos' in doctored ? 'merkle-proof' : 'status'
      }`;
      return (u, init) => {
        if (u === url) {
          return Promise.resolve(
            new Response(JSON.stringify(doctored), {
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return honest(u.replace(EB, E), init);
      };
    }

    const cases: [string, (r: Record<string, Route>) => object][] = [
      [
        'a merkle proof at a wrong position',
        (r) => ({ ...(r[`${E}/tx/${reveal.tx.txid}/merkle-proof`] as object), pos: 0 }),
      ],
      [
        'a merkle proof whose height contradicts the status',
        (r) => ({
          ...(r[`${E}/tx/${reveal.tx.txid}/merkle-proof`] as object),
          block_height: REVEAL_HEIGHT + 1,
        }),
      ],
    ];

    for (const [what, doctor] of cases) {
      it(`leads the next member past ${what}`, async () => {
        const attempts: AttemptInfo[] = [];
        const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
          ...OPTS,
          esplora: [E, EB],
          fetchFn: doctoredAt(E, doctor),
          onAttempt: (info) => attempts.push(info),
        });
        expect(res.identity.sat).toBe(firstSatOfBlock(CB_HEIGHT));
        expect(attempts.map((a) => a.baseUrl)).toEqual([E, EB]);
        expect(attempts[1].cause).toBeInstanceOf(RevealSourceError);
        expect(attempts[1].cause?.message).toMatch(new RegExp(`failed at the leading backend ${E}`));
        // and the bundle the honest member built stands on its own
        expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).sat).toBe(res.identity.sat);
      });
    }

    it('ends at the build-failure path when every member answers inconsistently', async () => {
      // nothing was refused and nothing was verified, so the report is the
      // build failure with each member's contradiction named. Exit 1 on a
      // bundle that failed verification is what this replaced
      const routes = chainRoutes(coinbase, reveal, [commit]);
      const honest = stubFetch(routes);
      const doctored = { ...(routes[`${E}/tx/${reveal.tx.txid}/merkle-proof`] as object), pos: 0 };
      const fetchFn: FetchFn = (u, init) => {
        if (u.endsWith(`/tx/${reveal.tx.txid}/merkle-proof`)) {
          return Promise.resolve(
            new Response(JSON.stringify(doctored), {
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return honest(u.replace(EB, E), init);
      };

      const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
      const e = (await p.catch((x: unknown) => x)) as SatIdentityError & { unanimous?: boolean };
      expect(e).toBeInstanceOf(SatIdentityError);
      expect(e.code).toBe('BUILD_FAILED');
      // no refusal was recorded, so nothing claims to be the chain's answer
      expect(e.unanimous).toBeUndefined();
      for (const base of [E, EB]) {
        expect(e.message).toMatch(new RegExp(`${base}: .*failed at the leading backend ${base}`));
      }
      expect(e.message).toMatch(/folds to a root the header of block .* does not carry/);
    });

    it('records the inconsistency as no usable answer beside a real refusal', async () => {
      // the three groups still account for every configured member: EB leads
      // an attempt that refuses on the chain's own shape, E leads one that
      // produced nothing. A backend contradicting itself stands behind no
      // refusal, so it can never carry one to unanimity
      // the same fee-tail ancestry the class's own test uses: the coinbase
      // pays subsidy plus fee sats and the traced sat is the first fee sat
      const feeCoinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY + 100_000n }]);
      const f1 = buildTx(
        [{ txid: feeCoinbase.tx.txid, vout: 0 }],
        [{ value: SUBSIDY }, { value: 90_000n }],
      );
      const feeCommit = buildTx(
        [{ txid: f1.tx.txid, vout: 1 }],
        [{ value: 10_000n, spk: TAP.scriptPubKey }],
      );
      const feeReveal = segwitTx(
        [{ txid: feeCommit.tx.txid, vout: 0, witness: WITNESS }],
        [{ value: 546n }],
      );
      const routes = chainRoutes(feeCoinbase, feeReveal, [feeCommit, f1]);
      const honest = stubFetch(routes);
      const doctored = {
        ...(routes[`${E}/tx/${feeReveal.tx.txid}/merkle-proof`] as object),
        pos: 0,
      };
      const fetchFn: FetchFn = (u, init) => {
        if (u === `${E}/tx/${feeReveal.tx.txid}/merkle-proof`) {
          return Promise.resolve(
            new Response(JSON.stringify(doctored), {
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return honest(u.replace(EB, E), init);
      };

      const p = fetchSatIdentity(`${feeReveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
      const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
      expect(e).toBeInstanceOf(CustodyUnsupportedError);
      expect(e.unanimous).toBe(false);
      expect(e.message).toMatch(
        new RegExp(`1 of 2 configured backends led an attempt that ended this way: ${EB}`),
      );
      expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${E}: `));
      expect(e.message).not.toMatch(/never led an attempt/);
    });
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

describe('fetchSatIdentity with multi-input reveals', () => {
  // key-path funding leg on input 0, the envelope on input 1: an ordinary
  // wallet-funded reveal, and the shape the wtxid proof exists for
  const coinbase = coinbaseTx(CB_HEIGHT, [{ value: SUBSIDY }]);
  const commit = buildTx(
    [{ txid: coinbase.tx.txid, vout: 0 }],
    [
      { value: 10_000n },
      { value: 20_000n, spk: TAP.scriptPubKey },
    ],
  );
  const reveal = segwitTx(
    [
      { txid: commit.tx.txid, vout: 0, witness: [new Uint8Array(64).fill(7)] },
      { txid: commit.tx.txid, vout: 1, witness: WITNESS },
    ],
    [{ value: 25_000n }],
  );
  // the reveal block needs a real witness commitment for the wtxid proof
  const revealBlock = buildBlock([reveal.tx]);
  const cbBlock = mineBlock([coinbase.tx]);

  function routes(withRawBlock: boolean): Record<string, Route> {
    const r: Record<string, Route> = {
      ...routesFor(cbBlock, CB_HEIGHT, TIP),
      ...routesFor(revealBlock, REVEAL_HEIGHT, TIP),
      [`${E}/tx/${commit.tx.txid}/hex`]: commit.hex,
    };
    if (withRawBlock) {
      r[`${E}/block/${revealBlock.blockHash}/raw`] = serializeBlock(
        hexToBytes(revealBlock.headerHex),
        revealBlock.txs,
      );
    }
    return r;
  }

  const SAT = firstSatOfBlock(CB_HEIGHT) + 10_000n;

  it('builds the reveal wtxid proof and verifies through it', async () => {
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      fetchFn: stubFetch(routes(true)),
    });
    expect(res.identity.indexProof).toBe('wtxid');
    expect(res.identity.singleInputReveal).toBe(false);
    expect(res.identity.sat).toBe(SAT);
    expect(res.bundle.reveal.witness).toBeDefined();
    // the bundle stands alone offline
    const again = verifySatGenealogy(JSON.parse(JSON.stringify(res.bundle)), NO_POW_FLOOR);
    expect(again.indexProof).toBe('wtxid');
    expect(again.sat).toBe(SAT);
  });

  it('walks again on the next lead member when one names a wrong block for the reveal', async () => {
    // a member's own status names a real but WRONG block for the reveal. The
    // block it named is not the block its own merkle proof folds into, so the
    // reveal hop is caught as that member's answers disagreeing with each
    // other. The status is a deciding request and comes from the lead alone,
    // so EB's decoy status ends exactly the attempt EB leads and no other, and
    // the build leads again with a member that answers one block. The reveal
    // hop sits inside the lead-derived span, so what the loop records is the
    // span's RevealSourceError carrying the hop's own cause.
    const decoy = mineBlock([coinbaseTx(REVEAL_HEIGHT, [{ value: SUBSIDY + 1n }]).tx]);
    const r = routes(true);
    r[`${E}/block/${decoy.blockHash}/header`] = decoy.headerHex;
    r[`${E}/block/${decoy.blockHash}`] = {
      id: decoy.blockHash,
      height: REVEAL_HEIGHT,
      tx_count: decoy.txCount,
    };
    r[`${E}/block/${decoy.blockHash}/raw`] = serializeBlock(hexToBytes(decoy.headerHex), decoy.txs);
    const base = stubFetch(r);
    const fetchFn: FetchFn = (url, init) => {
      // EB mirrors E, except that it points the reveal at the decoy block
      if (url === `${EB}/tx/${reveal.tx.txid}/status`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              confirmed: true,
              block_height: REVEAL_HEIGHT,
              block_hash: decoy.blockHash,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return base(url.replace(EB, E), init);
    };

    const attempts: AttemptInfo[] = [];
    const res = await fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      esplora: [EB, E],
      fetchFn,
      onAttempt: (info) => attempts.push(info),
    });
    expect(res.identity.indexProof).toBe('wtxid');
    expect(res.identity.sat).toBe(SAT);
    expect(res.bundle.reveal.block.hash).toBe(revealBlock.blockHash);
    // one report per attempt, and the second says what ended the first
    expect(attempts.map((a) => a.baseUrl)).toEqual([EB, E]);
    expect(attempts[0].cause).toBeUndefined();
    expect(attempts[1].cause).toBeInstanceOf(RevealSourceError);
    // the span names the member that led, and the hop names which two of its
    // answers disagreed
    expect(attempts[1].cause?.message).toMatch(new RegExp(`failed at the leading backend ${EB}`));
    expect(attempts[1].cause?.message).toMatch(/merkle proof for .* does not fold/);
    expect(attempts[1].total).toBe(2);
  });

  it('keeps the witness-section class when the next lead member could not be reached', async () => {
    // no member serves the raw block, so the attempt E leads ends in the
    // availability refusal, which is E's own word about a block hash and a
    // position E itself named. The attempt EB leads fails a deciding request
    // and produces no usable answer at all. The refusal is the informative
    // half of that pair, and the accounting names both halves
    const r = routes(false);
    const base = stubFetch(r);
    const fetchFn: FetchFn = (url, init) => {
      if (url === `${EB}/tx/${reveal.tx.txid}/status`) {
        return Promise.resolve(new Response('no status here', { status: 503 }));
      }
      return base(url.replace(EB, E), init);
    };

    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, { ...OPTS, esplora: [E, EB], fetchFn });
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e).toBeInstanceOf(WitnessSectionUnavailableError);
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(/1 of 2 configured backends/);
    expect(e.message).toMatch(new RegExp(`ended this way: ${E}`));
    expect(e.message).toMatch(new RegExp(`1 produced no usable answer: ${EB}: `));
    expect(e.message).not.toMatch(/could not be reached/);
  });

  it('passes WitnessSectionUnavailableError through, naming the backend cause', async () => {
    // no raw-block route: the builder emits no unverifiable bundle, and the
    // failure reaches the caller as itself the way CustodyUnsupportedError
    // does. It is availability, so callers can tell "retry later" from the
    // verifier's "this reveal can never be proven"
    const p = fetchSatIdentity(`${reveal.tx.txid}i0`, {
      ...OPTS,
      fetchFn: stubFetch(routes(false)),
    });
    await expect(p).rejects.toThrow(WitnessSectionUnavailableError);
    await expect(p).rejects.not.toThrow(EnvelopeIndexUnprovenError);
    await expect(p).rejects.toThrow(/spends 2 input/);
    // the real cause is a backend failure, not an unprovable reveal, and the
    // message says so rather than blaming the reveal
    await expect(p).rejects.toThrow(/HTTP 404/);
    await expect(p).rejects.toThrow(new RegExp(E));
    // one configured backend reached it, which is one server's word
    const e = (await p.catch((x: unknown) => x)) as Error & { unanimous?: boolean };
    expect(e.unanimous).toBe(false);
    expect(e.message).toMatch(new RegExp(`the single configured backend reported it: ${E}`));
    expect(e.message).not.toMatch(/each configured backend led an attempt/);
  });

  it('emits no witness section for a single-input reveal even with the block available', async () => {
    const commit1 = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal1 = segwitTx([{ txid: commit1.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const block1 = buildBlock([reveal1.tx]);
    const r: Record<string, Route> = {
      ...routesFor(cbBlock, CB_HEIGHT, TIP),
      ...routesFor(block1, REVEAL_HEIGHT, TIP),
      [`${E}/tx/${commit1.tx.txid}/hex`]: commit1.hex,
      [`${E}/block/${block1.blockHash}/raw`]: serializeBlock(hexToBytes(block1.headerHex), block1.txs),
    };
    const res = await fetchSatIdentity(`${reveal1.tx.txid}i0`, { ...OPTS, fetchFn: stubFetch(r) });
    expect(res.identity.indexProof).toBe('single-input');
    expect('witness' in res.bundle.reveal).toBe(false);
  });

  it('witnessSection always attaches a section to a single-input reveal', async () => {
    const commit1 = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal1 = segwitTx([{ txid: commit1.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const block1 = buildBlock([reveal1.tx]);
    const r: Record<string, Route> = {
      ...routesFor(cbBlock, CB_HEIGHT, TIP),
      ...routesFor(block1, REVEAL_HEIGHT, TIP),
      [`${E}/tx/${commit1.tx.txid}/hex`]: commit1.hex,
      [`${E}/block/${block1.blockHash}/raw`]: serializeBlock(hexToBytes(block1.headerHex), block1.txs),
    };
    const id = `${reveal1.tx.txid}i0`;
    const res = await fetchSatIdentity(id, {
      ...OPTS,
      fetchFn: stubFetch(r),
      witnessSection: 'always',
    });
    expect(res.identity.indexProof).toBe('wtxid');
    expect(res.identity.singleInputReveal).toBe(true);
    expect(res.bundle.reveal.witness).toBeDefined();
    expect(verifySatGenealogy(res.bundle, NO_POW_FLOOR).indexProof).toBe('wtxid');

    // when-needed emits the same bytes the default does
    const backend = new EsploraBackend(E, stubFetch(r));
    const needed = await buildSatGenealogyBundle(id, backend, { witnessSection: 'when-needed' });
    const dflt = await buildSatGenealogyBundle(id, backend);
    expect(JSON.stringify(needed.bundle)).toBe(JSON.stringify(dflt.bundle));
    expect('witness' in needed.bundle.reveal).toBe(false);
  });

  it('witnessSection always with every backend failing throws with each cause', async () => {
    const commit1 = buildTx([{ txid: coinbase.tx.txid, vout: 0 }], [{ value: 10_000n, spk: TAP.scriptPubKey }]);
    const reveal1 = segwitTx([{ txid: commit1.tx.txid, vout: 0, witness: WITNESS }], [{ value: 546n }]);
    const block1 = buildBlock([reveal1.tx]);
    // no raw-block route: the one request the section needs is the one missing
    const r: Record<string, Route> = {
      ...routesFor(cbBlock, CB_HEIGHT, TIP),
      ...routesFor(block1, REVEAL_HEIGHT, TIP),
      [`${E}/tx/${commit1.tx.txid}/hex`]: commit1.hex,
    };
    const p = fetchSatIdentity(`${reveal1.tx.txid}i0`, {
      ...OPTS,
      esplora: [E],
      fetchFn: stubFetch(r),
      witnessSection: 'always',
    });
    await expect(p).rejects.toThrow(WitnessSectionUnavailableError);
    await expect(p).rejects.not.toThrow(EnvelopeIndexUnprovenError);
    await expect(p).rejects.toThrow(/HTTP 404/);
    await expect(p).rejects.toThrow(new RegExp(E));
    await expect(p).rejects.toThrow(/always/);
  });
});
