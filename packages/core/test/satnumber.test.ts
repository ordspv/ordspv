import { describe, it, expect } from 'vitest';
import {
  parseTx,
  subsidySats,
  firstSatOfBlock,
  satToHeight,
  satRarity,
  satName,
  outputSpacePosition,
  containingInput,
  coinbaseSatAt,
  bip34Height,
  verifySatGenealogy,
  verifyEnvelopeBinding,
  inscriptionsFromTx,
  serializeFull,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  CoinbaseHeightUnprovenError,
  SatPositionError,
  SatStepLimitError,
  TOTAL_SATS,
  LAST_SAT,
  type SatGenealogyBundleJson,
  type CustodyHopJson,
  type ParsedTx,
  bytesToHex,
  hexToBytes,
  sha256,
  sha256d,
  internalToDisplay,
} from '../src/index.js';
import {
  buildBlock,
  envelopeScript,
  revealTx,
  script,
  taprootCommit,
  NO_POW_FLOOR,
  type TestBlock,
} from './helpers.js';

/**
 * Verify options every synthetic genealogy fixture in this file needs. The
 * blocks are mined at regtest difficulty, which the default proof-of-work
 * floor refuses, and their terminal coinbases sit below the BIP34 boundary,
 * where the verifier requires the claimed height attested through the
 * caller's hook. The hook here stands in for a caller that checked the hash
 * at that height, which is what the marker asserts. Both refusals have tests
 * of their own below.
 */
const FIXTURE_OPTS = {
  ...NO_POW_FLOOR,
  trustHeader: (): 'hash-at-height' => 'hash-at-height',
};

// ---------------------------------------------------------------------------
// local raw-tx builders (values and scripts are all the arithmetic needs)
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

function buildTx(
  inputs: { txid: string; vout: number; scriptSig?: Uint8Array }[],
  outputs: OutSpec[],
): { hex: string; tx: ParsedTx } {
  const parts: Uint8Array[] = [u32le(2), varint(inputs.length)];
  for (const inp of inputs) {
    const sig = inp.scriptSig ?? new Uint8Array([0x51]);
    parts.push(
      hexToBytes(inp.txid).reverse(),
      u32le(inp.vout),
      varint(sig.length),
      sig,
      u32le(0xffffffff),
    );
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

function buildCoinbase(outputs: OutSpec[], scriptSig?: Uint8Array): { hex: string; tx: ParsedTx } {
  return buildTx([{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig }], outputs);
}

/** segwit tx with a witness stack per input, so a reveal can have several */
function buildSegwitTx(
  inputs: { txid: string; vout: number; witness?: Uint8Array[] }[],
  outputs: OutSpec[],
): { hex: string; tx: ParsedTx } {
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

/** easiest-PoW header over a single-tx block */
function mineSingleTxBlock(txidLE: Uint8Array): { headerHex: string; hash: string } {
  const bits = 0x207fffff;
  for (let nonce = 0; nonce < 200000; nonce++) {
    const header = cat(u32le(2), new Uint8Array(32), txidLE, u32le(1700000000), u32le(bits), u32le(nonce));
    const hashLE = sha256d(header);
    if (hashLE[31] === 0) return { headerHex: bytesToHex(header), hash: internalToDisplay(hashLE) };
  }
  throw new Error('failed to mine test header');
}

function anchoredHop(txidLE: Uint8Array, hex: string, height: number, prevTxs: string[]): CustodyHopJson {
  const mined = mineSingleTxBlock(txidLE);
  return {
    block: { height, hash: mined.hash, header: mined.headerHex, txCount: 1 },
    tx: { hex, pos: 0, txidBranch: [] },
    prevTxs,
  };
}

// ---------------------------------------------------------------------------
// closed forms
// ---------------------------------------------------------------------------

describe('ordinal closed forms', () => {
  it('subsidy halvings', () => {
    expect(subsidySats(0)).toBe(5_000_000_000n);
    expect(subsidySats(209_999)).toBe(5_000_000_000n);
    expect(subsidySats(210_000)).toBe(2_500_000_000n);
    expect(subsidySats(420_000)).toBe(1_250_000_000n);
    expect(subsidySats(6_929_999)).toBe(1n);
    expect(subsidySats(6_930_000)).toBe(0n);
  });

  it('total supply and block starts', () => {
    expect(TOTAL_SATS).toBe(2_099_999_997_690_000n);
    expect(firstSatOfBlock(0)).toBe(0n);
    expect(firstSatOfBlock(1)).toBe(5_000_000_000n);
    expect(firstSatOfBlock(210_000)).toBe(210_000n * 5_000_000_000n);
  });

  it('satToHeight inverts firstSatOfBlock', () => {
    for (const h of [0, 1, 2015, 2016, 209_999, 210_000, 500_000, 6_929_999]) {
      const first = firstSatOfBlock(h);
      expect(satToHeight(first)).toEqual({ height: h, offset: 0n });
      const mid = first + subsidySats(h) / 2n;
      if (subsidySats(h) > 1n) {
        expect(satToHeight(mid).height).toBe(h);
      }
    }
  });

  it('names match the canonical anchors', () => {
    expect(satName(LAST_SAT)).toBe('a');
    expect(satName(0n)).toBe('nvtdijuwxlp');
    // derived for inscription 0's sat; cross-checked live against ord
    expect(satName(1_252_201_400_444_387n)).toBe('ezcubunuovm');
  });

  it('rarity ladder', () => {
    expect(satRarity(0n)).toBe('mythic');
    expect(satRarity(1n)).toBe('common');
    expect(satRarity(firstSatOfBlock(1))).toBe('uncommon');
    expect(satRarity(firstSatOfBlock(2016))).toBe('rare');
    expect(satRarity(firstSatOfBlock(210_000))).toBe('epic');
    expect(satRarity(firstSatOfBlock(1_260_000))).toBe('legendary');
  });
});

// ---------------------------------------------------------------------------
// backward arithmetic
// ---------------------------------------------------------------------------

describe('backward hop arithmetic', () => {
  const fundA = buildTx([{ txid: '11'.repeat(32), vout: 0 }], [{ value: 1000n }]);
  const fundB = buildTx([{ txid: '11'.repeat(32), vout: 1 }], [{ value: 2000n }]);
  const spend = buildTx(
    [
      { txid: fundA.tx.txid, vout: 0 },
      { txid: fundB.tx.txid, vout: 0 },
    ],
    [{ value: 1500n }, { value: 1400n }],
  );

  it('output-space position is prefix-sum plus offset', () => {
    expect(outputSpacePosition(spend.tx, 0, 999n)).toBe(999n);
    expect(outputSpacePosition(spend.tx, 1, 200n)).toBe(1700n);
    expect(() => outputSpacePosition(spend.tx, 1, 1400n)).toThrow(/outside output/);
    // a position outside the sat space it was resolved against is its own
    // class: a builder reads the position out of an unbound witness and rotates
    // on it, and a verifier reads it out of a bundle whose witness is bound
    expect(() => outputSpacePosition(spend.tx, 1, 1400n)).toThrow(SatPositionError);
    expect(() => outputSpacePosition(spend.tx, 9, 0n)).toThrow(SatPositionError);
  });

  it('containing input mirrors the forward FIFO', () => {
    // forward: B offset 700 -> abs 1700; backward from abs 1700 must return B/700
    expect(containingInput(spend.tx, [1000n, 2000n], 1700n)).toEqual({
      input: 1,
      offsetInFunding: 700n,
    });
    expect(containingInput(spend.tx, [1000n, 2000n], 999n)).toEqual({
      input: 0,
      offsetInFunding: 999n,
    });
    expect(containingInput(spend.tx, [1000n, 2000n], 1000n)).toEqual({
      input: 1,
      offsetInFunding: 0n,
    });
  });

  it('asks for more prev txs rather than guessing', () => {
    expect(() => containingInput(spend.tx, [1000n], 1700n)).toThrow(/more are needed/);
    expect(() => containingInput(spend.tx, [1000n], 1700n)).toThrow(SatPositionError);
    // and a position past every input sat the transaction has is the same class
    expect(() => containingInput(spend.tx, [1000n, 2000n], 3000n)).toThrow(SatPositionError);
    expect(() => containingInput(spend.tx, [1000n, 2000n], 3000n)).toThrow(
      /beyond the transaction's total input sats/,
    );
  });

  it('coinbase terminal: subsidy positions number directly, fee tail refuses', () => {
    const cb = buildCoinbase([{ value: 5_000_000_000n + 150n }]); // full subsidy + 150 fee sats
    expect(coinbaseSatAt(cb.tx, 30n, 1000)).toBe(firstSatOfBlock(1000) + 30n);
    expect(() => coinbaseSatAt(cb.tx, 5_000_000_000n, 1000)).toThrow(CustodyUnsupportedError);
    expect(() => coinbaseSatAt(spend.tx, 0n, 1000)).toThrow(/not a coinbase/);
  });

  it('parses BIP34 heights', () => {
    const cb = buildCoinbase([{ value: 1n }], new Uint8Array([0x03, 0xe8, 0x84, 0x03]));
    expect(bip34Height(cb.tx)).toBe(230632);
    const junk = buildCoinbase([{ value: 1n }], new Uint8Array([0x51]));
    expect(bip34Height(junk.tx)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// genealogy bundles end to end
// ---------------------------------------------------------------------------

describe('verifySatGenealogy', () => {
  // chain: coinbase(h=1000) -> funding -> commit -> reveal
  const SUBSIDY = 5_000_000_000n;
  const coinbase = buildCoinbase([{ value: 3_000_000_000n }, { value: 2_000_000_000n }]);
  const funding = buildTx(
    [{ txid: coinbase.tx.txid, vout: 1 }],
    [{ value: 500_000_000n }, { value: 1_500_000_000n }],
  );
  const script = envelopeScript({ fields: [[1, 'text/plain']], body: ['sat'] }, { checksigPrefix: true });
  const tap = taprootCommit(script);
  const commit = buildTx([{ txid: funding.tx.txid, vout: 0 }], [{ value: 10_000n, spk: tap.scriptPubKey }]);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.tx.txidLE,
    vout: 0,
  });
  function bundle(): SatGenealogyBundleJson {
    return {
      version: 1,
      inscriptionId: `${reveal.txid}i0`,
      reveal: anchoredHop(reveal.txidLE, bytesToHex(reveal.raw), 2000, [commit.hex]),
      funding: [
        { tx: { hex: commit.hex }, prevTxs: [funding.hex] },
        { tx: { hex: funding.hex }, prevTxs: [coinbase.hex] },
      ],
      coinbase: anchoredHop(coinbase.tx.txidLE, coinbase.hex, 1000, []),
      // trace: reveal in0 -> commit:0 off0 -> pos0 -> funding:0 off0 -> pos0
      //        -> coinbase:1 off0 -> abs 30e8 -> sat = firstSat(1000) + 30e8
      claimedSat: (firstSatOfBlock(1000) + 3_000_000_000n).toString(),
    };
  }

  it('refuses a bundle deeper than the cap as a step limit, not as a forgery', () => {
    // the cap bounds work on an untrusted document, so hitting it says the
    // verifier declined to read this bundle and nothing about the bundle's
    // honesty. A genealogy built with a raised builder cap arrives here well
    // formed, and the caller raises the verifier's cap to read it
    const b = bundle();
    expect(() => verifySatGenealogy(b, { ...FIXTURE_OPTS, maxSteps: 1 })).toThrow(
      SatStepLimitError,
    );
    expect(() => verifySatGenealogy(b, { ...FIXTURE_OPTS, maxSteps: 1 })).toThrow(
      /genealogy has 2 steps, verifier cap is 1/,
    );
    // and the raised cap reads the same bytes through
    expect(verifySatGenealogy(b, { ...FIXTURE_OPTS, maxSteps: 2 }).sat).toBe(
      firstSatOfBlock(1000) + 3_000_000_000n,
    );
  });

  it('verifies a full synthetic genealogy to the coinbase', () => {
    const res = verifySatGenealogy(bundle(), FIXTURE_OPTS);
    expect(res.sat).toBe(firstSatOfBlock(1000) + 3_000_000_000n);
    expect(res.coinbaseHeight).toBe(1000);
    expect(res.depth).toBe(2);
    expect(res.rarity).toBe('common');
    expect(res.name).toBe(satName(res.sat));
    expect(res.revealPosition).toBe(0n);
    expect(TOTAL_SATS > res.sat).toBe(true);
  });

  it('refuses a header easier than the proof-of-work floor by default', () => {
    // the reveal hop is anchored and its branch folds; the floor objects to
    // the header's target alone
    const b = bundle();
    expect(() => verifySatGenealogy(b)).toThrow(/reveal: target \(bits 0x207fffff\)/);
    expect(() => verifySatGenealogy(b)).toThrow(/proof-of-work limit 0x1d00ffff/);
    expect(
      verifySatGenealogy(b, { ...FIXTURE_OPTS, powLimitBits: 0x207fffff }).coinbaseHeight,
    ).toBe(1000);
    expect(verifySatGenealogy(b, FIXTURE_OPTS).coinbaseHeight).toBe(1000);
  });

  it('rejects a wrong claimed sat', () => {
    const b = bundle();
    b.claimedSat = (firstSatOfBlock(1000) + 1n).toString();
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/folds to/);
  });

  it('rejects a broken hash chain', () => {
    const b = bundle();
    b.funding = [b.funding[1], b.funding[0]];
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/chain expects/);
  });

  it('rejects a coinbase claimed at nonzero position', () => {
    const b = bundle();
    b.coinbase.tx.pos = 1;
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/position 0/);
  });

  it('requires a BIP34 height for modern blocks', () => {
    const b = bundle();
    b.coinbase.block.height = 240_000;
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/BIP34/);
  });

  it('refuses a sub-BIP34 coinbase height with no trust hook to attest it', () => {
    // height 1000 carries no BIP34 push, so nothing in the bundle binds the
    // claim. Without a hook the server picks the sat, the name and the rarity
    const b = bundle();
    expect(() => verifySatGenealogy(b, NO_POW_FLOOR)).toThrow(CoinbaseHeightUnprovenError);
    expect(() => verifySatGenealogy(b, NO_POW_FLOOR)).toThrow(/coinbase claims height 1000/);
    expect(() => verifySatGenealogy(b, NO_POW_FLOOR)).toThrow(/230000/);
    expect(() => verifySatGenealogy(b, NO_POW_FLOOR)).toThrow(/trustHeader/);
    // it is a refusal of its own class, not a forgery and not out-of-domain
    let thrown: unknown;
    try {
      verifySatGenealogy(b, NO_POW_FLOOR);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).name).toBe('CoinbaseHeightUnprovenError');
    expect(thrown).not.toBeInstanceOf(CustodyUnsupportedError);
  });

  it('refuses a sub-BIP34 coinbase height when the hook attests nothing', () => {
    // the hole this closes: a hook that runs and returns quietly checked
    // nothing, and its mere presence must not unlock the height
    const seen: number[] = [];
    let thrown: unknown;
    try {
      verifySatGenealogy(bundle(), {
        ...NO_POW_FLOOR,
        trustHeader: (_header, height) => {
          seen.push(height);
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).name).toBe('CoinbaseHeightUnprovenError');
    expect((thrown as Error).message).toMatch(/hash-at-height/);
    // the hook still ran on every hop, coinbase included
    expect(seen).toContain(1000);
  });

  it('accepts the same bundle when the hook attests hash-at-height', () => {
    const seen: { height: number; hash: string }[] = [];
    const res = verifySatGenealogy(bundle(), {
      ...NO_POW_FLOOR,
      trustHeader: (header, height) => {
        seen.push({ height, hash: header.hash });
        return 'hash-at-height';
      },
    });
    expect(res.coinbaseHeight).toBe(1000);
    expect(res.sat).toBe(firstSatOfBlock(1000) + 3_000_000_000n);
    // the hook saw the coinbase header at the claimed height, which is what
    // the marker asserts it checked
    const b = bundle();
    expect(seen).toContainEqual({ height: 1000, hash: b.coinbase.block.hash });
  });

  it('is unchanged at or above the boundary by what the hook returns', () => {
    // above 230,000 the coinbase's own BIP34 push binds the height, so a
    // rejection-only hook is enough and the marker adds nothing. 240000 is
    // 0x03a980, pushed little-endian
    // the subsidy has halved by 240000, so the values stay inside it
    const cb34 = buildCoinbase(
      [{ value: 1_000_000_000n }, { value: 1_000_000_000n }],
      new Uint8Array([0x03, 0x80, 0xa9, 0x03]),
    );
    const f = buildTx(
      [{ txid: cb34.tx.txid, vout: 1 }],
      [{ value: 500_000_000n }, { value: 400_000_000n }],
    );
    const c = buildTx([{ txid: f.tx.txid, vout: 0 }], [{ value: 10_000n, spk: tap.scriptPubKey }]);
    const r = revealTx([{ script, controlBlock: tap.controlBlock }], {
      prevTxidLE: c.tx.txidLE,
      vout: 0,
    });
    const b: SatGenealogyBundleJson = {
      version: 1,
      inscriptionId: `${r.txid}i0`,
      reveal: anchoredHop(r.txidLE, bytesToHex(r.raw), 250_000, [c.hex]),
      funding: [
        { tx: { hex: c.hex }, prevTxs: [f.hex] },
        { tx: { hex: f.hex }, prevTxs: [cb34.hex] },
      ],
      coinbase: anchoredHop(cb34.tx.txidLE, cb34.hex, 240_000, []),
      claimedSat: (firstSatOfBlock(240_000) + 1_000_000_000n).toString(),
    };
    const quiet = verifySatGenealogy(b, { ...NO_POW_FLOOR, trustHeader: () => {} });
    const marked = verifySatGenealogy(b, FIXTURE_OPTS);
    expect(quiet.coinbaseHeight).toBe(240_000);
    expect(marked.sat).toBe(quiet.sat);
    // and with no hook at all
    expect(verifySatGenealogy(b, NO_POW_FLOOR).sat).toBe(quiet.sat);
  });

  it('rejects the bundle when the hook attests a different hash at that height', () => {
    // a hook is only an attestation if it can disagree; this one holds a
    // different hash for height 1000 and refuses
    const b = bundle();
    const other = `${'0'.repeat(63)}1`;
    expect(() =>
      verifySatGenealogy(b, {
        ...NO_POW_FLOOR,
        trustHeader: (header, height) => {
          if (height === 1000 && header.hash !== other) {
            throw new Error(`header ${header.hash} at height 1000 contradicts ${other}`);
          }
        },
      }),
    ).toThrow(/contradicts/);
  });

  it('refuses fee-tail ancestries as CustodyUnsupportedError', () => {
    // coinbase claims subsidy + 1000 fee sats; the funding tx puts the traced
    // sat AFTER the subsidy boundary: commit spends funding output 1, whose
    // first sat sits at position subsidy + 100 in the coinbase's sat space
    const cbFees = buildCoinbase([{ value: SUBSIDY + 1_000n }]);
    const f2 = buildTx(
      [{ txid: cbFees.tx.txid, vout: 0 }],
      [{ value: SUBSIDY + 100n }, { value: 900n }],
    );
    const commit2 = buildTx(
      [{ txid: f2.tx.txid, vout: 1 }],
      [{ value: 800n, spk: tap.scriptPubKey }],
    );
    const reveal2 = revealTx([{ script, controlBlock: tap.controlBlock }], {
      prevTxidLE: commit2.tx.txidLE,
      vout: 0,
    });
    const b: SatGenealogyBundleJson = {
      version: 1,
      inscriptionId: `${reveal2.txid}i0`,
      reveal: anchoredHop(reveal2.txidLE, bytesToHex(reveal2.raw), 2000, [commit2.hex]),
      funding: [
        { tx: { hex: commit2.hex }, prevTxs: [f2.hex] },
        { tx: { hex: f2.hex }, prevTxs: [cbFees.hex] },
      ],
      coinbase: anchoredHop(cbFees.tx.txidLE, cbFees.hex, 1000, []),
      claimedSat: '0',
    };
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(CustodyUnsupportedError);
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/fee sats in block 1000/);
  });

  it('accepts prev txs past the envelope input when a pointer needs them', () => {
    // pointer 1500 indexes output space, which the SECOND input funds; the
    // envelope is on input 0, so proving inputs 0..0 is not enough to locate it
    const pointerScript = envelopeScript(
      { fields: [[1, 'text/plain'], [2, new Uint8Array([0xdc, 0x05])]], body: ['sat'] },
      { checksigPrefix: true },
    );
    const ptrTap = taprootCommit(pointerScript);
    const cb = buildCoinbase([{ value: 3_000_000_000n }]);
    // output 0 is the commit the envelope input spends, so it carries the
    // taproot commitment the binding check proves the envelope against
    const fA = buildTx(
      [{ txid: cb.tx.txid, vout: 0 }],
      [{ value: 1000n, spk: ptrTap.scriptPubKey }, { value: 2000n }],
    );
    const reveal2 = buildSegwitTx(
      [
        {
          txid: fA.tx.txid,
          vout: 0,
          witness: [new Uint8Array(64).fill(7), pointerScript, ptrTap.controlBlock],
        },
        { txid: fA.tx.txid, vout: 1 },
      ],
      [{ value: 2500n }],
    );
    // the reveal spends two inputs, so its numbering needs the block's
    // witness commitment; anchor it the way the builder now does
    const blk = buildBlock([reveal2.tx]);
    const b: SatGenealogyBundleJson = {
      version: 1,
      inscriptionId: `${reveal2.tx.txid}i0`,
      reveal: {
        block: { height: 2000, hash: blk.blockHash, header: blk.headerHex, txCount: blk.txCount },
        tx: { hex: reveal2.hex, pos: 1, txidBranch: blk.txidBranch(1) },
        prevTxs: [fA.hex, fA.hex],
        witness: {
          coinbaseHex: bytesToHex(blk.txs[0].raw),
          coinbaseTxidBranch: blk.txidBranch(0),
          wtxidBranch: blk.wtxidBranch(1),
        },
      },
      funding: [{ tx: { hex: fA.hex }, prevTxs: [cb.hex] }],
      coinbase: anchoredHop(cb.tx.txidLE, cb.hex, 1000, []),
      // 1500 -> input 1 at offset 500 -> fA:1 -> abs 1500 in fA -> cb:0 at 1500
      claimedSat: (firstSatOfBlock(1000) + 1500n).toString(),
    };

    const res = verifySatGenealogy(b, FIXTURE_OPTS);
    expect(res.revealPosition).toBe(1500n);
    expect(res.sat).toBe(firstSatOfBlock(1000) + 1500n);
    expect(res.depth).toBe(1);

    // and a bundle that stops at the envelope input cannot locate the sat
    const short = { ...b, reveal: { ...b.reveal, prevTxs: [fA.hex] } };
    expect(() => verifySatGenealogy(short, FIXTURE_OPTS)).toThrow(/more are needed/);
  });

  // -------------------------------------------------------------------------
  // envelope binding: the txid anchor does not cover the witness
  // -------------------------------------------------------------------------

  /** Re-serialize with input 0's witness replaced; stripped bytes, and so the
   *  txid, are unchanged. */
  function withWitness(tx: ParsedTx, witness: Uint8Array[]): ParsedTx {
    return parseTx(
      serializeFull({
        version: tx.version,
        inputs: tx.inputs.map((inp, i) => (i === 0 ? { ...inp, witness } : inp)),
        outputs: tx.outputs,
        locktime: tx.locktime,
      }),
    );
  }

  it('reports the taptree assurance alongside the sat', () => {
    const res = verifySatGenealogy(bundle(), FIXTURE_OPTS);
    expect(res.controlBlockDepth).toBe(0);
    expect(res.singleLeafTree).toBe(true);
    expect(res.singleInputReveal).toBe(true);
    expect(res.indexProof).toBe('single-input');
  });

  it('rejects a rewritten envelope witness that keeps the txid', () => {
    // the forgery: same stripped bytes, same txid, same anchored header, a
    // pointer that names a different sat
    const forgedScript = envelopeScript(
      { fields: [[1, 'text/plain'], [2, new Uint8Array([0xe8, 0x03])]], body: ['forged'] },
      { checksigPrefix: true },
    );
    const forged = withWitness(reveal, [
      new Uint8Array(64).fill(7),
      forgedScript,
      taprootCommit(forgedScript).controlBlock,
    ]);
    expect(forged.txid).toBe(reveal.txid);

    const b = bundle();
    b.reveal.tx.hex = bytesToHex(forged.raw);
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/taproot commitment/);
    // the honest bundle it came from still folds to its sat
    expect(verifySatGenealogy(bundle(), FIXTURE_OPTS).sat).toBe(firstSatOfBlock(1000) + 3_000_000_000n);
  });

  it('refuses an envelope input that spends a non-P2TR output', () => {
    // same envelope and control block, but the output it claims to be
    // committed by is a bare OP_1, which commits to nothing
    const bareCommit = buildTx([{ txid: funding.tx.txid, vout: 0 }], [{ value: 10_000n }]);
    const bareReveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
      prevTxidLE: bareCommit.tx.txidLE,
      vout: 0,
    });
    const b = bundle();
    b.inscriptionId = `${bareReveal.txid}i0`;
    b.reveal = anchoredHop(bareReveal.txidLE, bytesToHex(bareReveal.raw), 2000, [bareCommit.hex]);
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/non-P2TR/);
  });

  it('refuses a key-path envelope input', () => {
    // envelopes are only ever located on inputs that HAVE a tapscript, so a
    // bundle cannot reach this branch; it guards callers of the helper
    const insc = inscriptionsFromTx(reveal).find((i) => i.index === 0)!;
    const keyPath = withWitness(reveal, [new Uint8Array(64).fill(7)]);
    expect(() => verifyEnvelopeBinding(keyPath, insc, [commit.hex])).toThrow(/key-path/);
  });
});

// ---------------------------------------------------------------------------
// envelope index binding: a multi-input reveal needs the block's witness
// commitment, because control block depth 0 proves commitment and not
// execution
// ---------------------------------------------------------------------------

describe('envelope index binding (multi-input reveals)', () => {
  const SIG = new Uint8Array(64).fill(7);
  const envA = envelopeScript({ fields: [[1, 'text/plain']], body: ['A'] }, { checksigPrefix: true });
  const envB = envelopeScript({ fields: [[1, 'text/plain']], body: ['B'] }, { checksigPrefix: true });
  const tapA = taprootCommit(envA);
  const tapB = taprootCommit(envB);

  const cb = buildCoinbase([{ value: 3_000_000_000n }]);

  /** re-serialize with some witnesses replaced; the txid cannot change */
  function withWitnesses(tx: ParsedTx, witnesses: (Uint8Array[] | undefined)[]): ParsedTx {
    return parseTx(
      serializeFull({
        version: tx.version,
        inputs: tx.inputs.map((inp, i) => (witnesses[i] ? { ...inp, witness: witnesses[i]! } : inp)),
        outputs: tx.outputs,
        locktime: tx.locktime,
      }),
    );
  }

  /** commit spending the coinbase, reveal spending both commit outputs */
  function chain(spks: [Uint8Array, Uint8Array], witnesses: [Uint8Array[], Uint8Array[]]) {
    const commit = buildTx(
      [{ txid: cb.tx.txid, vout: 0 }],
      [
        { value: 10_000n, spk: spks[0] },
        { value: 20_000n, spk: spks[1] },
      ],
    );
    const reveal = buildSegwitTx(
      [
        { txid: commit.tx.txid, vout: 0, witness: witnesses[0] },
        { txid: commit.tx.txid, vout: 1, witness: witnesses[1] },
      ],
      [{ value: 25_000n }],
    );
    return { commit, reveal };
  }

  function genealogy(
    revealTxid: string,
    revealHex: string,
    revealTxidLE: Uint8Array,
    commitHex: string,
    index: number,
    claimedSat: bigint,
  ): SatGenealogyBundleJson {
    return {
      version: 1,
      inscriptionId: `${revealTxid}i${index}`,
      reveal: anchoredHop(revealTxidLE, revealHex, 2000, [commitHex, commitHex]),
      funding: [{ tx: { hex: commitHex }, prevTxs: [cb.hex] }],
      coinbase: anchoredHop(cb.tx.txidLE, cb.hex, 1000, []),
      claimedSat: claimedSat.toString(),
    };
  }

  it('refuses a multi-input reveal that carries no witness section', () => {
    const { commit, reveal } = chain(
      [tapA.scriptPubKey, tapB.scriptPubKey],
      [
        [SIG, envA, tapA.controlBlock],
        [SIG, envB, tapB.controlBlock],
      ],
    );
    const bundle = genealogy(
      reveal.tx.txid,
      reveal.hex,
      reveal.tx.txidLE,
      commit.hex,
      1,
      firstSatOfBlock(1000) + 10_000n,
    );
    expect(() => verifySatGenealogy(bundle, FIXTURE_OPTS)).toThrow(EnvelopeIndexUnprovenError);
    // the message names the input count, the requested index, and the cause
    expect(() => verifySatGenealogy(bundle, FIXTURE_OPTS)).toThrow(/reveal spends 2 inputs/);
    expect(() => verifySatGenealogy(bundle, FIXTURE_OPTS)).toThrow(/any envelope index 1/);
    expect(() => verifySatGenealogy(bundle, FIXTURE_OPTS)).toThrow(/no witness section/);
  });

  it('refuses the key-path prefix forgery the prefix rule used to accept', () => {
    // on chain: input 0 spends tapA by KEY path, so ord sees no envelope there
    // and envB on input 1 is index 0. tapA's author can serve the script-path
    // witness afterwards; it binds at depth 0 because they committed the leaf.
    const { commit, reveal } = chain(
      [tapA.scriptPubKey, tapB.scriptPubKey],
      [[SIG], [SIG, envB, tapB.controlBlock]],
    );
    const honestSat = firstSatOfBlock(1000) + 10_000n;
    const forgedTx = withWitnesses(reveal.tx, [[SIG, envA, tapA.controlBlock], undefined]);
    expect(forgedTx.txid).toBe(reveal.tx.txid);
    // the forgery renumbers envB out of index 0 and puts envA there, at
    // reveal position 0 rather than 10,000
    expect(inscriptionsFromTx(forgedTx).map((i) => i.input)).toEqual([0, 1]);

    // both are refused now, honest and forged alike, for want of a section
    for (const tx of [reveal.tx, forgedTx]) {
      const bundle = genealogy(
        tx.txid,
        bytesToHex(tx.raw),
        tx.txidLE,
        commit.hex,
        0,
        honestSat,
      );
      expect(() => verifySatGenealogy(bundle, FIXTURE_OPTS)).toThrow(EnvelopeIndexUnprovenError);
    }

    // with the block's witness commitment the honest reveal verifies and the
    // forgery does not, because the wtxid covers the witness bytes themselves
    const block = buildBlock([reveal.tx]);
    function anchored(hex: string, sat: bigint): SatGenealogyBundleJson {
      return {
        version: 1,
        inscriptionId: `${reveal.tx.txid}i0`,
        reveal: {
          block: { height: 2000, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
          tx: { hex, pos: 1, txidBranch: block.txidBranch(1) },
          prevTxs: [commit.hex, commit.hex],
          witness: {
            coinbaseHex: bytesToHex(block.txs[0].raw),
            coinbaseTxidBranch: block.txidBranch(0),
            wtxidBranch: block.wtxidBranch(1),
          },
        },
        funding: [{ tx: { hex: commit.hex }, prevTxs: [cb.hex] }],
        coinbase: anchoredHop(cb.tx.txidLE, cb.hex, 1000, []),
        claimedSat: sat.toString(),
      };
    }
    const res = verifySatGenealogy(anchored(bytesToHex(reveal.tx.raw), honestSat), FIXTURE_OPTS);
    expect(res.indexProof).toBe('wtxid');
    expect(res.revealPosition).toBe(10_000n);
    expect(res.sat).toBe(honestSat);
    expect(() => verifySatGenealogy(anchored(bytesToHex(forgedTx.raw), firstSatOfBlock(1000)), FIXTURE_OPTS)).toThrow(
      /witness commitment mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// wtxid anchoring: the witness commitment pins numbering on multi-input reveals
// ---------------------------------------------------------------------------

describe('wtxid-anchored reveals (genealogy)', () => {
  const SIG = new Uint8Array(64).fill(7);
  const envA = envelopeScript({ fields: [[1, 'text/plain']], body: ['A'] }, { checksigPrefix: true });
  const envB = envelopeScript({ fields: [[1, 'text/plain']], body: ['B'] }, { checksigPrefix: true });
  const tapA = taprootCommit(envA);
  const tapB = taprootCommit(envB);

  const cb = buildCoinbase([{ value: 3_000_000_000n }]);
  // batch reveal, both envelopes committed by their own prevouts
  const commit = buildTx(
    [{ txid: cb.tx.txid, vout: 0 }],
    [
      { value: 10_000n, spk: tapA.scriptPubKey },
      { value: 20_000n, spk: tapB.scriptPubKey },
    ],
  );
  const reveal = buildSegwitTx(
    [
      { txid: commit.tx.txid, vout: 0, witness: [SIG, envA, tapA.controlBlock] },
      { txid: commit.tx.txid, vout: 1, witness: [SIG, envB, tapB.controlBlock] },
    ],
    [{ value: 25_000n }],
  );
  const block = buildBlock([reveal.tx]);

  // the pointer-bundle shape: key-path funding input ahead of the envelope
  const commitKey = buildTx(
    [{ txid: cb.tx.txid, vout: 0 }],
    [
      { value: 10_000n },
      { value: 20_000n, spk: tapB.scriptPubKey },
    ],
  );
  const revealKey = buildSegwitTx(
    [
      { txid: commitKey.tx.txid, vout: 0, witness: [SIG] },
      { txid: commitKey.tx.txid, vout: 1, witness: [SIG, envB, tapB.controlBlock] },
    ],
    [{ value: 25_000n }],
  );
  const blockKey = buildBlock([revealKey.tx]);

  function withWitnesses(tx: ParsedTx, witnesses: (Uint8Array[] | undefined)[]): ParsedTx {
    return parseTx(
      serializeFull({
        version: tx.version,
        inputs: tx.inputs.map((inp, i) => (witnesses[i] ? { ...inp, witness: witnesses[i]! } : inp)),
        outputs: tx.outputs,
        locktime: tx.locktime,
      }),
    );
  }

  function wtxidGenealogy(
    blk: TestBlock,
    revealHex: string,
    commitHex: string,
    index: number,
    claimedSat: bigint,
  ): SatGenealogyBundleJson {
    return {
      version: 1,
      inscriptionId: `${blk.txs[1].txid}i${index}`,
      reveal: {
        block: { height: 2000, hash: blk.blockHash, header: blk.headerHex, txCount: blk.txCount },
        tx: { hex: revealHex, pos: 1, txidBranch: blk.txidBranch(1) },
        prevTxs: [commitHex, commitHex],
        witness: {
          coinbaseHex: bytesToHex(blk.txs[0].raw),
          coinbaseTxidBranch: blk.txidBranch(0),
          wtxidBranch: blk.wtxidBranch(1),
        },
      },
      funding: [{ tx: { hex: commitHex }, prevTxs: [cb.hex] }],
      coinbase: anchoredHop(cb.tx.txidLE, cb.hex, 1000, []),
      claimedSat: claimedSat.toString(),
    };
  }

  it('verifies an honest witness-anchored multi-input bundle, and refuses it without the section', () => {
    const withSection = wtxidGenealogy(block, bytesToHex(reveal.tx.raw), commit.hex, 1, firstSatOfBlock(1000) + 10_000n);
    const res = verifySatGenealogy(withSection, FIXTURE_OPTS);
    expect(res.indexProof).toBe('wtxid');
    expect(res.revealPosition).toBe(10_000n);
    expect(res.sat).toBe(firstSatOfBlock(1000) + 10_000n);
    expect(res.singleInputReveal).toBe(false);

    const noSection = wtxidGenealogy(block, bytesToHex(reveal.tx.raw), commit.hex, 1, firstSatOfBlock(1000) + 10_000n);
    delete noSection.reveal.witness;
    expect(() => verifySatGenealogy(noSection, FIXTURE_OPTS)).toThrow(EnvelopeIndexUnprovenError);
  });

  it('refuses an absent index before claiming how many envelopes there are', () => {
    // index 7 is in neither envelope. Without a section the count is unproven,
    // so "index 7 not present" would assert a count the bundle cannot support
    const noSection = wtxidGenealogy(block, bytesToHex(reveal.tx.raw), commit.hex, 7, firstSatOfBlock(1000) + 10_000n);
    delete noSection.reveal.witness;
    expect(() => verifySatGenealogy(noSection, FIXTURE_OPTS)).toThrow(EnvelopeIndexUnprovenError);
    expect(() => verifySatGenealogy(noSection, FIXTURE_OPTS)).toThrow(/any envelope index 7/);
    expect(() => verifySatGenealogy(noSection, FIXTURE_OPTS)).not.toThrow(/not present/);

    // with the section the count IS proven, so the old message is supportable
    const withSection = wtxidGenealogy(block, bytesToHex(reveal.tx.raw), commit.hex, 7, firstSatOfBlock(1000) + 10_000n);
    expect(() => verifySatGenealogy(withSection, FIXTURE_OPTS)).toThrow(
      /contains 2 envelope\(s\); index 7 not present/,
    );
  });

  it('proves the index of a reveal whose earlier input is a key-path spend', () => {
    const noSection = wtxidGenealogy(blockKey, bytesToHex(revealKey.tx.raw), commitKey.hex, 0, firstSatOfBlock(1000) + 10_000n);
    delete noSection.reveal.witness;
    expect(() => verifySatGenealogy(noSection, FIXTURE_OPTS)).toThrow(EnvelopeIndexUnprovenError);

    const withSection = wtxidGenealogy(blockKey, bytesToHex(revealKey.tx.raw), commitKey.hex, 0, firstSatOfBlock(1000) + 10_000n);
    const res = verifySatGenealogy(withSection, FIXTURE_OPTS);
    expect(res.indexProof).toBe('wtxid');
    expect(res.sat).toBe(firstSatOfBlock(1000) + 10_000n);
  });

  it('rejects all three witness rewrites against the block commitment', () => {
    const rewrites: (Uint8Array[] | undefined)[][] = [
      [[SIG], [SIG, envA, tapA.controlBlock]], // move A onto input 1
      [[SIG], undefined], // delete A, renumbering B
      [[SIG, envB, taprootCommit(envA).controlBlock], undefined], // insert junk on input 0
    ];
    for (const witnesses of rewrites) {
      const forged = withWitnesses(reveal.tx, witnesses);
      expect(forged.txid).toBe(reveal.tx.txid);
      const b = wtxidGenealogy(block, bytesToHex(forged.raw), commit.hex, 1, firstSatOfBlock(1000) + 10_000n);
      expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/witness commitment mismatch/);
    }
  });

  it('refuses a witness section on the terminal coinbase hop', () => {
    const b = wtxidGenealogy(block, bytesToHex(reveal.tx.raw), commit.hex, 1, firstSatOfBlock(1000) + 10_000n);
    b.coinbase.witness = { coinbaseHex: '00', coinbaseTxidBranch: [], wtxidBranch: [] };
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(/witness section is only accepted at the reveal/);
  });

  it('refuses a falsy witness value on the coinbase, the way it does on a step', () => {
    // untrusted JSON can carry `"witness": 0`, which is falsy and carries no
    // data; the rule is stated without exception, so presence is what counts
    for (const value of [0, '', false, null]) {
      const b = wtxidGenealogy(block, bytesToHex(reveal.tx.raw), commit.hex, 1, firstSatOfBlock(1000) + 10_000n);
      (b.coinbase as { witness?: unknown }).witness = value;
      expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(
        /coinbase: witness section is only accepted at the reveal/,
      );
    }
  });

  it('refuses a witness section on a funding step', () => {
    // GenealogyStepJson declares no witness field, so only untrusted JSON can
    // carry one; the spec's rule binds every element and not just the coinbase
    const b = wtxidGenealogy(block, bytesToHex(reveal.tx.raw), commit.hex, 1, firstSatOfBlock(1000) + 10_000n);
    (b.funding[0] as { witness?: unknown }).witness = {
      coinbaseHex: '00',
      coinbaseTxidBranch: [],
      wtxidBranch: [],
    };
    expect(() => verifySatGenealogy(b, FIXTURE_OPTS)).toThrow(
      /funding\[0\]: witness section is only accepted at the reveal/,
    );
  });

  it('reports a malformed witness section by field, not as a TypeError', () => {
    const base = () =>
      wtxidGenealogy(block, bytesToHex(reveal.tx.raw), commit.hex, 1, firstSatOfBlock(1000) + 10_000n);

    const noHex = base();
    (noHex.reveal.witness as { coinbaseHex: unknown }).coinbaseHex = undefined;
    expect(() => verifySatGenealogy(noHex, FIXTURE_OPTS)).toThrow(
      /witness section: coinbaseHex must be a non-empty hex string/,
    );

    const emptyHex = base();
    emptyHex.reveal.witness!.coinbaseHex = '';
    expect(() => verifySatGenealogy(emptyHex, FIXTURE_OPTS)).toThrow(/witness section: coinbaseHex/);

    const notArray = base();
    (notArray.reveal.witness as { wtxidBranch: unknown }).wtxidBranch = 'deadbeef';
    expect(() => verifySatGenealogy(notArray, FIXTURE_OPTS)).toThrow(
      /witness section: wtxidBranch must be an array of 32-byte hex strings/,
    );

    const shortNode = base();
    shortNode.reveal.witness!.coinbaseTxidBranch = ['00'];
    expect(() => verifySatGenealogy(shortNode, FIXTURE_OPTS)).toThrow(
      /witness section: coinbaseTxidBranch\[0\] must be a 32-byte hex string/,
    );

    const nonString = base();
    (nonString.reveal.witness!.wtxidBranch as unknown[])[0] = 7;
    expect(() => verifySatGenealogy(nonString, FIXTURE_OPTS)).toThrow(
      /witness section: wtxidBranch\[0\] must be a 32-byte hex string/,
    );
  });
});
