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
  verifyWitnessAnchoring,
  inscriptionsFromTx,
  serializeFull,
  parseHeader,
  buildMerkleBranch,
  computeMerkleRoot,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  ZERO32,
  type CustodyBundleJson,
  type Inscription,
  type ParsedTx,
  hexToBytes,
  bytesToHex,
  sha256,
  sha256d,
  internalToDisplay,
} from '../src/index.js';
import {
  buildBlock,
  envelopeScript,
  script,
  taprootCommit,
  NO_POW_FLOOR,
  type TestBlock,
} from './helpers.js';

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

  /**
   * The document names the inscription whose custody it walks, and every
   * other check reads that claim rather than testing it, so a verification
   * given no expectation says the bundle is self-consistent and says nothing
   * about whose inscription it walked.
   */
  describe('the expected inscription id', () => {
    it('passes when it matches, whatever case it arrives in', () => {
      const b = singleHopBundle();
      expect(verifyCustodyBundle(b, { expectedInscriptionId: b.inscriptionId }).hops).toBe(1);
      // an id that survived URI authority case folding is the same id
      expect(
        verifyCustodyBundle(b, {
          expectedInscriptionId: b.inscriptionId.toUpperCase().replace('I', 'i'),
        }).inscriptionId,
      ).toBe(b.inscriptionId);
    });

    it('refuses a bundle that proves a different inscription', () => {
      const b = singleHopBundle();
      const other = `${'ab'.repeat(32)}i0`;
      expect(() => verifyCustodyBundle(b, { expectedInscriptionId: other })).toThrow(
        /caller asked for/,
      );
      expect(() => verifyCustodyBundle(b, { expectedInscriptionId: other })).toThrow(
        b.inscriptionId,
      );
      // the same txid at another envelope index is another inscription
      expect(() =>
        verifyCustodyBundle(b, { expectedInscriptionId: b.inscriptionId.replace(/i0$/, 'i1') }),
      ).toThrow(/caller asked for/);
    });

    it('is read above the bundle evidence', () => {
      // an empty hop list is the document's own defect, and a bundle for
      // another inscription is the wrong document; the wrong document wins
      const b = singleHopBundle();
      b.hops = [];
      expect(() =>
        verifyCustodyBundle(b, { expectedInscriptionId: `${'ab'.repeat(32)}i0` }),
      ).toThrow(/caller asked for/);
      expect(() => verifyCustodyBundle(b)).toThrow(/custody bundle has no hops/);
    });

    it('names the caller argument when the caller argument is the malformed one', () => {
      expect(() =>
        verifyCustodyBundle(singleHopBundle(), { expectedInscriptionId: 'nonsense' }),
      ).toThrow(/expectedInscriptionId: invalid inscription id/);
    });
  });

  it('rejects a wrong claimed final satpoint', () => {
    const b = singleHopBundle();
    b.finalSatpoint = `${expected.revealTxid}:0:1`;
    expect(() => verifyCustodyBundle(b)).toThrow(/path folds to/);
  });

  it('refuses a string hop height, and verifies the numeric one', () => {
    // a bundle is untrusted JSON, so "height": "200" reaches the comparisons
    // that coerce and the report a --json consumer reads as a number
    const b = singleHopBundle();
    (b.hops[0].block as unknown as Record<string, unknown>).height = String(expected.blockHeight);
    expect(() => verifyCustodyBundle(b)).toThrow(/hop 0 \(reveal\): missing valid block height/);
    expect(verifyCustodyBundle(singleHopBundle()).height).toBe(expected.blockHeight);
  });

  it('names one-level-down absences on the reveal hop instead of surfacing TypeErrors', () => {
    const cases: [string[], string][] = [
      [['block'], 'hop 0 (reveal): missing valid block section'],
      [['tx'], 'hop 0 (reveal): missing valid tx section'],
      [['block', 'header'], 'hop 0 (reveal): missing valid block header'],
      [['block', 'hash'], 'hop 0 (reveal): missing valid block hash'],
      [['tx', 'hex'], 'hop 0 (reveal): missing valid tx hex'],
      [['tx', 'txidBranch'], 'hop 0 (reveal): missing valid txid branch'],
      [['prevTxs'], 'hop 0 (reveal): prevTxs is not a list'],
    ];
    for (const [path, message] of cases) {
      const b = singleHopBundle();
      let o = b.hops[0] as unknown as Record<string, unknown>;
      for (const p of path.slice(0, -1)) o = o[p] as Record<string, unknown>;
      delete o[path[path.length - 1]];
      let err: Error | undefined;
      try {
        verifyCustodyBundle(b);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message, path.join('.')).toBe(message);
      expect(err?.message).not.toContain('is not a function');
      expect(err?.message).not.toContain("reading '");
    }
    // an element that is not an object at all is the same defect one step up
    const b = singleHopBundle();
    (b.hops as unknown as unknown[])[0] = null;
    expect(() => verifyCustodyBundle(b)).toThrow('hop 0 (reveal): missing valid hop object');
  });

  it('names a prev tx entry of the wrong type instead of surfacing a TypeError', () => {
    // the list's shape is checked and its elements were not, so an entry that
    // is not a string reached .trim() outside any catch. The document is still
    // refused either way; what moved is whether the reason names the entry or
    // reads as a fault in the verifier
    for (const value of [123, null, {}, [], true] as unknown[]) {
      const b = singleHopBundle();
      (b.hops[0].prevTxs as unknown[])[0] = value;
      let err: Error | undefined;
      try {
        verifyCustodyBundle(b);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message, JSON.stringify(value)).toMatch(
        /^hop 0 \(reveal\): prev tx for envelope input 0 is not a hex string \(got /,
      );
      expect(err?.message).not.toContain('is not a function');
      expect(err?.message).not.toContain("reading '");
    }
    // the type is named in words, because typeof answers "object" for the two
    // shapes a hand-written bundle is most likely to hold here
    const withNull = singleHopBundle();
    (withNull.hops[0].prevTxs as unknown[])[0] = null;
    expect(() => verifyCustodyBundle(withNull)).toThrow(/\(got null\)/);
    const withArray = singleHopBundle();
    (withArray.hops[0].prevTxs as unknown[])[0] = [commitHex];
    expect(() => verifyCustodyBundle(withArray)).toThrow(/\(got an array\)/);
    // an absent entry keeps its own message, which says what is missing
    const absent = singleHopBundle();
    absent.hops[0].prevTxs = [];
    expect(() => verifyCustodyBundle(absent)).toThrow(
      'hop 0 (reveal): no prev tx for envelope input 0, so its commitment cannot be checked',
    );
  });

  it('names the same entry through provenInputValues, the other reader', () => {
    // the envelope binding reads the envelope input's entry alone, so an entry
    // at another index reaches the value walk instead. Its parse catches its
    // own failures, so the TypeError arrived inside a "cannot parse" message
    const tx = parseTx(hexToBytes(revealHex));
    let err: Error | undefined;
    try {
      provenInputValues(tx, [123 as unknown as string], 0);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe('prev tx 0 is not a hex string (got a number)');
    expect(err?.message).not.toContain('is not a function');
    // and the honest list still proves the value
    expect(provenInputValues(tx, [commitHex], 0).length).toBe(1);
  });

  it('names the same absences on a later hop through the walk', () => {
    const outValue = revealTx.outputs[0].value;
    const spend = buildTx([{ txid: revealTx.txid, vout: 0 }], [outValue - 200n]);
    const mined = mineSingleTxBlock(spend.tx.txidLE, new Uint8Array(32));
    function twoHop(): CustodyBundleJson {
      const b = singleHopBundle();
      b.hops.push({
        block: { height: expected.blockHeight + 10, hash: mined.hash, header: mined.headerHex, txCount: 1 },
        tx: { hex: spend.hex, pos: 0, txidBranch: [] },
        prevTxs: [revealHex],
      });
      b.finalSatpoint = `${spend.tx.txid}:0:0`;
      return b;
    }
    const cases: [string[], string][] = [
      [['block'], 'hop 1: missing valid block section'],
      [['tx'], 'hop 1: missing valid tx section'],
      [['block', 'header'], 'hop 1: missing valid block header'],
      [['block', 'hash'], 'hop 1: missing valid block hash'],
      [['tx', 'hex'], 'hop 1: missing valid tx hex'],
      [['tx', 'txidBranch'], 'hop 1: missing valid txid branch'],
      [['prevTxs'], 'hop 1: prevTxs is not a list'],
    ];
    for (const [path, message] of cases) {
      const b = twoHop();
      let o = b.hops[1] as unknown as Record<string, unknown>;
      for (const p of path.slice(0, -1)) o = o[p] as Record<string, unknown>;
      delete o[path[path.length - 1]];
      let err: Error | undefined;
      try {
        verifyCustodyBundle(b, NO_POW_FLOOR);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message, path.join('.')).toBe(message);
      expect(err?.message).not.toContain('is not a function');
      expect(err?.message).not.toContain("reading '");
    }
    const b = twoHop();
    (b.hops as unknown as unknown[])[1] = null;
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow('hop 1: missing valid hop object');
  });

  it('refuses a bundle without inscriptionId by naming the field', () => {
    const b = singleHopBundle() as unknown as Record<string, unknown>;
    delete b.inscriptionId;
    let err: Error | undefined;
    try {
      verifyCustodyBundle(b as unknown as CustodyBundleJson);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe('bundle field inscriptionId is missing or not a string');
  });

  it('refuses a reveal prev tx list longer than the input count', () => {
    // the list is aligned to the inputs, so an entry past the input count
    // corresponds to nothing; refused rather than ignored, per SPEC-CUSTODY
    const b = singleHopBundle();
    b.hops[0].prevTxs.push(commitHex);
    expect(() => verifyCustodyBundle(b)).toThrow(
      /hop 0 \(reveal\): 2 prev txs supplied for 1 input/,
    );
  });

  it('refuses the same surplus on a later hop', () => {
    const outValue = revealTx.outputs[0].value;
    const spend = buildTx([{ txid: revealTx.txid, vout: 0 }], [outValue - 200n]);
    const mined = mineSingleTxBlock(spend.tx.txidLE, new Uint8Array(32));
    const bundle = singleHopBundle();
    bundle.hops.push({
      block: { height: expected.blockHeight + 10, hash: mined.hash, header: mined.headerHex, txCount: 1 },
      tx: { hex: spend.hex, pos: 0, txidBranch: [] },
      prevTxs: [revealHex, revealHex],
    });
    bundle.finalSatpoint = `${spend.tx.txid}:0:0`;
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(
      /hop 1: 2 prev txs supplied for 1 input/,
    );
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
    const res = verifyCustodyBundle(bundle, NO_POW_FLOOR);
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
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(/chain order/);
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
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(CustodyUnsupportedError);
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
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(/duplicate transaction/);
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
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(CustodyUnsupportedError);
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(/coinbase/);
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
    expect(res.singleInputReveal).toBe(true);
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
// shared fixtures for envelope index binding and wtxid anchoring
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// envelope index binding: a multi-input reveal needs the block's witness
// commitment, because control block depth 0 proves commitment and not
// execution
// ---------------------------------------------------------------------------

describe('envelope index binding (multi-input reveals)', () => {
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

  it('refuses a multi-input reveal that carries no witness section', () => {
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
    const bundle = oneHopBundle(
      reveal.tx,
      reveal.hex,
      1,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(EnvelopeIndexUnprovenError);
    // the message names the input count, the requested index, and the cause
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(/reveal spends 2 inputs/);
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(/any envelope index 1/);
    expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(/no witness section/);
  });

  it('refuses the key-path prefix forgery the prefix rule used to accept', () => {
    // on chain: input 0 spends tapA by KEY path, so ord sees no envelope
    // there and envB on input 1 is index 0. tapA's author committed the leaf,
    // so they can serve a script-path witness that binds at depth 0 anyway.
    const commit = fundingTx(
      [{ txid: T2, vout: 0 }],
      [
        { value: 10_000n, spk: tapA.scriptPubKey },
        { value: 20_000n, spk: tapB.scriptPubKey },
      ],
    );
    const reveal = segwitReveal(
      [
        { txid: commit.tx.txid, vout: 0, witness: [SIG] },
        { txid: commit.tx.txid, vout: 1, witness: [SIG, envB, tapB.controlBlock] },
      ],
      [25_000n],
    );
    const forgedTx = withWitnesses(reveal.tx, [[SIG, envA, tapA.controlBlock], undefined]);
    expect(forgedTx.txid).toBe(reveal.tx.txid);
    // the forgery puts envA at index 0, moving genesis from offset 10,000 to 0
    expect(inscriptionsFromTx(forgedTx).map((i) => i.input)).toEqual([0, 1]);

    // both are refused now, honest and forged alike, for want of a section
    for (const tx of [reveal.tx, forgedTx]) {
      const bundle = oneHopBundle(
        tx,
        bytesToHex(tx.raw),
        0,
        [commit.hex, commit.hex],
        `${reveal.tx.txid}:0:10000`,
      );
      expect(() => verifyCustodyBundle(bundle, NO_POW_FLOOR)).toThrow(EnvelopeIndexUnprovenError);
    }

    // with the block's witness commitment the honest reveal verifies and the
    // forgery does not, because the wtxid covers the witness bytes themselves
    const blk = buildBlock([reveal.tx]);
    const anchored = (hex: string, finalSatpoint: string): CustodyBundleJson => ({
      version: 1,
      inscriptionId: `${reveal.tx.txid}i0`,
      hops: [
        {
          block: { height: 800_000, hash: blk.blockHash, header: blk.headerHex, txCount: blk.txCount },
          tx: { hex, pos: 1, txidBranch: blk.txidBranch(1) },
          prevTxs: [commit.hex, commit.hex],
          witness: {
            coinbaseHex: bytesToHex(blk.txs[0].raw),
            coinbaseTxidBranch: blk.txidBranch(0),
            wtxidBranch: blk.wtxidBranch(1),
          },
        },
      ],
      finalSatpoint,
    });
    const res = verifyCustodyBundle(anchored(reveal.hex, `${reveal.tx.txid}:0:10000`), NO_POW_FLOOR);
    expect(res.indexProof).toBe('wtxid');
    expect(res.genesis.offset).toBe(10_000n);
    expect(() =>
      verifyCustodyBundle(anchored(bytesToHex(forgedTx.raw), `${reveal.tx.txid}:0:0`), NO_POW_FLOOR),
    ).toThrow(/witness commitment mismatch/);
  });

  it('verifies a single-input reveal with no witness section', () => {
    const commit = fundingTx([{ txid: T1, vout: 1 }], [{ value: 10_000n, spk: tapA.scriptPubKey }]);
    const reveal = segwitReveal(
      [{ txid: commit.tx.txid, vout: 0, witness: [SIG, envA, tapA.controlBlock] }],
      [9_000n],
    );
    const bundle = oneHopBundle(reveal.tx, reveal.hex, 0, [commit.hex], `${reveal.tx.txid}:0:0`);
    const res = verifyCustodyBundle(bundle, NO_POW_FLOOR);
    expect(res.genesis.offset).toBe(0n);
    expect(res.singleLeafTree).toBe(true);
    expect(res.singleInputReveal).toBe(true);
    expect(res.indexProof).toBe('single-input');
  });
});

// ---------------------------------------------------------------------------
// wtxid anchoring: the witness commitment pins numbering on multi-input reveals
// ---------------------------------------------------------------------------

describe('wtxid-anchored reveals (custody)', () => {
  // batch reveal: envelope A on input 0, envelope B on input 1, each
  // committed by its own prevout
  const commit = fundingTx(
    [{ txid: T0, vout: 3 }],
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
  const block = buildBlock([reveal.tx]);

  // the pointer-bundle shape: key-path funding input ahead of the envelope
  const commitKey = fundingTx(
    [{ txid: T1, vout: 3 }],
    [
      { value: 10_000n },
      { value: 20_000n, spk: tapB.scriptPubKey },
    ],
  );
  const revealKey = segwitReveal(
    [
      { txid: commitKey.tx.txid, vout: 0, witness: [SIG] },
      { txid: commitKey.tx.txid, vout: 1, witness: [SIG, envB, tapB.controlBlock] },
    ],
    [25_000n],
  );
  const blockKey = buildBlock([revealKey.tx]);

  function wtxidBundle(
    blk: TestBlock,
    revealHex: string,
    index: number,
    prevTxs: string[],
    finalSatpoint: string,
  ): CustodyBundleJson {
    const revealPos = 1;
    return {
      version: 1,
      inscriptionId: `${blk.txs[revealPos].txid}i${index}`,
      hops: [
        {
          block: { height: 800_000, hash: blk.blockHash, header: blk.headerHex, txCount: blk.txCount },
          tx: { hex: revealHex, pos: revealPos, txidBranch: blk.txidBranch(revealPos) },
          prevTxs,
          witness: {
            coinbaseHex: bytesToHex(blk.txs[0].raw),
            coinbaseTxidBranch: blk.txidBranch(0),
            wtxidBranch: blk.wtxidBranch(revealPos),
          },
        },
      ],
      finalSatpoint,
    };
  }

  it('refuses a header easier than the proof-of-work floor by default', () => {
    const bundle = wtxidBundle(
      block,
      reveal.hex,
      1,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    // hop 0's merkle proof folds and the header satisfies its own target; the
    // floor is what says that target cost nothing
    expect(() => verifyCustodyBundle(bundle)).toThrow(/hop 0 \(reveal\): target/);
    expect(() => verifyCustodyBundle(bundle)).toThrow(/proof-of-work limit 0x1d00ffff/);
    expect(verifyCustodyBundle(bundle, { powLimitBits: 0x207fffff }).indexProof).toBe('wtxid');
    expect(verifyCustodyBundle(bundle, NO_POW_FLOOR).indexProof).toBe('wtxid');
  });

  it('verifies an honest witness-anchored multi-input bundle, and refuses it without the section', () => {
    const withSection = wtxidBundle(
      block,
      reveal.hex,
      1,
      [commit.hex, commit.hex],
      `${reveal.tx.txid}:0:10000`,
    );
    const res = verifyCustodyBundle(withSection, NO_POW_FLOOR);
    expect(res.indexProof).toBe('wtxid');
    expect(res.genesis.offset).toBe(10_000n);
    expect(res.controlBlockDepth).toBe(0);
    expect(res.singleLeafTree).toBe(true);
    expect(res.singleInputReveal).toBe(false);

    const noSection = wtxidBundle(block, reveal.hex, 1, [commit.hex, commit.hex], `${reveal.tx.txid}:0:10000`);
    delete noSection.hops[0].witness;
    expect(() => verifyCustodyBundle(noSection, NO_POW_FLOOR)).toThrow(EnvelopeIndexUnprovenError);
  });

  it('refuses an absent index before claiming how many envelopes there are', () => {
    // the reveal carries two envelopes, and index 7 is in neither. With no
    // witness section the count itself is unproven, so reporting "index 7 not
    // present" would assert a count the bundle cannot support
    const noSection = wtxidBundle(block, reveal.hex, 7, [commit.hex, commit.hex], `${reveal.tx.txid}:0:10000`);
    delete noSection.hops[0].witness;
    expect(() => verifyCustodyBundle(noSection, NO_POW_FLOOR)).toThrow(EnvelopeIndexUnprovenError);
    expect(() => verifyCustodyBundle(noSection, NO_POW_FLOOR)).toThrow(/any envelope index 7/);
    expect(() => verifyCustodyBundle(noSection, NO_POW_FLOOR)).not.toThrow(/not present/);

    // with the section the count IS proven, so the old message is supportable
    const withSection = wtxidBundle(block, reveal.hex, 7, [commit.hex, commit.hex], `${reveal.tx.txid}:0:10000`);
    expect(() => verifyCustodyBundle(withSection, NO_POW_FLOOR)).toThrow(
      /contains 2 envelope\(s\); index 7 not present/,
    );
  });

  it('proves the index of a reveal whose earlier input is a key-path spend', () => {
    // without a witness section this reveal is refused as unprovable; the
    // wtxid anchoring is exactly what closes it
    const noSection = wtxidBundle(
      blockKey,
      revealKey.hex,
      0,
      [commitKey.hex, commitKey.hex],
      `${revealKey.tx.txid}:0:10000`,
    );
    delete noSection.hops[0].witness;
    expect(() => verifyCustodyBundle(noSection, NO_POW_FLOOR)).toThrow(EnvelopeIndexUnprovenError);

    const withSection = wtxidBundle(
      blockKey,
      revealKey.hex,
      0,
      [commitKey.hex, commitKey.hex],
      `${revealKey.tx.txid}:0:10000`,
    );
    const res = verifyCustodyBundle(withSection, NO_POW_FLOOR);
    expect(res.indexProof).toBe('wtxid');
    expect(res.genesis.offset).toBe(10_000n);
  });

  it('rejects all three witness rewrites against the block commitment', () => {
    // moving the envelope, deleting a prefix envelope, and inserting one all
    // change some input's witness, so the committed wtxid no longer matches
    const rewrites: (Uint8Array[] | undefined)[][] = [
      [[SIG], [SIG, envA, tapA.controlBlock]], // move A onto input 1
      [[SIG], undefined], // delete A, renumbering B
      [[SIG, plainScript, tapPlain.controlBlock], undefined], // insert junk on input 0
    ];
    for (const witnesses of rewrites) {
      const forged = withWitnesses(reveal.tx, witnesses);
      expect(forged.txid).toBe(reveal.tx.txid);
      const b = wtxidBundle(
        block,
        bytesToHex(forged.raw),
        1,
        [commit.hex, commit.hex],
        `${reveal.tx.txid}:0:10000`,
      );
      expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(/witness commitment mismatch/);
    }
  });

  it('rejects forged witness sections with the shared function messages', () => {
    const base = () =>
      wtxidBundle(block, reveal.hex, 1, [commit.hex, commit.hex], `${reveal.tx.txid}:0:10000`);

    const notCoinbase = base();
    notCoinbase.hops[0].witness!.coinbaseHex = reveal.hex;
    expect(() => verifyCustodyBundle(notCoinbase, NO_POW_FLOOR)).toThrow(/not a coinbase transaction/);

    const badCbDepth = base();
    badCbDepth.hops[0].witness!.coinbaseTxidBranch = [
      ...badCbDepth.hops[0].witness!.coinbaseTxidBranch,
      '11'.repeat(32),
    ];
    expect(() => verifyCustodyBundle(badCbDepth, NO_POW_FLOOR)).toThrow(/coinbase branch depth/);

    const badWtxidDepth = base();
    badWtxidDepth.hops[0].witness!.wtxidBranch = [
      ...badWtxidDepth.hops[0].witness!.wtxidBranch,
      '11'.repeat(32),
    ];
    expect(() => verifyCustodyBundle(badWtxidDepth, NO_POW_FLOOR)).toThrow(/wtxid branch depth/);

    // tampering the reserved value leaves the coinbase's txid intact but
    // changes the commitment preimage
    const cb = block.txs[0];
    const tampered = parseTx(
      serializeFull({
        version: cb.version,
        inputs: [{ ...cb.inputs[0], witness: [sha256(new Uint8Array([9]))] }],
        outputs: cb.outputs,
        locktime: cb.locktime,
      }),
    );
    expect(tampered.txid).toBe(cb.txid);
    const badReserved = base();
    badReserved.hops[0].witness!.coinbaseHex = bytesToHex(tampered.raw);
    expect(() => verifyCustodyBundle(badReserved, NO_POW_FLOOR)).toThrow(/witness commitment mismatch/);
  });

  it('refuses witness: null on the reveal as a bad section, not a TypeError', () => {
    // null passes the presence guard, which reads !== undefined, so the shape
    // check is what has to name the section rather than a property of null
    const b = wtxidBundle(block, reveal.hex, 1, [commit.hex, commit.hex], `${reveal.tx.txid}:0:10000`);
    (b.hops[0] as { witness?: unknown }).witness = null;
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(
      /witness section: must be a non-null object/,
    );
  });

  it('rejects a coinbase with no commitment output through the shared function', () => {
    // a block whose coinbase carries no witness commitment cannot anchor any
    // witness; built by hand because the block helper always commits
    const bare = parseTx(
      serializeFull({
        version: 1,
        inputs: [
          {
            prevTxidLE: new Uint8Array(32),
            prevTxid: '0'.repeat(64),
            vout: 0xffffffff,
            scriptSig: new Uint8Array([0x03, 0x01, 0x02, 0x03]),
            sequence: 0xffffffff,
            witness: [sha256(new TextEncoder().encode('reserved'))],
          },
        ],
        outputs: [{ value: 312_500_000n, scriptPubKey: new Uint8Array([0x51]) }],
        locktime: 0,
      }),
    );
    const txids = [bare.txidLE, reveal.tx.txidLE];
    const headerRaw = new Uint8Array(80);
    headerRaw.set(computeMerkleRoot(txids), 36);
    expect(() =>
      verifyWitnessAnchoring({
        witness: {
          coinbaseHex: bytesToHex(bare.raw),
          coinbaseTxidBranch: buildMerkleBranch(txids, 0).map(internalToDisplay),
          wtxidBranch: buildMerkleBranch([ZERO32, reveal.tx.wtxidLE], 1).map(internalToDisplay),
        },
        header: parseHeader(headerRaw),
        txCount: 2,
        reveal: reveal.tx,
        pos: 1,
      }),
    ).toThrow(/no BIP-141 witness commitment output/);
  });

  it('refuses a witness section on a later custody hop', () => {
    const b = wtxidBundle(block, reveal.hex, 1, [commit.hex, commit.hex], `${reveal.tx.txid}:0:10000`);
    const spend = fundingTx([{ txid: reveal.tx.txid, vout: 0 }], [{ value: 24_000n }]);
    const mined = mineSingleTxBlock(spend.tx.txidLE, new Uint8Array(32));
    b.hops.push({
      block: { height: 800_010, hash: mined.hash, header: mined.headerHex, txCount: 1 },
      tx: { hex: spend.hex, pos: 0, txidBranch: [] },
      prevTxs: [reveal.hex],
      witness: { coinbaseHex: '00', coinbaseTxidBranch: [], wtxidBranch: [] },
    });
    b.finalSatpoint = `${spend.tx.txid}:0:10000`;
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(/witness section is only accepted at the reveal/);
  });

  it('refuses a falsy witness value on a later hop', () => {
    // untrusted JSON can carry `"witness": 0`, which is falsy and carries no
    // data; the rule is stated without exception, so presence is what counts
    for (const value of [0, '', false, null]) {
      const b = wtxidBundle(block, reveal.hex, 1, [commit.hex, commit.hex], `${reveal.tx.txid}:0:10000`);
      const spend = fundingTx([{ txid: reveal.tx.txid, vout: 0 }], [{ value: 24_000n }]);
      const mined = mineSingleTxBlock(spend.tx.txidLE, new Uint8Array(32));
      b.hops.push({
        block: { height: 800_010, hash: mined.hash, header: mined.headerHex, txCount: 1 },
        tx: { hex: spend.hex, pos: 0, txidBranch: [] },
        prevTxs: [reveal.hex],
        witness: value as never,
      });
      b.finalSatpoint = `${spend.tx.txid}:0:10000`;
      expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(
        /hop 1: witness section is only accepted at the reveal/,
      );
    }
  });
});
