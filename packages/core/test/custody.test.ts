import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTx,
  parseSatpoint,
  formatSatpoint,
  genesisSatpoint,
  transferSatpoint,
  provenInputValues,
  verifyCustodyBundle,
  serializeFull,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  type CustodyBundleJson,
  type Inscription,
  type ParsedTx,
  hexToBytes,
  bytesToHex,
  sha256,
  sha256d,
  internalToDisplay,
} from '../src/index.js';
import { envelopeScript, script, taprootCommit } from './helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insc0');
const revealHex = readFileSync(join(FIXTURES, 'reveal.hex'), 'utf8').trim();
const commitHex = readFileSync(join(FIXTURES, 'commit.hex'), 'utf8').trim();
const headerHex = readFileSync(join(FIXTURES, 'header-767430.hex'), 'utf8').trim();
const merkleProof = JSON.parse(readFileSync(join(FIXTURES, 'merkle-proof.json'), 'utf8')) as {
  block_height: number;
  merkle: string[];
  pos: number;
};
const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  revealTxid: string;
  blockHash: string;
  blockHeight: number;
};
const INSC0_TXCOUNT = 2332; // block 767430; consistent with the 12-node branch depth

// ---------------------------------------------------------------------------
// hand-built legacy transactions (values are all FIFO arithmetic needs)
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
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Build a legacy (no-witness) transaction from outpoints and output values. */
function buildTx(
  inputs: { txid: string; vout: number }[],
  outputValues: bigint[],
): { hex: string; tx: ParsedTx } {
  const parts: Uint8Array[] = [u32le(2), varint(inputs.length)];
  for (const inp of inputs) {
    const txidLE = hexToBytes(inp.txid).reverse();
    parts.push(txidLE, u32le(inp.vout), varint(1), new Uint8Array([0x51]), u32le(0xffffffff));
  }
  parts.push(varint(outputValues.length));
  for (const v of outputValues) {
    parts.push(u64le(v), varint(1), new Uint8Array([0x51]));
  }
  parts.push(u32le(0));
  const raw = cat(...parts);
  const hex = bytesToHex(raw);
  return { hex, tx: parseTx(raw) };
}

function mkInscription(partial: Partial<Inscription>): Inscription {
  return {
    index: 0,
    input: 0,
    parents: [],
    flags: {
      incompleteField: false,
      duplicateField: false,
      unrecognizedEvenField: false,
      pushnum: false,
      stutter: false,
    } as Inscription['flags'],
    ...partial,
  } as Inscription;
}

const T0 = '11'.repeat(32);
const T1 = '22'.repeat(32);
const T2 = '33'.repeat(32);

// ---------------------------------------------------------------------------
// FIFO arithmetic
// ---------------------------------------------------------------------------

describe('transferSatpoint FIFO arithmetic', () => {
  // funding txs give the input values
  const fundA = buildTx([{ txid: T0, vout: 0 }], [1000n]);
  const fundB = buildTx([{ txid: T0, vout: 1 }], [2000n]);
  // spend: inputs [A(1000), B(2000)] -> outputs [1500, 1400], fee 100
  const spend = buildTx(
    [
      { txid: fundA.tx.txid, vout: 0 },
      { txid: fundB.tx.txid, vout: 0 },
    ],
    [1500n, 1400n],
  );
  const values = provenInputValues(spend.tx, [fundA.hex, fundB.hex], 1);

  it('proves input values from prev txs (self-certifying)', () => {
    expect(values).toEqual([1000n, 2000n]);
  });

  it('rejects prev tx that does not hash to the named txid', () => {
    expect(() => provenInputValues(spend.tx, [fundB.hex, fundA.hex], 1)).toThrow(/hashes to/);
  });

  it('keeps a sat inside the first output', () => {
    const sp = transferSatpoint(spend.tx, values, { txid: fundA.tx.txid, vout: 0, offset: 999n });
    expect(formatSatpoint(sp)).toBe(`${spend.tx.txid}:0:999`);
  });

  it('crosses the output boundary exactly', () => {
    // abs position of B offset 0 = 1000 -> output 0 has 1500, so offset 1000 in output 0
    const sp0 = transferSatpoint(spend.tx, values, { txid: fundB.tx.txid, vout: 0, offset: 0n });
    expect(formatSatpoint(sp0)).toBe(`${spend.tx.txid}:0:1000`);
    // abs 1500 is the first sat of output 1
    const sp1 = transferSatpoint(spend.tx, values, { txid: fundB.tx.txid, vout: 0, offset: 500n });
    expect(formatSatpoint(sp1)).toBe(`${spend.tx.txid}:1:0`);
  });

  it('follows FIFO across inputs', () => {
    // B offset 700 -> abs 1700 -> output 1 offset 200
    const sp = transferSatpoint(spend.tx, values, { txid: fundB.tx.txid, vout: 0, offset: 700n });
    expect(formatSatpoint(sp)).toBe(`${spend.tx.txid}:1:200`);
  });

  it('refuses fee spillover with CustodyUnsupportedError', () => {
    // B offset 1950 -> abs 2950 >= 2900 total output sats
    expect(() =>
      transferSatpoint(spend.tx, values, { txid: fundB.tx.txid, vout: 0, offset: 1950n }, 800000),
    ).toThrow(CustodyUnsupportedError);
  });

  it('skips zero-value outputs', () => {
    const z = buildTx([{ txid: fundA.tx.txid, vout: 0 }], [0n, 500n]);
    const sp = transferSatpoint(z.tx, [1000n], { txid: fundA.tx.txid, vout: 0, offset: 0n });
    expect(sp.vout).toBe(1);
    expect(sp.offset).toBe(0n);
  });

  it('rejects a tx that does not spend the tracked satpoint', () => {
    expect(() =>
      transferSatpoint(spend.tx, values, { txid: T2, vout: 0, offset: 0n }),
    ).toThrow(/does not spend/);
  });
});

// ---------------------------------------------------------------------------
// genesis satpoint
// ---------------------------------------------------------------------------

describe('genesisSatpoint', () => {
  const fund1 = buildTx([{ txid: T0, vout: 0 }], [600n]);
  const fund2 = buildTx([{ txid: T0, vout: 1 }], [400n]);
  // reveal-shaped legacy tx: inputs [600, 400] -> outputs [500, 450], fee 50
  const reveal = buildTx(
    [
      { txid: fund1.tx.txid, vout: 0 },
      { txid: fund2.tx.txid, vout: 0 },
    ],
    [500n, 450n],
  );
  const values = [600n, 400n];

  it('defaults to the first sat of the envelope input, mapped through outputs', () => {
    // input 1 starts at abs 600 -> output 1 offset 100
    const sp = genesisSatpoint(reveal.tx, mkInscription({ input: 1 }), values);
    expect(formatSatpoint(sp)).toBe(`${reveal.tx.txid}:1:100`);
  });

  it('a valid pointer indexes the output sat space directly', () => {
    const sp = genesisSatpoint(reveal.tx, mkInscription({ input: 0, pointer: 700n }), values);
    expect(formatSatpoint(sp)).toBe(`${reveal.tx.txid}:1:200`);
  });

  it('ignores a pointer at or past total output sats', () => {
    const sp = genesisSatpoint(reveal.tx, mkInscription({ input: 0, pointer: 950n }), values);
    expect(formatSatpoint(sp)).toBe(`${reveal.tx.txid}:0:0`);
  });

  it('refuses fee-bound (unbound) inscriptions', () => {
    // single 900-sat output; input 1 starts at abs 600+... build: outputs [900], inputs [600,400]
    const r = buildTx(
      [
        { txid: fund1.tx.txid, vout: 0 },
        { txid: fund2.tx.txid, vout: 0 },
      ],
      [900n],
    );
    // envelope on input 1: abs 600 < 900 -> fine. Use offset past outputs: input 1 with fund2=400
    // total inputs 1000, outputs 900. envelope on a third input would start at 1000.
    const fund3 = buildTx([{ txid: T0, vout: 2 }], [300n]);
    const r2 = buildTx(
      [
        { txid: fund1.tx.txid, vout: 0 },
        { txid: fund2.tx.txid, vout: 0 },
        { txid: fund3.tx.txid, vout: 0 },
      ],
      [900n],
    );
    expect(() =>
      genesisSatpoint(r2.tx, mkInscription({ input: 2 }), [600n, 400n, 300n]),
    ).toThrow(CustodyUnsupportedError);
    // and the two-input case lands normally
    const ok = genesisSatpoint(r.tx, mkInscription({ input: 1 }), [600n, 400n]);
    expect(formatSatpoint(ok)).toBe(`${r.tx.txid}:0:600`);
  });

  it('refuses ord-unbound inscriptions: unrecognized even field', () => {
    const insc = mkInscription({ input: 0 });
    insc.unboundByEvenField = true;
    expect(() => genesisSatpoint(reveal.tx, insc, values)).toThrow(CustodyUnsupportedError);
    expect(() => genesisSatpoint(reveal.tx, insc, values)).toThrow(/unbound at reveal/);
    // a pointer does not rescue an unbound inscription (ord ignores location
    // arithmetic entirely for unbound)
    insc.pointer = 100n;
    expect(() => genesisSatpoint(reveal.tx, insc, values)).toThrow(CustodyUnsupportedError);
  });

  it('refuses ord-unbound inscriptions: zero-value envelope input', () => {
    const fundZero = buildTx([{ txid: T0, vout: 3 }], [0n]);
    // envelope input 1 spends a zero-value output; outputs still cover the
    // default position (600 < 700), so only the unbound rule can refuse this
    const r = buildTx(
      [
        { txid: fund1.tx.txid, vout: 0 },
        { txid: fundZero.tx.txid, vout: 0 },
      ],
      [700n],
    );
    expect(() =>
      genesisSatpoint(r.tx, mkInscription({ input: 1 }), [600n, 0n]),
    ).toThrow(/unbound at reveal/);
    // sanity: same shape with a funded envelope input lands normally
    const ok = genesisSatpoint(r.tx, mkInscription({ input: 1 }), [600n, 50n]);
    expect(formatSatpoint(ok)).toBe(`${r.tx.txid}:0:600`);
  });

  it('computes inscription 0 genesis from the real reveal', () => {
    const revealTx = parseTx(hexToBytes(revealHex));
    const insc = mkInscription({ input: 0 });
    const values0 = provenInputValues(revealTx, [commitHex], 0);
    const sp = genesisSatpoint(revealTx, insc, values0);
    expect(sp.txid).toBe(expected.revealTxid);
    expect(sp.vout).toBe(0);
    expect(sp.offset).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// custody bundles end to end
// ---------------------------------------------------------------------------

/** Build an easiest-PoW (regtest-bits) header containing exactly one tx. */
function mineSingleTxBlock(txidLE: Uint8Array, prevHashLE: Uint8Array): { headerHex: string; hash: string } {
  const bits = 0x207fffff;
  for (let nonce = 0; nonce < 100000; nonce++) {
    const header = cat(u32le(2), prevHashLE, txidLE, u32le(1700000000), u32le(bits), u32le(nonce));
    const hashLE = sha256d(header);
    // target for 0x207fffff is enormous; require top byte < 0x7f to pass quickly
    if (hashLE[31] === 0) {
      return { headerHex: bytesToHex(header), hash: internalToDisplay(hashLE) };
    }
  }
  throw new Error('failed to mine test header');
}

describe('verifyCustodyBundle', () => {
  const revealTx = parseTx(hexToBytes(revealHex));

  function singleHopBundle(): CustodyBundleJson {
    return {
      version: 1,
      inscriptionId: `${expected.revealTxid}i0`,
      hops: [
        {
          block: {
            height: expected.blockHeight,
            hash: expected.blockHash,
            header: headerHex,
            txCount: INSC0_TXCOUNT,
          },
          tx: { hex: revealHex, pos: merkleProof.pos, txidBranch: merkleProof.merkle },
          prevTxs: [commitHex],
        },
      ],
      finalSatpoint: `${expected.revealTxid}:0:0`,
    };
  }

  it('verifies a real single-hop (reveal-only) bundle against mainnet data', () => {
    const res = verifyCustodyBundle(singleHopBundle());
    expect(res.satpoint).toEqual(parseSatpoint(`${expected.revealTxid}:0:0`));
    expect(res.genesis).toEqual(res.satpoint);
    expect(res.hops).toBe(1);
    expect(res.height).toBe(expected.blockHeight);
  });

  it('rejects a wrong claimed final satpoint', () => {
    const b = singleHopBundle();
    b.finalSatpoint = `${expected.revealTxid}:0:1`;
    expect(() => verifyCustodyBundle(b)).toThrow(/path folds to/);
  });

  it('rejects a tampered txCount (branch depth hardening)', () => {
    const b = singleHopBundle();
    b.hops[0].block.txCount = 5000;
    expect(() => verifyCustodyBundle(b)).toThrow(/tree height/);
  });

  it('verifies a two-hop path through a mined test block', () => {
    // hop 1 spends the reveal's output 0 (value read from the real tx)
    const outValue = revealTx.outputs[0].value;
    const spend = buildTx([{ txid: revealTx.txid, vout: 0 }], [outValue - 200n]);
    const mined = mineSingleTxBlock(spend.tx.txidLE, new Uint8Array(32));
    const bundle = singleHopBundle();
    bundle.hops.push({
      block: { height: expected.blockHeight + 10, hash: mined.hash, header: mined.headerHex, txCount: 1 },
      tx: { hex: spend.hex, pos: 0, txidBranch: [] },
      prevTxs: [revealHex],
    });
    bundle.finalSatpoint = `${spend.tx.txid}:0:0`;
    const res = verifyCustodyBundle(bundle);
    expect(res.hops).toBe(2);
    expect(res.satpoint.txid).toBe(spend.tx.txid);
    expect(res.path).toHaveLength(2);
  });

  it('rejects hops that go backwards in chain order', () => {
    const outValue = revealTx.outputs[0].value;
    const spend = buildTx([{ txid: revealTx.txid, vout: 0 }], [outValue - 200n]);
    const mined = mineSingleTxBlock(spend.tx.txidLE, new Uint8Array(32));
    const bundle = singleHopBundle();
    bundle.hops.push({
      block: { height: expected.blockHeight - 1, hash: mined.hash, header: mined.headerHex, txCount: 1 },
      tx: { hex: spend.hex, pos: 0, txidBranch: [] },
      prevTxs: [revealHex],
    });
    bundle.finalSatpoint = `${spend.tx.txid}:0:0`;
    expect(() => verifyCustodyBundle(bundle)).toThrow(/chain order/);
  });

  it('surfaces fee-spillover paths as CustodyUnsupportedError', () => {
    const outValue = revealTx.outputs[0].value;
    // spend sends everything but the tracked sat range to outputs: output smaller than needed
    const spend = buildTx([{ txid: revealTx.txid, vout: 0 }], [0n]);
    const mined = mineSingleTxBlock(spend.tx.txidLE, new Uint8Array(32));
    const bundle = singleHopBundle();
    bundle.hops.push({
      block: { height: expected.blockHeight + 10, hash: mined.hash, header: mined.headerHex, txCount: 1 },
      tx: { hex: spend.hex, pos: 0, txidBranch: [] },
      prevTxs: [revealHex],
    });
    bundle.finalSatpoint = `${spend.tx.txid}:0:0`;
    expect(() => verifyCustodyBundle(bundle)).toThrow(CustodyUnsupportedError);
    expect(outValue > 0n).toBe(true);
  });

  it('rejects a duplicate hop transaction', () => {
    const outValue = revealTx.outputs[0].value;
    const spend = buildTx([{ txid: revealTx.txid, vout: 0 }], [outValue - 200n]);
    const mined = mineSingleTxBlock(spend.tx.txidLE, new Uint8Array(32));
    const bundle = singleHopBundle();
    const hop = {
      block: { height: expected.blockHeight + 10, hash: mined.hash, header: mined.headerHex, txCount: 1 },
      tx: { hex: spend.hex, pos: 0, txidBranch: [] as string[] },
      prevTxs: [revealHex],
    };
    // the same transaction presented as two hops; the duplicate check fires
    // before chain order or spend linkage can object
    bundle.hops.push(hop, { ...hop, block: { ...hop.block, height: hop.block.height + 1 } });
    bundle.finalSatpoint = `${spend.tx.txid}:0:0`;
    expect(() => verifyCustodyBundle(bundle)).toThrow(/duplicate transaction/);
  });

  it('refuses a coinbase as a later hop with CustodyUnsupportedError', () => {
    const coinbase = buildTx([{ txid: '00'.repeat(32), vout: 0xffffffff }], [5000000000n, 0n]);
    const mined = mineSingleTxBlock(coinbase.tx.txidLE, new Uint8Array(32));
    const bundle = singleHopBundle();
    bundle.hops.push({
      block: { height: expected.blockHeight + 10, hash: mined.hash, header: mined.headerHex, txCount: 1 },
      tx: { hex: coinbase.hex, pos: 0, txidBranch: [] },
      prevTxs: [],
    });
    bundle.finalSatpoint = `${coinbase.tx.txid}:0:0`;
    expect(() => verifyCustodyBundle(bundle)).toThrow(CustodyUnsupportedError);
    expect(() => verifyCustodyBundle(bundle)).toThrow(/coinbase/);
  });

  it('rejects hop txs whose STRIPPED serialization is 64 bytes (leaf/node ambiguity)', () => {
    // stripped: version(4) inCount(1) outpoint(36) scriptSigLen(1)=0 seq(4)
    //           outCount(1) value(8) spkLen(1) spk(4) locktime(4) = 64 bytes
    const stripped = cat(
      u32le(2),
      varint(1),
      hexToBytes(T0).reverse(),
      u32le(0),
      varint(0),
      u32le(0xffffffff),
      varint(1),
      u64le(1000n),
      varint(4),
      new Uint8Array([0x51, 0x51, 0x51, 0x51]),
      u32le(0),
    );
    expect(stripped.length).toBe(64);
    // segwit-wrap it: marker+flag and a one-item witness stack, so the RAW
    // length grows past 64 while the txid preimage stays exactly 64
    const raw = cat(
      stripped.slice(0, 4),
      new Uint8Array([0x00, 0x01]),
      stripped.slice(4, 60),
      varint(1),
      varint(1),
      new Uint8Array([0x00]),
      stripped.slice(60),
    );
    const b = singleHopBundle();
    b.hops[0].tx.hex = bytesToHex(raw);
    expect(() => verifyCustodyBundle(b)).toThrow(/64-byte/);
    // and the legacy (raw==stripped) form is rejected the same way
    b.hops[0].tx.hex = bytesToHex(stripped);
    expect(() => verifyCustodyBundle(b)).toThrow(/64-byte/);
  });

  it('respects trustHeader rejection', () => {
    expect(() =>
      verifyCustodyBundle(singleHopBundle(), {
        trustHeader: () => {
          throw new Error('anchor says no');
        },
      }),
    ).toThrow(/anchor says no/);
  });

  // -------------------------------------------------------------------------
  // anchoring rejections: the four checks every hop is bound by
  // -------------------------------------------------------------------------

  it('rejects a header that does not hash to the claimed block hash', () => {
    const b = singleHopBundle();
    b.hops[0].block.hash = `${'0'.repeat(63)}1`;
    expect(() => verifyCustodyBundle(b)).toThrow(/header hashes to/);
  });

  it('rejects a header that fails its own proof of work', () => {
    // rewrite nBits to an unreachably hard target, leaving the rest intact;
    // the header still hashes to whatever it hashes to, so the claimed hash
    // moves with it and the PoW check is what objects
    const b = singleHopBundle();
    const raw = hexToBytes(headerHex);
    raw.set(hexToBytes('01000000').reverse(), 72); // bits = 0x00000001
    b.hops[0].block.header = bytesToHex(raw);
    b.hops[0].block.hash = internalToDisplay(sha256d(raw));
    expect(() => verifyCustodyBundle(b)).toThrow(/fails proof of work/);
  });

  it('rejects a missing or nonsensical txCount', () => {
    for (const bad of [undefined, 0, -1, 1.5]) {
      const b = singleHopBundle();
      b.hops[0].block.txCount = bad as number;
      expect(() => verifyCustodyBundle(b)).toThrow(/missing valid txCount/);
    }
  });

  it('rejects a txid branch that folds to the wrong merkle root', () => {
    // flip a byte in the TOPMOST sibling: every lower level folds and
    // self-pairs exactly as before, and the depth still matches the tree
    // height, so the root comparison is the only check left to object
    const b = singleHopBundle();
    const top = merkleProof.merkle.length - 1;
    const sibling = hexToBytes(merkleProof.merkle[top]);
    sibling[0] ^= 0xff;
    b.hops[0].tx.txidBranch = [...merkleProof.merkle.slice(0, top), bytesToHex(sibling)];
    expect(() => verifyCustodyBundle(b)).toThrow(/does not match header merkle root/);
  });

  // -------------------------------------------------------------------------
  // envelope binding: the txid anchor does not cover the witness
  // -------------------------------------------------------------------------

  /**
   * Re-serialize a transaction with input 0's witness replaced. The stripped
   * serialization is untouched, so the txid is untouched, so every inclusion
   * proof in a bundle still folds. This is the forgery the binding stops.
   */
  function withForgedWitness(tx: ParsedTx, witness: Uint8Array[]): string {
    return bytesToHex(
      serializeFull({
        version: tx.version,
        inputs: tx.inputs.map((inp, i) => (i === 0 ? { ...inp, witness } : inp)),
        outputs: tx.outputs,
        locktime: tx.locktime,
      }),
    );
  }

  it('reports single-leaf assurance for the real inscription 0 reveal', () => {
    const res = verifyCustodyBundle(singleHopBundle());
    expect(res.controlBlockDepth).toBe(0);
    expect(res.singleLeafTree).toBe(true);
  });

  it('rejects a rewritten envelope witness that keeps the txid', () => {
    // a pointer moves the genesis satpoint; the attacker keeps every byte the
    // txid covers and rewrites only the witness the envelope came out of
    const forgedScript = envelopeScript(
      { fields: [[1, 'text/plain'], [2, new Uint8Array([0xdc, 0x05])]], body: ['forged'] },
      { checksigPrefix: true },
    );
    const forgedTap = taprootCommit(forgedScript);
    const forgedHex = withForgedWitness(revealTx, [
      new Uint8Array(64).fill(7),
      forgedScript,
      forgedTap.controlBlock,
    ]);

    // the anchor is untouched: same txid, so the real merkle branch still folds
    expect(parseTx(hexToBytes(forgedHex)).txid).toBe(revealTx.txid);
    expect(parseTx(hexToBytes(forgedHex)).strippedRaw).toEqual(revealTx.strippedRaw);

    const b = singleHopBundle();
    b.hops[0].tx.hex = forgedHex;
    expect(() => verifyCustodyBundle(b)).toThrow(/taproot commitment/);

    // and the honest bundle it was derived from still verifies
    expect(verifyCustodyBundle(singleHopBundle()).genesis.offset).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// envelope index binding: every input before the envelope's is bound too
// ---------------------------------------------------------------------------

describe('envelope index binding (prefix inputs)', () => {
  const SIG = new Uint8Array(64).fill(7);
  const envA = envelopeScript({ fields: [[1, 'text/plain']], body: ['A'] }, { checksigPrefix: true });
  const envB = envelopeScript({ fields: [[1, 'text/plain']], body: ['B'] }, { checksigPrefix: true });
  const tapA = taprootCommit(envA);
  const tapB = taprootCommit(envB);
  // a committed tapscript with no envelope in it, for honest non-envelope inputs
  const plainScript = script(sha256(new TextEncoder().encode('key')), 0xac);
  const tapPlain = taprootCommit(plainScript);

  /** legacy funding tx whose outputs carry chosen scriptPubKeys */
  function fundingTx(
    inputs: { txid: string; vout: number }[],
    outputs: { value: bigint; spk?: Uint8Array }[],
  ): { hex: string; tx: ParsedTx } {
    const parts: Uint8Array[] = [u32le(2), varint(inputs.length)];
    for (const inp of inputs) {
      parts.push(
        hexToBytes(inp.txid).reverse(),
        u32le(inp.vout),
        varint(1),
        new Uint8Array([0x51]),
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

  /** segwit reveal with one witness stack per input */
  function segwitReveal(
    inputs: { txid: string; vout: number; witness: Uint8Array[] }[],
    outputs: bigint[],
  ): { hex: string; tx: ParsedTx } {
    const raw = serializeFull({
      version: 2,
      inputs: inputs.map((i) => ({
        prevTxidLE: hexToBytes(i.txid).reverse(),
        prevTxid: i.txid,
        vout: i.vout,
        scriptSig: new Uint8Array(0),
        sequence: 0xfffffffd,
        witness: i.witness,
      })),
      outputs: outputs.map((value) => ({ value, scriptPubKey: new Uint8Array([0x51]) })),
      locktime: 0,
    });
    return { hex: bytesToHex(raw), tx: parseTx(raw) };
  }

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

  function oneHopBundle(
    reveal: ParsedTx,
    hex: string,
    index: number,
    prevTxs: string[],
    finalSatpoint: string,
  ): CustodyBundleJson {
    const mined = mineSingleTxBlock(reveal.txidLE, new Uint8Array(32));
    return {
      version: 1,
      inscriptionId: `${reveal.txid}i${index}`,
      hops: [
        {
          block: { height: 800_000, hash: mined.hash, header: mined.headerHex, txCount: 1 },
          tx: { hex, pos: 0, txidBranch: [] },
          prevTxs,
        },
      ],
      finalSatpoint,
    };
  }

  it('rejects an envelope moved to another input that reuses the commit script', () => {
    // commit pays the SAME taproot spk twice, so the moved envelope still
    // matches the commitment of whichever input it lands on
    const commit = fundingTx(
      [{ txid: T0, vout: 0 }],
      [
        { value: 10_000n, spk: tapA.scriptPubKey },
        { value: 20_000n, spk: tapA.scriptPubKey },
      ],
    );
    const reveal = segwitReveal(
      [
        { txid: commit.tx.txid, vout: 0, witness: [SIG, envA, tapA.controlBlock] },
        { txid: commit.tx.txid, vout: 1, witness: [SIG] },
      ],
      [25_000n],
    );
    // honest: the envelope may sit on input 0, because there is no prefix
    const honest = oneHopBundle(
      reveal.tx,
      reveal.hex,
      0,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:0`,
    );
    expect(verifyCustodyBundle(honest).genesis.offset).toBe(0n);

    // forged: same txid, witnesses swapped; the genesis satpoint would move
    // by input 0's value if the numbering were trusted
    const moved = withWitnesses(reveal.tx, [[SIG], [SIG, envA, tapA.controlBlock]]);
    expect(moved.txid).toBe(reveal.tx.txid);
    const forged = oneHopBundle(
      moved,
      bytesToHex(moved.raw),
      0,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    expect(() => verifyCustodyBundle(forged)).toThrow(EnvelopeIndexUnprovenError);
    expect(() => verifyCustodyBundle(forged)).toThrow(/input 0/);
  });

  it('rejects a deleted earlier envelope that renumbers the survivor', () => {
    const commit = fundingTx(
      [{ txid: T1, vout: 0 }],
      [
        { value: 10_000n, spk: tapA.scriptPubKey },
        { value: 20_000n, spk: tapB.scriptPubKey },
      ],
    );
    const reveal = segwitReveal(
      [
        { txid: commit.tx.txid, vout: 0, witness: [SIG, envA, tapA.controlBlock] },
        { txid: commit.tx.txid, vout: 1, witness: [SIG, envB, tapB.controlBlock] },
      ],
      [25_000n],
    );
    // honest: both ids resolve, and i1's prefix input is bound at depth 0
    const honest0 = oneHopBundle(
      reveal.tx,
      reveal.hex,
      0,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:0`,
    );
    expect(verifyCustodyBundle(honest0).genesis.offset).toBe(0n);
    const honest1 = oneHopBundle(
      reveal.tx,
      reveal.hex,
      1,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    const res1 = verifyCustodyBundle(honest1);
    expect(res1.genesis.offset).toBe(10_000n);
    expect(res1.controlBlockDepth).toBe(0);
    expect(res1.singleLeafTree).toBe(true);

    // forged: envelope A's witness replaced by a key-path spend, so B would
    // renumber from 1 to 0 and <txid>i0 would resolve to B's sat
    const deleted = withWitnesses(reveal.tx, [[SIG], undefined]);
    expect(deleted.txid).toBe(reveal.tx.txid);
    const forged = oneHopBundle(
      deleted,
      bytesToHex(deleted.raw),
      0,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    expect(() => verifyCustodyBundle(forged)).toThrow(EnvelopeIndexUnprovenError);
    expect(() => verifyCustodyBundle(forged)).toThrow(/input 0/);
  });

  it('rejects an inserted envelope that fabricates an index', () => {
    const commit = fundingTx(
      [{ txid: T2, vout: 0 }],
      [
        { value: 10_000n, spk: tapPlain.scriptPubKey },
        { value: 20_000n, spk: tapB.scriptPubKey },
      ],
    );
    const reveal = segwitReveal(
      [
        { txid: commit.tx.txid, vout: 0, witness: [SIG, plainScript, tapPlain.controlBlock] },
        { txid: commit.tx.txid, vout: 1, witness: [SIG, envB, tapB.controlBlock] },
      ],
      [25_000n],
    );
    // honest: exactly one envelope, numbered 0, on input 1; i1 does not exist
    const honest = oneHopBundle(
      reveal.tx,
      reveal.hex,
      0,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    expect(verifyCustodyBundle(honest).genesis.offset).toBe(10_000n);
    const absent = oneHopBundle(
      reveal.tx,
      reveal.hex,
      1,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    expect(() => verifyCustodyBundle(absent)).toThrow(/index 1 not present/);

    // forged: junk envelope inserted on input 0 renumbers the honest one to
    // index 1; the junk input's commitment cannot verify, and the bundle
    // contradicts chain-committed data, so this is a plain error
    const inserted = withWitnesses(reveal.tx, [[SIG, envA, tapA.controlBlock], undefined]);
    expect(inserted.txid).toBe(reveal.tx.txid);
    const forged = oneHopBundle(
      inserted,
      bytesToHex(inserted.raw),
      1,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    expect(() => verifyCustodyBundle(forged)).toThrow(/input 0 taproot commitment/);
  });

  it('refuses an unbindable prefix input as EnvelopeIndexUnprovenError, not a plain error', () => {
    // input 0 binds correctly but only at control block depth 1, so another
    // committed leaf could carry a different envelope count
    const sibling = sha256(new Uint8Array([2]));
    const tapDeep = taprootCommit(plainScript, [sibling]);
    const commit = fundingTx(
      [{ txid: T0, vout: 1 }],
      [
        { value: 10_000n, spk: tapDeep.scriptPubKey },
        { value: 20_000n, spk: tapB.scriptPubKey },
      ],
    );
    const reveal = segwitReveal(
      [
        { txid: commit.tx.txid, vout: 0, witness: [SIG, plainScript, tapDeep.controlBlock] },
        { txid: commit.tx.txid, vout: 1, witness: [SIG, envB, tapB.controlBlock] },
      ],
      [25_000n],
    );
    const bundle = oneHopBundle(
      reveal.tx,
      reveal.hex,
      0,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    expect(() => verifyCustodyBundle(bundle)).toThrow(EnvelopeIndexUnprovenError);
    expect(() => verifyCustodyBundle(bundle)).toThrow(/merkle depth 1/);
  });

  it('takes the prefix loop zero times on a single-input reveal', () => {
    const commit = fundingTx([{ txid: T1, vout: 1 }], [{ value: 10_000n, spk: tapA.scriptPubKey }]);
    const reveal = segwitReveal(
      [{ txid: commit.tx.txid, vout: 0, witness: [SIG, envA, tapA.controlBlock] }],
      [9_000n],
    );
    const bundle = oneHopBundle(reveal.tx, reveal.hex, 0, [commit.hex], `${reveal.tx.txid}:0:0`);
    const res = verifyCustodyBundle(bundle);
    expect(res.genesis.offset).toBe(0n);
    expect(res.singleLeafTree).toBe(true);
  });
});
