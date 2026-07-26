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
  CustodyUnsupportedError,
  TOTAL_SATS,
  LAST_SAT,
  type SatGenealogyBundleJson,
  type CustodyHopJson,
  type ParsedTx,
  bytesToHex,
  hexToBytes,
  sha256d,
  internalToDisplay,
} from '../src/index.js';
import { envelopeScript, revealTx, taprootCommit } from './helpers.js';

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

  it('verifies a full synthetic genealogy to the coinbase', () => {
    const res = verifySatGenealogy(bundle());
    expect(res.sat).toBe(firstSatOfBlock(1000) + 3_000_000_000n);
    expect(res.coinbaseHeight).toBe(1000);
    expect(res.depth).toBe(2);
    expect(res.rarity).toBe('common');
    expect(res.name).toBe(satName(res.sat));
    expect(res.revealPosition).toBe(0n);
    expect(TOTAL_SATS > res.sat).toBe(true);
  });

  it('rejects a wrong claimed sat', () => {
    const b = bundle();
    b.claimedSat = (firstSatOfBlock(1000) + 1n).toString();
    expect(() => verifySatGenealogy(b)).toThrow(/folds to/);
  });

  it('rejects a broken hash chain', () => {
    const b = bundle();
    b.funding = [b.funding[1], b.funding[0]];
    expect(() => verifySatGenealogy(b)).toThrow(/chain expects/);
  });

  it('rejects a coinbase claimed at nonzero position', () => {
    const b = bundle();
    b.coinbase.tx.pos = 1;
    expect(() => verifySatGenealogy(b)).toThrow(/position 0/);
  });

  it('requires a BIP34 height for modern blocks', () => {
    const b = bundle();
    b.coinbase.block.height = 240_000;
    expect(() => verifySatGenealogy(b)).toThrow(/BIP34/);
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
    expect(() => verifySatGenealogy(b)).toThrow(CustodyUnsupportedError);
    expect(() => verifySatGenealogy(b)).toThrow(/fee sats in block 1000/);
  });
});
