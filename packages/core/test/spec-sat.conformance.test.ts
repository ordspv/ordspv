/**
 * Conformance suite for SPEC-SAT.md: one test per normative sentence, named
 * for the sentence it speaks for.
 *
 * The accounting table is `spec-sat.rows.ts`, shared with
 * `packages/fetch/test/spec-sat.builder.test.ts`, which drives the rows whose
 * code lives in @ordspv/fetch. The accounting test at the bottom of this file
 * sums the WHOLE spec against every row in that table, whichever file drives
 * it, so a requirement added to the spec fails this suite until somebody
 * accounts for it and a row cannot be lost between the two files.
 *
 * Duplication with satnumber.test.ts is deliberate. That file covers many of
 * these behaviours and covers them harder; the job here is traceability from
 * the sentence to a test, so a thin re-assertion is the normal case and a
 * `tested at` row is for where a thin one would be disproportionate.
 *
 * Every fixture is a whole chain, coinbase to reveal, built from the shared
 * builders in `helpers.ts`. A genealogy verifier reads the reveal, the funding
 * chain and the terminal coinbase in that order, so most rules are only
 * reachable behind a chain that walks.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  SatFundingIncompleteError,
  SatPositionError,
  SatStepLimitError,
  bytesToHex,
  checkProofOfWork,
  firstSatOfBlock,
  hexToBytes,
  internalToDisplay,
  inscriptionsFromTx,
  parseHeader,
  parseTx,
  satName,
  satRarity,
  serializeFull,
  sha256d,
  subsidySats,
  verifyEnvelopeBinding,
  verifySatGenealogy,
  type CustodyHopJson,
  type ParsedTx,
  type SatGenealogyBundleJson,
} from '../src/index.js';
import {
  NO_POW_FLOOR,
  anchoredHop,
  buildBlock,
  buildCoinbase,
  buildSegwitTx,
  buildTx,
  dummyTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type OutSpec,
  type TestBlock,
} from './helpers.js';
import { ROOT, SPEC, TABLE, anchor, drivenIdsFor, idsFor, row } from './spec-sat.rows.js';

// ---------------------------------------------------------------------------
// the test wrapper
// ---------------------------------------------------------------------------

/** ids this file speaks for, compared against the table at the bottom */
const SPOKEN: string[] = [];

/**
 * One conformance test. The quote anchor runs first, so a reworded spec
 * sentence fails here and names itself instead of leaving a green test
 * asserting a rule the spec no longer states.
 */
function conformance(id: string, body: () => void | Promise<void>): void {
  const r = row(id);
  if (r.file !== 'core') throw new Error(`row ${id} is assigned to the ${r.file} file`);
  SPOKEN.push(id);
  it(`SPEC-SAT.md ${r.section}: ${r.title}`, async () => {
    anchor(r.quote);
    await body();
  });
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * Every synthetic block here is mined at regtest difficulty, which the default
 * proof-of-work floor refuses, and every terminal coinbase below 230,000 needs
 * its height attested. The hook stands in for a caller that checked the block
 * hash at that height. Both refusals have rows of their own.
 */
const ATTESTS = { ...NO_POW_FLOOR, trustHeader: (): 'hash-at-height' => 'hash-at-height' };

const SIG = new Uint8Array(64).fill(7);
const ENV = envelopeScript({ fields: [[1, 'text/plain']], body: ['sat'] }, { checksigPrefix: true });
const TAP = taprootCommit(ENV);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

interface Chain {
  coinbase: { hex: string; tx: ParsedTx };
  funding: { hex: string; tx: ParsedTx };
  commit: { hex: string; tx: ParsedTx };
  reveal: ParsedTx;
  height: number;
  /** the sat the walk folds to, when the chain is one that folds */
  sat: bigint;
  bundle(): SatGenealogyBundleJson;
}

/**
 * coinbase -> funding -> commit -> reveal, one input at every step.
 *
 * The reveal spends the commit at offset 0, so the traced position walks to
 * the first sat of the coinbase's SECOND output, which is `outputs[0].value`
 * in the coinbase's sat space. Moving that one number moves the answer, and
 * moving it across `subsidy(height)` moves it into the fee tail.
 */
function singleChain(spec: {
  outputs: OutSpec[];
  height: number;
  scriptSig?: Uint8Array;
  /** the leaf the commit output commits to; defaults to the plain envelope */
  leaf?: { script: Uint8Array; commit: { scriptPubKey: Uint8Array; controlBlock: Uint8Array } };
  /** what the commit pays the reveal; zero is the unbound case */
  commitValue?: bigint;
  /** a commit output that is not the taproot one, for the non-P2TR case */
  commitSpk?: Uint8Array;
}): Chain {
  const leaf = spec.leaf ?? { script: ENV, commit: TAP };
  const coinbase = buildCoinbase(spec.outputs, spec.scriptSig);
  const spend = spec.outputs[1].value;
  const funding = buildTx(
    [{ txid: coinbase.tx.txid, vout: 1 }],
    [{ value: spend - 10_000n }, { value: 10_000n }],
  );
  const commit = buildTx(
    [{ txid: funding.tx.txid, vout: 0 }],
    [{ value: spec.commitValue ?? 10_000n, spk: spec.commitSpk ?? leaf.commit.scriptPubKey }],
  );
  const reveal = revealTx([{ script: leaf.script, controlBlock: leaf.commit.controlBlock }], {
    prevTxidLE: commit.tx.txidLE,
    vout: 0,
  });
  const sat = firstSatOfBlock(spec.height) + spec.outputs[0].value;
  return {
    coinbase,
    funding,
    commit,
    reveal,
    height: spec.height,
    sat,
    bundle: () => ({
      version: 1,
      inscriptionId: `${reveal.txid}i0`,
      reveal: anchoredHop(reveal.txidLE, bytesToHex(reveal.raw), spec.height + 1000, [commit.hex]),
      funding: [
        { tx: { hex: commit.hex }, prevTxs: [funding.hex] },
        { tx: { hex: funding.hex }, prevTxs: [coinbase.hex] },
      ],
      coinbase: anchoredHop(coinbase.tx.txidLE, coinbase.hex, spec.height, []),
      claimedSat: sat.toString(),
    }),
  };
}

const HEIGHT = 1000;
const SUBSIDY = subsidySats(HEIGHT);

/** the ordinary case, and the chain most rows are driven on */
const SINGLE = singleChain({ outputs: [{ value: 3_000_000_000n }, { value: 2_000_000_000n }], height: HEIGHT });

/** the last position inside the subsidy, and the first one past it */
const AT_SUBSIDY_EDGE = singleChain({
  outputs: [{ value: SUBSIDY - 1n }, { value: 2_000_000_000n }],
  height: HEIGHT,
});
const IN_FEE_TAIL = singleChain({
  outputs: [{ value: SUBSIDY }, { value: 2_000_000_000n }],
  height: HEIGHT,
});

/** at or above the BIP34 boundary: 240,000 is 0x03a980, pushed little-endian */
const HIGH_HEIGHT = 240_000;
const HIGH_OUTPUTS = [{ value: 1_000_000_000n }, { value: 1_000_000_000n }];
const HIGH = singleChain({
  outputs: HIGH_OUTPUTS,
  height: HIGH_HEIGHT,
  scriptSig: new Uint8Array([0x03, 0x80, 0xa9, 0x03]),
});
/** the same block height with a scriptSig that is not a height push at all */
const HIGH_NO_PUSH = singleChain({ outputs: HIGH_OUTPUTS, height: HIGH_HEIGHT });
/** and one whose push says 240,001 */
const HIGH_WRONG_PUSH = singleChain({
  outputs: HIGH_OUTPUTS,
  height: HIGH_HEIGHT,
  scriptSig: new Uint8Array([0x03, 0x81, 0xa9, 0x03]),
});

/** zero-value envelope input: unbound, with no chain location to trace */
const UNBOUND_ZERO = singleChain({
  outputs: [{ value: 3_000_000_000n }, { value: 2_000_000_000n }],
  height: HEIGHT,
  commitValue: 0n,
});

/** an unrecognized even field: ord's other unbound condition */
const EVEN_FIELD = envelopeScript(
  { fields: [[1, 'text/plain'], [0x16, 'unrecognized and even']], body: ['sat'] },
  { checksigPrefix: true },
);
const EVEN_TAP = taprootCommit(EVEN_FIELD);
const UNBOUND_EVEN = singleChain({
  outputs: [{ value: 3_000_000_000n }, { value: 2_000_000_000n }],
  height: HEIGHT,
  leaf: { script: EVEN_FIELD, commit: EVEN_TAP },
});

/** the envelope input spends a bare script, which commits to no tapscript */
const BARE_COMMIT = singleChain({
  outputs: [{ value: 3_000_000_000n }, { value: 2_000_000_000n }],
  height: HEIGHT,
  commitSpk: new Uint8Array([0x51]),
});

interface PairChain {
  cb: { hex: string; tx: ParsedTx };
  commit: { hex: string; tx: ParsedTx };
  reveal: { hex: string; tx: ParsedTx };
  block: TestBlock;
  bundle(index: number, claimedSat: bigint): SatGenealogyBundleJson;
}

/**
 * coinbase -> commit (two outputs) -> reveal (two inputs), the reveal mined
 * into a block of its own so the bundle can carry the wtxid section a
 * multi-input reveal needs to prove its numbering.
 */
function pairChain(spec: {
  commitOutputs: [OutSpec, OutSpec];
  witnesses: [Uint8Array[], Uint8Array[]];
  revealOutputs: OutSpec[];
}): PairChain {
  const cb = buildCoinbase([{ value: 3_000_000_000n }]);
  const commit = buildTx([{ txid: cb.tx.txid, vout: 0 }], spec.commitOutputs);
  const reveal = buildSegwitTx(
    [
      { txid: commit.tx.txid, vout: 0, witness: spec.witnesses[0] },
      { txid: commit.tx.txid, vout: 1, witness: spec.witnesses[1] },
    ],
    spec.revealOutputs,
  );
  const block = buildBlock([reveal.tx]);
  return {
    cb,
    commit,
    reveal,
    block,
    bundle: (index, claimedSat) => ({
      version: 1,
      inscriptionId: `${reveal.tx.txid}i${index}`,
      reveal: {
        block: {
          height: 2000,
          hash: block.blockHash,
          header: block.headerHex,
          txCount: block.txCount,
        },
        tx: { hex: reveal.hex, pos: 1, txidBranch: block.txidBranch(1) },
        prevTxs: [commit.hex, commit.hex],
        witness: {
          coinbaseHex: bytesToHex(block.txs[0].raw),
          coinbaseTxidBranch: block.txidBranch(0),
          wtxidBranch: block.wtxidBranch(1),
        },
      },
      funding: [{ tx: { hex: commit.hex }, prevTxs: [cb.hex] }],
      coinbase: anchoredHop(cb.tx.txidLE, cb.hex, HEIGHT, []),
      claimedSat: claimedSat.toString(),
    }),
  };
}

/**
 * SINGLE's reveal mined into a real block, so a witness section can be built
 * for it at all. A single-input reveal proves its own numbering with no
 * section, which is what makes it the fixture for "no fallback": the path a
 * verifier would fall back to is one that succeeds.
 */
// The reveal sits at position 2 of an even-width level, so neither the
// position-1 zeroed-sibling rule nor the odd-width self-pair rule is what
// refuses a broken section here: the fold itself is.
const SINGLE_BLOCK = buildBlock([dummyTx(), SINGLE.reveal, dummyTx()]);
const SINGLE_AT = 2;

function singleInBlock(witness?: 'honest' | 'broken'): SatGenealogyBundleJson {
  const b = SINGLE.bundle();
  b.reveal = {
    block: {
      height: HEIGHT + 1000,
      hash: SINGLE_BLOCK.blockHash,
      header: SINGLE_BLOCK.headerHex,
      txCount: SINGLE_BLOCK.txCount,
    },
    tx: {
      hex: bytesToHex(SINGLE.reveal.raw),
      pos: SINGLE_AT,
      txidBranch: SINGLE_BLOCK.txidBranch(SINGLE_AT),
    },
    prevTxs: [SINGLE.commit.hex],
  };
  if (witness !== undefined) {
    b.reveal.witness = {
      coinbaseHex: bytesToHex(SINGLE_BLOCK.txs[0].raw),
      coinbaseTxidBranch: SINGLE_BLOCK.txidBranch(0),
      // the txid branch is the right depth and the wrong tree, so the section
      // fails at the fold rather than at a shape check
      wtxidBranch:
        witness === 'honest'
          ? SINGLE_BLOCK.wtxidBranch(SINGLE_AT)
          : SINGLE_BLOCK.txidBranch(SINGLE_AT),
    };
  }
  return b;
}

const ENV_A = envelopeScript({ fields: [[1, 'text/plain']], body: ['A'] }, { checksigPrefix: true });
const ENV_B = envelopeScript({ fields: [[1, 'text/plain']], body: ['B'] }, { checksigPrefix: true });
const TAP_A = taprootCommit(ENV_A);
const TAP_B = taprootCommit(ENV_B);

/** two envelopes, one per input: the numbering a txid cannot prove */
const PAIR = pairChain({
  commitOutputs: [
    { value: 10_000n, spk: TAP_A.scriptPubKey },
    { value: 20_000n, spk: TAP_B.scriptPubKey },
  ],
  witnesses: [
    [SIG, ENV_A, TAP_A.controlBlock],
    [SIG, ENV_B, TAP_B.controlBlock],
  ],
  revealOutputs: [{ value: 25_000n }],
});
const PAIR_SAT_0 = firstSatOfBlock(HEIGHT);
const PAIR_SAT_1 = firstSatOfBlock(HEIGHT) + 10_000n;

/** a pointer landing in the input AFTER the envelope's: 15,000 is 0x3a98 */
const ENV_PTR = envelopeScript(
  { fields: [[1, 'text/plain'], [2, new Uint8Array([0x98, 0x3a])]], body: ['ptr'] },
  { checksigPrefix: true },
);
const TAP_PTR = taprootCommit(ENV_PTR);
const POINTER = pairChain({
  commitOutputs: [{ value: 10_000n, spk: TAP_PTR.scriptPubKey }, { value: 20_000n }],
  witnesses: [[SIG, ENV_PTR, TAP_PTR.controlBlock], [SIG]],
  revealOutputs: [{ value: 25_000n }],
});
const POINTER_SAT = firstSatOfBlock(HEIGHT) + 15_000n;

/**
 * The envelope on input 1 behind a 1,000-sat input 0, paying 500 sats out. The
 * default start position is sum(inputValue[0..0]) = 1000, at or past the total
 * output sats, so the inscription bound to fee sats.
 */
const ENV_FEE = envelopeScript({ fields: [[1, 'text/plain']], body: ['fee'] }, { checksigPrefix: true });
const TAP_FEE = taprootCommit(ENV_FEE);
const FEE_BOUND = pairChain({
  commitOutputs: [{ value: 1000n }, { value: 20_000n, spk: TAP_FEE.scriptPubKey }],
  witnesses: [[SIG], [SIG, ENV_FEE, TAP_FEE.controlBlock]],
  revealOutputs: [{ value: 500n }],
});

/** the same reveal with a pointer of 100, which the fee rule must not reach */
const ENV_FEE_PTR = envelopeScript(
  { fields: [[1, 'text/plain'], [2, new Uint8Array([0x64])]], body: ['fee'] },
  { checksigPrefix: true },
);
const TAP_FEE_PTR = taprootCommit(ENV_FEE_PTR);
const FEE_POINTER = pairChain({
  commitOutputs: [{ value: 1000n }, { value: 20_000n, spk: TAP_FEE_PTR.scriptPubKey }],
  witnesses: [[SIG], [SIG, ENV_FEE_PTR, TAP_FEE_PTR.controlBlock]],
  revealOutputs: [{ value: 500n }],
});

/**
 * A transaction whose STRIPPED serialization is exactly 64 bytes, the length
 * that is also an inner merkle node. Built by hand: version(4) inCount(1)
 * prevTxid(32) vout(4) scriptSigLen(1) sequence(4) outCount(1) value(8)
 * spkLen(1) spk(4) locktime(4).
 */
const TX64: ParsedTx = parseTx(
  hexToBytes(
    '02000000' +
      '01' +
      'ab'.repeat(32) +
      '00000000' +
      '00' +
      'ffffffff' +
      '01' +
      '0000000000000000' +
      '04' +
      '51515151' +
      '00000000',
  ),
);

/** Re-serialize with one input's witness replaced; the txid cannot change. */
function withWitness(tx: ParsedTx, at: number, witness: Uint8Array[]): ParsedTx {
  return parseTx(
    serializeFull({
      version: tx.version,
      inputs: tx.inputs.map((inp, i) => (i === at ? { ...inp, witness } : inp)),
      outputs: tx.outputs,
      locktime: tx.locktime,
    }),
  );
}

/**
 * Break a hop's header so it no longer meets its own target, leaving the
 * merkle root alone and recomputing the claimed hash, so the header's own
 * proof of work is the one check left to refuse it.
 */
function unmine(hop: CustodyHopJson): void {
  const bytes = hexToBytes(hop.block.header);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(72, 0x2000ffff, true);
  for (let nonce = 0; ; nonce++) {
    view.setUint32(76, nonce, true);
    if (!checkProofOfWork(parseHeader(bytes))) break;
  }
  hop.block.header = bytesToHex(bytes);
  hop.block.hash = internalToDisplay(sha256d(bytes));
}

const ENDPOINTS = ['reveal', 'coinbase'] as const;

// ---------------------------------------------------------------------------

describe('SPEC-SAT conformance', () => {
  // -------------------------------------------------------------------------
  // Start position in the reveal
  // -------------------------------------------------------------------------

  conformance('prevtx-supply', () => {
    // the floor: without the envelope input's own prev tx nothing proves its
    // value, and the refusal names the input rather than a count
    const noPrev = SINGLE.bundle();
    noPrev.reveal.prevTxs = [];
    expect(() => verifySatGenealogy(noPrev, ATTESTS)).toThrow(
      /reveal: no prev tx for envelope input 0/,
    );

    // every prev tx supplied, in the arrangement that separates it from
    // "enough to reach": the envelope is on input 0, so the position is 0 and
    // input 1's value can change no answer. The entry is still read
    const good = PAIR.bundle(0, PAIR_SAT_0);
    expect(verifySatGenealogy(good, ATTESTS).sat).toBe(PAIR_SAT_0);

    const surplusWrong = PAIR.bundle(0, PAIR_SAT_0);
    surplusWrong.reveal.prevTxs[1] = PAIR.cb.hex;
    expect(() => verifySatGenealogy(surplusWrong, ATTESTS)).toThrow(
      new RegExp(`prev tx 1 hashes to ${PAIR.cb.tx.txid}, input spends ${PAIR.commit.tx.txid}`),
    );
  });

  conformance('prevtx-surplus', () => {
    // the surplus entry is a copy of one the bundle already carries, so every
    // entry a verifier reads hashes correctly and only the count is wrong
    const atReveal = SINGLE.bundle();
    atReveal.reveal.prevTxs.push(SINGLE.commit.hex);
    expect(() => verifySatGenealogy(atReveal, ATTESTS)).toThrow(
      /reveal: 2 prev txs supplied for 1 input\(s\); an entry past the input count corresponds to no input/,
    );

    const atStep = SINGLE.bundle();
    atStep.funding[0].prevTxs.push(SINGLE.funding.hex);
    expect(() => verifySatGenealogy(atStep, ATTESTS)).toThrow(
      /funding\[0\]: 2 prev txs supplied for 1 input\(s\)/,
    );

    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).sat).toBe(SINGLE.sat);
  });

  conformance('coinbase-empty-prevtxs', () => {
    // one entry is what the count rule of :72 would admit, since a coinbase
    // has one input, and it is the case this rule exists for
    const one = SINGLE.bundle();
    one.coinbase.prevTxs.push(SINGLE.coinbase.hex);
    expect(() => verifySatGenealogy(one, ATTESTS)).toThrow(
      /coinbase: 1 prev tx\(s\) supplied; a coinbase funds nothing from a previous transaction/,
    );

    const several = SINGLE.bundle();
    several.coinbase.prevTxs.push('ff', 'ff', 'ff');
    expect(() => verifySatGenealogy(several, ATTESTS)).toThrow(/coinbase: 3 prev tx\(s\) supplied/);

    // and the empty list the reference builder writes verifies
    expect(SINGLE.bundle().coinbase.prevTxs).toEqual([]);
    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).sat).toBe(SINGLE.sat);
  });

  conformance('fee-bound-reveal', () => {
    // the default start position is sum(inputValue[0..0]) = 1000, and the
    // reveal pays 500 sats out, so the sat ord assigns depends on block-level
    // fee accounting this walk never does
    const bound = FEE_BOUND.bundle(0, 0n);
    let thrown: unknown;
    try {
      verifySatGenealogy(bound, ATTESTS);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CustodyUnsupportedError);
    expect((thrown as Error).message).toMatch(
      /inscription is bound to fee sats at reveal; v1 does not track sats through fees/,
    );
    expect((thrown as CustodyUnsupportedError).height).toBe(2000);

    // the same reveal shape with a pointer of 100, which is strictly less than
    // the total output sats and so replaces the default: the pointer branch
    // cannot reach the rule, which is what the sentence after it says
    const pointed = FEE_POINTER.bundle(0, firstSatOfBlock(HEIGHT) + 100n);
    const res = verifySatGenealogy(pointed, ATTESTS);
    expect(res.revealPosition).toBe(100n);
    expect(res.sat).toBe(firstSatOfBlock(HEIGHT) + 100n);
  });

  conformance('unbound-refusal', () => {
    // a zero-value envelope input has no sat to name
    const zero = UNBOUND_ZERO.bundle();
    expect(() => verifySatGenealogy(zero, ATTESTS)).toThrow(CustodyUnsupportedError);
    expect(() => verifySatGenealogy(zero, ATTESTS)).toThrow(
      /inscription is unbound at reveal .*zero-value envelope input/,
    );

    // and ord's other condition, read out of the envelope bytes alone
    const evenField = inscriptionsFromTx(UNBOUND_EVEN.reveal).find((i) => i.index === 0);
    expect(evenField?.unboundByEvenField, 'the fixture carries the condition').toBe(true);
    expect(() => verifySatGenealogy(UNBOUND_EVEN.bundle(), ATTESTS)).toThrow(
      CustodyUnsupportedError,
    );
    expect(() => verifySatGenealogy(UNBOUND_EVEN.bundle(), ATTESTS)).toThrow(
      /unrecognized even field/,
    );
  });

  // -------------------------------------------------------------------------
  // Envelope binding
  // -------------------------------------------------------------------------

  conformance('binding-before-position', () => {
    // the forgery the ordering exists to catch: same stripped bytes, same
    // txid, same anchored header, a pointer naming a different sat. A verifier
    // deriving the position first folds to the forged sat and objects after
    const forgedLeaf = envelopeScript(
      { fields: [[1, 'text/plain'], [2, new Uint8Array([0xe8, 0x03])]], body: ['forged'] },
      { checksigPrefix: true },
    );
    const forged = withWitness(SINGLE.reveal, 0, [
      SIG,
      forgedLeaf,
      taprootCommit(forgedLeaf).controlBlock,
    ]);
    expect(forged.txid, 'the rewrite left the txid alone').toBe(SINGLE.reveal.txid);
    expect(inscriptionsFromTx(forged)[0].pointer, 'and moved the pointer').toBe(1000n);

    const b = SINGLE.bundle();
    b.reveal.tx.hex = bytesToHex(forged.raw);
    expect(() => verifySatGenealogy(b, ATTESTS)).toThrow(/taproot commitment/);

    // both values of indexProof, read off bundles that verify
    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).indexProof).toBe('single-input');
    expect(verifySatGenealogy(PAIR.bundle(1, PAIR_SAT_1), ATTESTS).indexProof).toBe('wtxid');
  });

  conformance('witness-section-no-fallback', () => {
    // a single-input reveal needs nothing more, so the path a verifier would
    // fall back to is one that succeeds: the same bundle with no section at
    // all verifies and reports single-input
    expect(verifySatGenealogy(singleInBlock(), ATTESTS).indexProof).toBe('single-input');
    expect(verifySatGenealogy(singleInBlock('honest'), ATTESTS).indexProof).toBe('wtxid');

    // and with a section that does not fold, the bundle is refused rather
    // than read the way the sectionless one is read
    expect(() => verifySatGenealogy(singleInBlock('broken'), ATTESTS)).toThrow(
      /witness commitment mismatch/,
    );

    // and the success arm, where the section is the only thing that can prove
    // the numbering. The residual the bullet states is reported beside it
    const res = verifySatGenealogy(PAIR.bundle(1, PAIR_SAT_1), ATTESTS);
    expect(res.indexProof).toBe('wtxid');
    expect(res.singleLeafTree).toBe(true);
    expect(res.singleInputReveal).toBe(false);
  });

  conformance('unproven-index-distinguishable', () => {
    const noSection = PAIR.bundle(1, PAIR_SAT_1);
    delete noSection.reveal.witness;

    let thrown: unknown;
    try {
      verifySatGenealogy(noSection, ATTESTS);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EnvelopeIndexUnprovenError);
    expect((thrown as Error).message).toMatch(/reveal spends 2 inputs/);
    expect((thrown as Error).message).toMatch(/envelope index 1/);

    // the same bundle with the section verifies, so the refusal is the absent
    // proof rather than anything about the reveal
    expect(verifySatGenealogy(PAIR.bundle(1, PAIR_SAT_1), ATTESTS).sat).toBe(PAIR_SAT_1);
  });

  conformance('unproven-index-before-selection', () => {
    // index 7 is in neither envelope. Without a section the count is unproven,
    // so saying the index is absent would assert a count nothing supports
    const noSection = PAIR.bundle(7, PAIR_SAT_1);
    delete noSection.reveal.witness;
    expect(() => verifySatGenealogy(noSection, ATTESTS)).toThrow(EnvelopeIndexUnprovenError);
    expect(() => verifySatGenealogy(noSection, ATTESTS)).not.toThrow(/not present/);

    // with the section the count is proven and the absence is supportable
    expect(() => verifySatGenealogy(PAIR.bundle(7, PAIR_SAT_1), ATTESTS)).toThrow(
      /contains 2 envelope\(s\); index 7 not present/,
    );
  });

  conformance('input-k-checks', () => {
    // a prevout that is not P2TR commits to no tapscript at all
    expect(() => verifySatGenealogy(BARE_COMMIT.bundle(), ATTESTS)).toThrow(
      /envelope input 0 spends a non-P2TR output/,
    );

    // the BIP-341 commitment, driven with a witness the commit output never
    // committed, under a txid the rewrite could not move
    const other = envelopeScript({ body: ['committed by nobody'] }, { checksigPrefix: true });
    const decoy = withWitness(SINGLE.reveal, 0, [SIG, other, taprootCommit(other).controlBlock]);
    const b = SINGLE.bundle();
    b.reveal.tx.hex = bytesToHex(decoy.raw);
    expect(() => verifySatGenealogy(b, ATTESTS)).toThrow(
      /envelope input 0 taproot commitment: /,
    );

    // the key-path arm has no bundle form: ord reads no envelope off an input
    // spent by key path, so nothing can select input k. The check guards
    // callers of the helper, of which the genealogy verifier is one
    const inscription = inscriptionsFromTx(SINGLE.reveal).find((i) => i.index === 0)!;
    const keyPath = withWitness(SINGLE.reveal, 0, [SIG]);
    expect(() => verifyEnvelopeBinding(keyPath, inscription, [SINGLE.commit.hex])).toThrow(
      /envelope input 0 is a key-path spend with no tapscript/,
    );
  });

  conformance('section-only-at-reveal', () => {
    const section = {
      coinbaseHex: bytesToHex(PAIR.block.txs[0].raw),
      coinbaseTxidBranch: PAIR.block.txidBranch(0),
      wtxidBranch: PAIR.block.wtxidBranch(1),
    };
    // the same section verifies where it belongs, so the refusals below rest
    // on position rather than on the section being wrong
    expect(verifySatGenealogy(PAIR.bundle(1, PAIR_SAT_1), ATTESTS).indexProof).toBe('wtxid');

    const onCoinbase = PAIR.bundle(1, PAIR_SAT_1);
    onCoinbase.coinbase.witness = clone(section);
    expect(() => verifySatGenealogy(onCoinbase, ATTESTS)).toThrow(
      /coinbase: witness section is only accepted at the reveal/,
    );

    const onStep = PAIR.bundle(1, PAIR_SAT_1);
    (onStep.funding[0] as { witness?: unknown }).witness = clone(section);
    expect(() => verifySatGenealogy(onStep, ATTESTS)).toThrow(
      /funding\[0\]: witness section is only accepted at the reveal/,
    );

    // presence rather than truth: untrusted JSON can carry a falsy section,
    // which carries no data and is still in a position the rule forbids
    for (const value of [0, '', false, null]) {
      const falsy = PAIR.bundle(1, PAIR_SAT_1);
      (falsy.coinbase as { witness?: unknown }).witness = value;
      expect(() => verifySatGenealogy(falsy, ATTESTS), JSON.stringify(value)).toThrow(
        /coinbase: witness section is only accepted at the reveal/,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Backward step
  // -------------------------------------------------------------------------

  conformance('values-from-prevtxs', () => {
    // a real transaction of the right shape and the wrong identity, at the
    // reveal and at a funding step
    const atReveal = PAIR.bundle(0, PAIR_SAT_0);
    atReveal.reveal.prevTxs[0] = PAIR.cb.hex;
    expect(() => verifySatGenealogy(atReveal, ATTESTS)).toThrow(
      /reveal: prev tx for envelope input 0 hashes to /,
    );

    const atStep = SINGLE.bundle();
    atStep.funding[0].prevTxs[0] = SINGLE.coinbase.hex;
    expect(() => verifySatGenealogy(atStep, ATTESTS)).toThrow(
      new RegExp(`prev tx 0 hashes to ${SINGLE.coinbase.tx.txid}, input spends ${SINGLE.funding.tx.txid}`),
    );

    // and that the values are read from those bytes: editing the funded
    // output's value moves the txid, so the hash is what refuses it, and no
    // other copy of the value exists for a verifier to prefer
    const edited = buildTx(
      [{ txid: SINGLE.coinbase.tx.txid, vout: 1 }],
      [{ value: 1n }, { value: 10_000n }],
    );
    expect(edited.tx.txid).not.toBe(SINGLE.funding.tx.txid);
    const swapped = SINGLE.bundle();
    swapped.funding[1] = { tx: { hex: edited.hex }, prevTxs: [SINGLE.coinbase.hex] };
    expect(() => verifySatGenealogy(swapped, ATTESTS)).toThrow(/chain expects/);
  });

  conformance('values-reach-position', () => {
    // the pointer puts the position in input 1, which the bundle below values
    // and the truncated one does not
    expect(verifySatGenealogy(POINTER.bundle(0, POINTER_SAT), ATTESTS).revealPosition).toBe(15_000n);

    const short = POINTER.bundle(0, POINTER_SAT);
    short.reveal.prevTxs = [POINTER.commit.hex];
    let thrown: unknown;
    try {
      verifySatGenealogy(short, ATTESTS);
    } catch (e) {
      thrown = e;
    }
    // it says so, in a class of its own: the document stopped short, where a
    // SatPositionError would say it contradicts itself
    expect(thrown).toBeInstanceOf(SatFundingIncompleteError);
    expect(thrown).not.toBeInstanceOf(SatPositionError);
    expect((thrown as Error).message).toMatch(
      /position 15000 not reached by prev txs for inputs 0\.\.0; more are needed/,
    );
  });

  // -------------------------------------------------------------------------
  // Terminal coinbase
  // -------------------------------------------------------------------------

  conformance('coinbase-fee-tail', () => {
    // one sat below the subsidy boundary the position numbers directly
    expect(AT_SUBSIDY_EDGE.sat).toBe(firstSatOfBlock(HEIGHT) + SUBSIDY - 1n);
    expect(verifySatGenealogy(AT_SUBSIDY_EDGE.bundle(), ATTESTS).sat).toBe(AT_SUBSIDY_EDGE.sat);

    // and one sat further on it is a fee sat, which needs whole-block
    // accounting no path proof does
    let thrown: unknown;
    try {
      verifySatGenealogy(IN_FEE_TAIL.bundle(), ATTESTS);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CustodyUnsupportedError);
    expect((thrown as Error).message).toMatch(
      new RegExp(`sat was mined as fee sats in block ${HEIGHT}`),
    );
  });

  conformance('height-never-unchecked', () => {
    // below the boundary, with no hook: nothing in the bundle binds the claim
    expect(() => verifySatGenealogy(SINGLE.bundle(), NO_POW_FLOOR)).toThrow(
      CoinbaseHeightUnprovenError,
    );
    // at or above it, with no height push: the check the boundary turns on
    // cannot run, and the claim is refused rather than taken
    expect(() => verifySatGenealogy(HIGH_NO_PUSH.bundle(), ATTESTS)).toThrow(
      /coinbase at height 240000 lacks a parseable BIP34 height/,
    );

    // the same two bundles with their checks in place, so the refusals above
    // are the height rule and not the rest of the document
    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).coinbaseHeight).toBe(HEIGHT);
    expect(verifySatGenealogy(HIGH.bundle(), ATTESTS).coinbaseHeight).toBe(HIGH_HEIGHT);
  });

  conformance('bip34-parse-and-reject', () => {
    // little-endian, read off a push written out byte by byte. A verifier
    // reading it the other way round refuses every honest bundle, which no
    // test made only of refusals would notice
    expect(HIGH.coinbase.tx.inputs[0].scriptSig).toEqual(
      new Uint8Array([0x03, 0x80, 0xa9, 0x03]),
    );
    expect(0x03a980).toBe(HIGH_HEIGHT);
    expect(verifySatGenealogy(HIGH.bundle(), ATTESTS).coinbaseHeight).toBe(HIGH_HEIGHT);

    // a push that disagrees with the claim, with the claim left alone
    expect(() => verifySatGenealogy(HIGH_WRONG_PUSH.bundle(), ATTESTS)).toThrow(
      /BIP34 height 240001 contradicts claimed height 240000/,
    );
    // and one that is no height at all
    expect(() => verifySatGenealogy(HIGH_NO_PUSH.bundle(), ATTESTS)).toThrow(
      /lacks a parseable BIP34 height/,
    );

    // the boundary itself: the same unparseable coinbase below it is not
    // refused for the push, since below 230,000 none is required
    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).coinbaseHeight).toBe(HEIGHT);
  });

  conformance('sub-bip34-refusal', () => {
    // one bundle, two calls, the attestation the only difference
    expect(() => verifySatGenealogy(SINGLE.bundle(), NO_POW_FLOOR)).toThrow(
      CoinbaseHeightUnprovenError,
    );
    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).sat).toBe(SINGLE.sat);

    // and the hook was asked about the terminal coinbase's own header at the
    // claimed height, which is the pair the attestation binds
    const seen: { height: number; hash: string }[] = [];
    verifySatGenealogy(SINGLE.bundle(), {
      ...NO_POW_FLOOR,
      trustHeader: (header, height) => {
        seen.push({ height, hash: header.hash });
        return 'hash-at-height';
      },
    });
    expect(seen).toContainEqual({ height: HEIGHT, hash: SINGLE.bundle().coinbase.block.hash });
  });

  conformance('hook-must-state-what-it-checked', () => {
    // the hole: a hook that runs and returns without objecting may have
    // checked nothing at all, and its presence must not unlock the height
    const seen: number[] = [];
    let thrown: unknown;
    try {
      verifySatGenealogy(SINGLE.bundle(), {
        ...NO_POW_FLOOR,
        trustHeader: (_header, height) => {
          seen.push(height);
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CoinbaseHeightUnprovenError);
    expect(seen, 'the hook ran on the coinbase and still did not unlock it').toContain(HEIGHT);

    // acceptance is read from the statement: the marker accepts, and a hook
    // answering something else does not
    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).coinbaseHeight).toBe(HEIGHT);
    expect(() =>
      verifySatGenealogy(SINGLE.bundle(), {
        ...NO_POW_FLOOR,
        trustHeader: () => 'checked' as unknown as 'hash-at-height',
      }),
    ).toThrow(CoinbaseHeightUnprovenError);
  });

  conformance('sub-bip34-refusal-named', () => {
    let thrown: unknown;
    try {
      verifySatGenealogy(SINGLE.bundle(), NO_POW_FLOOR);
    } catch (e) {
      thrown = e;
    }
    // distinguishable from both classes it could be confused with: a forgery
    // is a plain Error and an out-of-domain path is CustodyUnsupportedError
    expect((thrown as Error).name).toBe('CoinbaseHeightUnprovenError');
    expect(thrown).not.toBeInstanceOf(CustodyUnsupportedError);
    expect(thrown).toBeInstanceOf(Error);

    const message = (thrown as Error).message;
    expect(message).toMatch(new RegExp(`coinbase claims height ${HEIGHT}`));
    expect(message).toMatch(/230000/);
    // and what the caller does next, since a refusal it cannot act on is a
    // dead end however well named
    expect(message).toMatch(/trustHeader/);
    expect(message).toMatch(/hash-at-height/);
  });

  conformance('no-sat-for-unproven-height', () => {
    // the three fields exist to be withheld: attested, the same bundle
    // reports all of them
    const attested = verifySatGenealogy(SINGLE.bundle(), ATTESTS);
    expect(attested.sat).toBe(SINGLE.sat);
    expect(attested.name).toBe(satName(SINGLE.sat));
    expect(attested.rarity).toBe(satRarity(SINGLE.sat));

    // unattested, the call produces no result at all, so there is nothing for
    // a caller to read any of them out of
    expect(() => verifySatGenealogy(SINGLE.bundle(), NO_POW_FLOOR)).toThrow(
      CoinbaseHeightUnprovenError,
    );

    // and the reason the sentence gives, in the exact form it names it: the
    // same shape of walk under a height the server chose reaches sat 0 at
    // mythic, so an unchecked height chooses the rarity as well as the number
    const atZero = singleChain({
      outputs: [{ value: 0n }, { value: 2_000_000_000n }],
      height: 0,
    });
    const asZero = verifySatGenealogy(atZero.bundle(), ATTESTS);
    expect(asZero.sat).toBe(0n);
    expect(asZero.rarity).toBe('mythic');
    expect(asZero.rarity).not.toBe(attested.rarity);
  });

  // -------------------------------------------------------------------------
  // Genealogy bundle
  // -------------------------------------------------------------------------

  conformance('format-coinbase-pos-and-prevtxs', () => {
    // the coinbase is otherwise honest: only the claimed position moves
    const moved = SINGLE.bundle();
    moved.coinbase.tx.pos = 1;
    expect(() => verifySatGenealogy(moved, ATTESTS)).toThrow(
      /coinbase must be at position 0, bundle says 1/,
    );

    // the refusal is its own rule rather than a consequence of the fold: it
    // fires above the merkle check, which is why the message is asserted and
    // not merely the throw. A branch built for position 1 fails differently
    const folded = SINGLE.bundle();
    folded.coinbase.tx.pos = 1;
    folded.coinbase.block.txCount = 2;
    expect(() => verifySatGenealogy(folded, ATTESTS)).toThrow(/coinbase must be at position 0/);

    // and the other half of the same comment, whose message variants are the
    // empty-prevTxs row
    const withPrev = SINGLE.bundle();
    withPrev.coinbase.prevTxs = [SINGLE.funding.hex];
    expect(() => verifySatGenealogy(withPrev, ATTESTS)).toThrow(/coinbase: 1 prev tx\(s\) supplied/);

    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).coinbaseHeight).toBe(HEIGHT);
  });

  conformance('endpoint-anchoring', () => {
    // each of the four checks, broken at each endpoint in turn, with the
    // refusal asserted to name the endpoint it was broken at
    for (const at of ENDPOINTS) {
      // 1. the header hashes to the claimed hash
      const hash = SINGLE.bundle();
      hash[at].block.hash = '00'.repeat(32);
      expect(() => verifySatGenealogy(hash, ATTESTS), at).toThrow(
        new RegExp(`^${at}: header hashes to `),
      );

      // 2. the header satisfies its own target
      const pow = SINGLE.bundle();
      unmine(pow[at]);
      expect(() => verifySatGenealogy(pow, ATTESTS), at).toThrow(
        new RegExp(`^${at}: header fails proof of work`),
      );

      // 3. a valid txCount
      for (const bad of [undefined, null, '1', 1.5, 0, -1]) {
        const count = SINGLE.bundle();
        (count[at].block as { txCount?: unknown }).txCount = bad;
        expect(() => verifySatGenealogy(count, ATTESTS), `${at} ${bad}`).toThrow(
          new RegExp(`^${at}: missing valid txCount`),
        );
      }

      // 3b. and a branch depth equal to treeHeight(txCount), which is the
      // CVE-2017-12842 hardening: the count is inflated to the next tree
      // height, leaving a branch that would otherwise still fold
      const depth = SINGLE.bundle();
      depth[at].block.txCount = 2;
      expect(() => verifySatGenealogy(depth, ATTESTS), at).toThrow(
        new RegExp(`^${at}: txid branch depth 0 != tree height 1`),
      );

      // 4. the branch folds to the header's merkle root. Each endpoint gets
      // the other's header, so the hash check passes and the fold is what is
      // left to refuse it
      const other = at === 'reveal' ? 'coinbase' : 'reveal';
      const fold = SINGLE.bundle();
      fold[at].block.header = fold[other].block.header;
      fold[at].block.hash = fold[other].block.hash;
      expect(() => verifySatGenealogy(fold, ATTESTS), at).toThrow(
        new RegExp(`^${at}: txid merkle proof does not match header merkle root`),
      );
    }

    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).sat).toBe(SINGLE.sat);
  });

  conformance('sixty-four-byte-endpoints', () => {
    expect(TX64.strippedRaw.length).toBe(64);
    const hex = bytesToHex(TX64.raw);

    // the reveal, where the guard runs above the txid comparison, so a
    // transaction hashing to nothing the id names still reaches it
    const atReveal = SINGLE.bundle();
    atReveal.reveal.tx.hex = hex;
    expect(() => verifySatGenealogy(atReveal, ATTESTS)).toThrow(
      /^reveal: 64-byte transactions are rejected \(leaf\/node ambiguity\)/,
    );

    // the terminal coinbase, reached by a walk that ran the whole chain
    const atCoinbase = SINGLE.bundle();
    atCoinbase.coinbase.tx.hex = hex;
    expect(() => verifySatGenealogy(atCoinbase, ATTESTS)).toThrow(
      /^coinbase: 64-byte transactions are rejected/,
    );

    // and a funding step, which :232 makes a SHOULD and the implementation
    // rejects on the same guard, so what is recorded here is what the code
    // does rather than only what this line requires
    const atStep = SINGLE.bundle();
    atStep.funding[0].tx.hex = hex;
    expect(() => verifySatGenealogy(atStep, ATTESTS)).toThrow(
      /^funding\[0\]: 64-byte transactions are rejected/,
    );

    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).sat).toBe(SINGLE.sat);
  });

  conformance('bundle-binds-envelope', () => {
    // the anchoring list above this sentence passes on the bundle below: the
    // hop verifies before the tamper, and the tamper cannot move the txid, so
    // every check in that list still passes afterwards
    const honest = SINGLE.bundle();
    expect(verifySatGenealogy(honest, ATTESTS).sat).toBe(SINGLE.sat);

    const other = envelopeScript({ body: ['not what the commit committed'] }, { checksigPrefix: true });
    const rewritten = withWitness(SINGLE.reveal, 0, [SIG, other, taprootCommit(other).controlBlock]);
    expect(rewritten.txid).toBe(SINGLE.reveal.txid);

    const b = SINGLE.bundle();
    b.reveal.tx.hex = bytesToHex(rewritten.raw);
    expect(b.reveal.tx.txidBranch, 'the branch is the honest one').toEqual(
      honest.reveal.tx.txidBranch,
    );
    expect(() => verifySatGenealogy(b, ATTESTS)).toThrow(/taproot commitment/);
  });

  conformance('duplicate-transaction', () => {
    // what a bundle repeating a transaction actually gets: each funding step
    // has to hash to the txid the step before it named, and that check runs
    // above the duplicate test, so the repeat is refused for being in the
    // wrong place in the chain
    const repeated = SINGLE.bundle();
    repeated.funding = [repeated.funding[0], clone(repeated.funding[0])];
    expect(() => verifySatGenealogy(repeated, ATTESTS)).toThrow(
      new RegExp(`funding\\[1\\]: hashes to ${SINGLE.commit.tx.txid}, chain expects ${SINGLE.funding.tx.txid}`),
    );

    // reaching the duplicate test needs the walk to arrive twice at one txid,
    // and the walk follows inputs backward, so that needs a cycle in the
    // transaction graph. The guard is still in the verifier for the shape the
    // custody walk can reach, where a server names each next transaction
    const source = readFileSync(join(ROOT, 'packages/core/src/satnumber.ts'), 'utf8');
    expect(source).toContain('duplicate transaction in genealogy');
  });

  conformance('coinbase-not-a-funding-step', () => {
    // the real terminal coinbase, appended to the funding list and named as
    // the terminal element too: it hashes to exactly the txid the chain
    // expects, so every other check on it passes
    const b = SINGLE.bundle();
    b.funding = [...b.funding, { tx: { hex: SINGLE.coinbase.hex }, prevTxs: [SINGLE.coinbase.hex] }];
    expect(() => verifySatGenealogy(b, ATTESTS)).toThrow(
      /funding\[2\]: coinbase must be the terminal element, not a funding step/,
    );

    // and the same coinbase in the position it belongs in
    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).coinbaseHeight).toBe(HEIGHT);
  });

  conformance('step-cap-distinguishable', () => {
    const b = SINGLE.bundle();
    let thrown: unknown;
    try {
      verifySatGenealogy(b, { ...ATTESTS, maxSteps: 1 });
    } catch (e) {
      thrown = e;
    }
    // a class of its own, which is what a caller raising the cap
    // discriminates on
    expect(thrown).toBeInstanceOf(SatStepLimitError);
    expect((thrown as Error).message).toMatch(/genealogy has 2 steps, verifier cap is 1/);

    // the same bytes read through under a raised cap, so the refusal cannot
    // have been about the document
    expect(verifySatGenealogy(b, { ...ATTESTS, maxSteps: 2 }).sat).toBe(SINGLE.sat);
  });

  conformance('claimedsat-refolded', () => {
    // the answer comes from the fold: the walk implies the number the result
    // carries, and the claim is only compared against it
    expect(verifySatGenealogy(SINGLE.bundle(), ATTESTS).sat).toBe(SINGLE.sat);

    const off = SINGLE.bundle();
    off.claimedSat = (SINGLE.sat + 1n).toString();
    expect(() => verifySatGenealogy(off, ATTESTS)).toThrow(
      new RegExp(`bundle claims sat ${SINGLE.sat + 1n}, genealogy folds to ${SINGLE.sat}`),
    );

    // the forms a lenient parse would take for something else: BigInt('') is
    // zero and BigInt('0x10') is sixteen
    for (const claimed of ['', '0x10', ' 1000', '1000n', '1_000', '007', `0${SINGLE.sat}`]) {
      const b = SINGLE.bundle();
      b.claimedSat = claimed;
      expect(() => verifySatGenealogy(b, ATTESTS), claimed).toThrow(/genealogy folds to/);
    }
  });

  // -------------------------------------------------------------------------
  // the accounting
  // -------------------------------------------------------------------------

  /**
   * SPEC-SAT states every requirement with MUST: 53 occurrences over 50 lines,
   * 8 of them MUST NOT, and no REQUIRED, SHALL or RECOMMENDED anywhere in the
   * file. The pattern catches MUST NOT as well, since it contains MUST. The
   * spec has no RFC 2119 boilerplate line, so no line is excluded by name.
   */
  const NORMATIVE = /\bMUST\b/;

  it('SPEC-SAT.md: every normative line is accounted for by a row in the table', () => {
    const lines = SPEC.split('\n');
    const normative = lines
      .map((text, i) => ({ line: i + 1, text }))
      .filter((l) => NORMATIVE.test(l.text));

    const claimed = new Map<number, string>();
    for (const r of TABLE) {
      const { first, last } = anchor(r.quote);
      for (let line = first; line <= last; line++) {
        if (!NORMATIVE.test(lines[line - 1])) continue;
        const already = claimed.get(line);
        expect(already, `line ${line} is claimed by both ${already} and ${r.id}`).toBeUndefined();
        claimed.set(line, r.id);
      }
    }

    const unaccounted = normative
      .filter((l) => !claimed.has(l.line))
      .map((l) => `  ${l.line}: ${l.text.trim()}`);
    expect(
      unaccounted,
      `SPEC-SAT.md states requirements no row accounts for:\n${unaccounted.join('\n')}`,
    ).toEqual([]);

    // and the other direction: a row claiming a line that carries no keyword
    // would mean the table drifted off the requirements it accounts for
    expect(claimed.size).toBe(normative.length);
  });

  /**
   * The filter choice itself, measured rather than assumed. A REQUIRED added
   * to this spec would state a requirement the accounting above cannot see,
   * so the choice is re-measured here and fails when the file gains a keyword
   * the pattern does not carry.
   */
  it('SPEC-SAT.md: MUST is the only RFC 2119 requirement keyword in the file', () => {
    for (const keyword of ['REQUIRED', 'SHALL', 'RECOMMENDED']) {
      expect(SPEC.match(new RegExp(`\\b${keyword}\\b`, 'g')), keyword).toBeNull();
    }
    expect(SPEC.match(/\bMUST\b/g)).toHaveLength(53);
    expect(SPEC.match(/\bMUST NOT\b/g)).toHaveLength(8);
    expect(SPEC.split('\n').filter((l) => /\bMUST\b/.test(l))).toHaveLength(50);
  });

  it('SPEC-SAT.md: the table says how each requirement is covered', () => {
    for (const r of TABLE) {
      expect(r.why.length, `${r.id} has no reasoning`).toBeGreaterThan(20);
      expect(r.binds.length, `${r.id} does not say who it binds`).toBeGreaterThan(0);
      expect(r.title, `${r.id} is not named for its requirement`).toMatch(/MUST/);
    }
    // the rows no test asserts, kept visible rather than counted: a reader of
    // the list sees the coverage gap without reading the file
    const notTested = TABLE.filter((r) => r.status.startsWith('unimplemented,')).map((r) => r.id);
    expect(notTested).toEqual([]);
  });

  it('SPEC-SAT.md: every `tested at` row names a test that still exists', () => {
    const cited = TABLE.filter((r) => r.status.startsWith('tested at '));
    expect(cited.length).toBeGreaterThan(0);
    for (const r of cited) {
      const rest = r.status.slice('tested at '.length);
      const split = rest.indexOf(': ');
      expect(split, `${r.id} does not name a test after its path`).toBeGreaterThan(0);
      const path = rest.slice(0, split);
      const name = rest.slice(split + 2);
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source, `${r.id} cites ${path}, which no longer contains "${name}"`).toContain(name);
    }
  });

  /**
   * The split across two files, checked from both ends. The companion runs the
   * same check for its own rows, so a row that moved between files without a
   * test moving with it fails on one side or the other. The companion is named
   * here and asserted to read this table, so deleting it wholesale takes this
   * test down with it rather than leaving its rows unspoken for.
   */
  it('SPEC-SAT.md: this file speaks for exactly the core rows', () => {
    expect([...SPOKEN].sort()).toEqual(drivenIdsFor('core').sort());
    expect(idsFor('fetch').length, 'the fetch file drives no rows').toBeGreaterThan(0);
    expect(
      readFileSync(join(ROOT, 'packages/fetch/test/spec-sat.builder.test.ts'), 'utf8'),
    ).toContain('spec-sat.rows.js');
  });
});
