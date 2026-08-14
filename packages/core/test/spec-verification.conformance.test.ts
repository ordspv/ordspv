/**
 * Conformance suite for SPEC-VERIFICATION.md: one test per normative sentence,
 * named for the sentence it speaks for.
 *
 * The accounting table is `spec-verification.rows.ts`, shared with
 * `packages/fetch/test/spec-verification.anchoring.test.ts`, which drives the
 * rows whose code lives in @ordspv/fetch. The accounting test at the bottom of
 * this file sums the WHOLE spec against every row in that table, whichever
 * file drives it, so a requirement added to the spec fails this suite until
 * somebody accounts for it and a row cannot be lost between the two files.
 *
 * Duplication with the rest of the suite is deliberate. proofbundle.test.ts,
 * custody.test.ts and gallery.test.ts cover several of these behaviours and
 * cover them harder; the job here is traceability from the sentence to a test,
 * so a thin re-assertion is the normal case and a `tested at` row is for where
 * a thin one would be disproportionate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_HEADERS_UNANCHORED,
  GalleryEncodingError,
  L2_NUMBERING_RESIDUAL,
  ZERO32,
  buildMerkleBranch,
  bytesToHex,
  computeMerkleRoot,
  concatBytes,
  displayToInternal,
  firstSatOfBlock,
  galleryItems,
  hexToBytes,
  inscriptionGallery,
  internalToDisplay,
  parseGallery,
  parseHeader,
  parseTx,
  checkProofOfWork,
  serializeFull,
  sha256,
  sha256d,
  verifyCustodyBundle,
  verifyMerkleBranch,
  verifyProofBundle,
  verifySatGenealogy,
  verifyWitnessAnchoring,
  type CustodyBundleJson,
  type CustodyHopJson,
  type Inscription,
  type ParsedTx,
  type ProofBundleJson,
  type SatGenealogyBundleJson,
} from '../src/index.js';
import {
  NO_POW_FLOOR,
  anchoredHop,
  buildBlock,
  buildCoinbase,
  buildTx,
  commitTx,
  envelopeScript,
  l3Bundle,
  mineHeader,
  revealTx,
  taprootCommit,
  type EnvelopeSpec,
  type TestBlock,
} from './helpers.js';
import {
  ROOT,
  SPEC,
  TABLE,
  anchor,
  drivenIdsFor,
  idsFor,
  row,
} from './spec-verification.rows.js';

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
  it(`SPEC-VERIFICATION.md ${r.section}: ${r.title}`, async () => {
    anchor(r.quote);
    await body();
  });
}

// ---------------------------------------------------------------------------
// fixtures: synthetic blocks mined at regtest difficulty
// ---------------------------------------------------------------------------

const HEIGHT = 100;

interface Inscribed {
  id: string;
  reveal: ParsedTx;
  commit: ParsedTx;
}

/** one inscription in its own commit/reveal pair, single input, single leaf */
function inscribe(spec: EnvelopeSpec): Inscribed {
  const leaf = envelopeScript(spec, { checksigPrefix: true });
  const tap = taprootCommit(leaf);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script: leaf, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  return { id: `${reveal.txid}i0`, reveal, commit };
}

const PLAIN_BODY = 'the body an L2 proof binds';
/** the ordinary case: one input, a taptree of one leaf, control block depth 0 */
const PLAIN = inscribe({ fields: [[1, 'text/plain']], body: [PLAIN_BODY] });

/** a two-leaf taptree, so the control block carries a sibling and depth is 1 */
const MULTILEAF: Inscribed = (() => {
  const leaf = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['committed beside a sibling'] },
    { checksigPrefix: true },
  );
  const sibling = sha256(new TextEncoder().encode('the other leaf'));
  const tap = taprootCommit(leaf, [sibling]);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script: leaf, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  return { id: `${reveal.txid}i0`, reveal, commit };
})();

/** two inputs, one envelope each: the numbering L2 cannot prove */
const PAIR: Inscribed = (() => {
  const first = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['envelope on input 0'] },
    { checksigPrefix: true },
  );
  const second = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['envelope on input 1'] },
    { checksigPrefix: true },
  );
  const tapFirst = taprootCommit(first);
  const tapSecond = taprootCommit(second);
  const commit = commitTx(tapFirst.scriptPubKey);
  const reveal = revealTx(
    [
      { script: first, controlBlock: tapFirst.controlBlock },
      { script: second, controlBlock: tapSecond.controlBlock },
    ],
    { prevTxidLE: commit.txidLE, vout: 0 },
  );
  return { id: `${reveal.txid}i0`, reveal, commit };
})();

/**
 * The reveal spends a commit output paying a DIFFERENT taproot key, so every
 * check up to and including the commit txid passes and the BIP-341 fold is the
 * one that fails. Check 6 of §2 has no other reachable arm from a bundle.
 */
const DECOY: Inscribed = (() => {
  const leaf = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['committed by nobody'] },
    { checksigPrefix: true },
  );
  const tap = taprootCommit(leaf);
  const other = taprootCommit(envelopeScript({ body: ['a key this reveal never shows'] }));
  const commit = commitTx(other.scriptPubKey);
  const reveal = revealTx([{ script: leaf, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  return { id: `${reveal.txid}i0`, reveal, commit };
})();

/** coinbase + one reveal: the only block shape where the reveal sits at pos 1 */
const MINI = buildBlock([PLAIN.reveal]);
/**
 * Five transactions, so the last leaf of level 0 and of level 1 both self-pair.
 * PAIR is last on purpose: the self-pair rule is worth asserting through a
 * bundle that verifies, and DECOY is built to fail.
 */
const MAIN = buildBlock([DECOY.reveal, PLAIN.reveal, MULTILEAF.reveal, PAIR.reveal]);
const AT = { decoy: 1, plain: 2, multileaf: 3, pair: 4 } as const;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function blockJson(block: TestBlock) {
  return { height: HEIGHT, hash: block.blockHash, header: block.headerHex, txCount: block.txCount };
}

function l2Bundle(block: TestBlock, pos: number, i: Inscribed): ProofBundleJson {
  return {
    version: 1,
    inscriptionId: i.id,
    level: 'L2',
    block: blockJson(block),
    reveal: { hex: bytesToHex(block.txs[pos].raw), pos, txidBranch: block.txidBranch(pos) },
    commit: { hex: bytesToHex(i.commit.raw) },
  };
}

function custodyBundle(block: TestBlock, pos: number, i: Inscribed): CustodyBundleJson {
  return {
    version: 1,
    inscriptionId: i.id,
    hops: [
      {
        block: blockJson(block),
        tx: { hex: bytesToHex(block.txs[pos].raw), pos, txidBranch: block.txidBranch(pos) },
        prevTxs: [bytesToHex(i.commit.raw)],
      },
    ],
    finalSatpoint: `${block.txs[pos].txid}:0:0`,
  };
}

/**
 * A genealogy bundle whose reveal hop is real and whose tail is not. Every
 * test using it asserts a refusal raised at the reveal hop, which the verifier
 * reaches before it reads the funding chain or the coinbase.
 */
function genealogyStub(block: TestBlock, pos: number, i: Inscribed): SatGenealogyBundleJson {
  const hop: CustodyHopJson = {
    block: blockJson(block),
    tx: { hex: bytesToHex(block.txs[pos].raw), pos, txidBranch: block.txidBranch(pos) },
    prevTxs: [bytesToHex(i.commit.raw)],
  };
  return {
    version: 1,
    inscriptionId: i.id,
    reveal: hop,
    funding: [],
    coinbase: clone(hop),
    claimedSat: '0',
  };
}

function headerOf(block: TestBlock) {
  return parseHeader(hexToBytes(block.headerHex));
}

/**
 * A genealogy bundle that walks: coinbase -> commit -> reveal, one funding
 * step. Two rows need one, because the rules they speak for sit past the
 * funding walk and no stub reaches them.
 */
const GENEALOGY_HEIGHT = 1000;
const GENEALOGY_OPTS = { ...NO_POW_FLOOR, trustHeader: (): 'hash-at-height' => 'hash-at-height' };
const GENEALOGY_LEAF = envelopeScript({ body: ['g'] }, { checksigPrefix: true });
const GENEALOGY_TAP = taprootCommit(GENEALOGY_LEAF);
const GENEALOGY_CB = buildCoinbase([{ value: 3_000_000_000n }]);
const GENEALOGY_COMMIT = buildTx(
  [{ txid: GENEALOGY_CB.tx.txid, vout: 0 }],
  [{ value: 10_000n, spk: GENEALOGY_TAP.scriptPubKey }],
);
const GENEALOGY_REVEAL = revealTx(
  [{ script: GENEALOGY_LEAF, controlBlock: GENEALOGY_TAP.controlBlock }],
  { prevTxidLE: GENEALOGY_COMMIT.tx.txidLE, vout: 0 },
);

function genealogyChain(): SatGenealogyBundleJson {
  return {
    version: 1,
    inscriptionId: `${GENEALOGY_REVEAL.txid}i0`,
    reveal: anchoredHop(
      GENEALOGY_REVEAL.txidLE,
      bytesToHex(GENEALOGY_REVEAL.raw),
      GENEALOGY_HEIGHT + 1000,
      [GENEALOGY_COMMIT.hex],
    ),
    funding: [{ tx: { hex: GENEALOGY_COMMIT.hex }, prevTxs: [GENEALOGY_CB.hex] }],
    coinbase: anchoredHop(GENEALOGY_CB.tx.txidLE, GENEALOGY_CB.hex, GENEALOGY_HEIGHT, []),
    claimedSat: firstSatOfBlock(GENEALOGY_HEIGHT).toString(),
  };
}

/**
 * The same transaction with a different envelope in its witness. The txid does
 * not commit to the witness, so this is the forgery L3 exists to catch.
 */
function rewriteWitness(tx: ParsedTx, script: Uint8Array): ParsedTx {
  return parseTx(
    serializeFull({
      version: tx.version,
      inputs: tx.inputs.map((input) => ({
        ...input,
        witness: [input.witness[0], script, input.witness[2]],
      })),
      outputs: tx.outputs,
      locktime: tx.locktime,
    }),
  );
}

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

// ---------------------------------------------------------------------------
// a minimal CBOR encoder for the gallery rows: uint, bstr, array, map
// ---------------------------------------------------------------------------

function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n <= 0xff) return new Uint8Array([(major << 5) | 24, n]);
  return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
}
const cbUint = (n: number) => cborHead(0, n);
const cbBytes = (b: Uint8Array) => concatBytes(cborHead(2, b.length), b);
const cbArray = (items: Uint8Array[]) => concatBytes(cborHead(4, items.length), ...items);
const cbMap = (pairs: [number, Uint8Array][]) =>
  concatBytes(cborHead(5, pairs.length), ...pairs.flatMap(([k, v]) => [cbUint(k), v]));

/** serialized id: internal (LE) txid followed by a trailing-zero-trimmed LE index */
function serializedId(txidDisplay: string, index: number): Uint8Array {
  const idx = [index & 0xff, (index >>> 8) & 0xff, (index >>> 16) & 0xff, (index >>> 24) & 0xff];
  while (idx.length > 0 && idx[idx.length - 1] === 0) idx.pop();
  return concatBytes(displayToInternal(txidDisplay), new Uint8Array(idx));
}

// ---------------------------------------------------------------------------

describe('SPEC-VERIFICATION conformance', () => {
  // -------------------------------------------------------------------------
  // §2 Levels
  // -------------------------------------------------------------------------

  conformance('l2-checks', () => {
    const good = l2Bundle(MAIN, AT.plain, PLAIN);
    expect(verifyProofBundle(good, NO_POW_FLOOR).inscription.body).toBeTruthy();

    // 1. sha256d(stripped(reveal)) = id.txid
    const wrongId = clone(good);
    wrongId.inscriptionId = `${'cd'.repeat(32)}i0`;
    expect(() => verifyProofBundle(wrongId, NO_POW_FLOOR)).toThrow(/reveal tx hashes to/);

    // 2. the txid branch folds to the header's merkle root
    const wrongBranch = clone(good);
    wrongBranch.reveal.txidBranch = MAIN.txidBranch(AT.multileaf);
    expect(() => verifyProofBundle(wrongBranch, NO_POW_FLOOR)).toThrow(
      /merkle proof does not match header merkle root/,
    );

    // 3. the header hashes to the claimed hash and satisfies its own nBits
    const wrongHash = clone(good);
    wrongHash.block.hash = '00'.repeat(32);
    expect(() => verifyProofBundle(wrongHash, NO_POW_FLOOR)).toThrow(/header hashes to/);
    const unmined = clone(good);
    // regtest's target is met by almost any hash, so the header is retargeted
    // to one a random nonce rarely meets and then given a nonce that misses
    // it. The merkle root is untouched, and the claimed hash is recomputed, so
    // the header's own PoW check is the one thing left to refuse it
    const bytes = hexToBytes(MAIN.headerHex);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(72, 0x2000ffff, true);
    for (let nonce = 0; ; nonce++) {
      view.setUint32(76, nonce, true);
      if (!checkProofOfWork(parseHeader(bytes))) break;
    }
    unmined.block.header = bytesToHex(bytes);
    unmined.block.hash = internalToDisplay(sha256d(bytes));
    expect(() => verifyProofBundle(unmined, NO_POW_FLOOR)).toThrow(/fails proof of work/);

    // 4. the envelope at id.index exists
    const absent = clone(good);
    absent.inscriptionId = `${PLAIN.reveal.txid}i5`;
    expect(() => verifyProofBundle(absent, NO_POW_FLOOR)).toThrow(/index 5 not present/);

    // 5. sha256d(stripped(commit)) = reveal.input[j].prevTxid
    const wrongCommit = clone(good);
    wrongCommit.commit = { hex: bytesToHex(MULTILEAF.commit.raw) };
    expect(() => verifyProofBundle(wrongCommit, NO_POW_FLOOR)).toThrow(/commit tx hashes to/);

    // 6. the BIP-341 fold reaches the spent output's key. DECOY's commit pays
    // another key, so checks 1 to 5 pass on it and only this one fails
    expect(() => verifyProofBundle(l2Bundle(MAIN, AT.decoy, DECOY), NO_POW_FLOOR)).toThrow(
      /taproot commitment mismatch/,
    );
  });

  conformance('l2-assurances', () => {
    // controlBlockDepth = 0 implies singleLeafTree, and one input implies
    // singleInputReveal: the two bullets under the sentence
    const plain = verifyProofBundle(l2Bundle(MAIN, AT.plain, PLAIN), NO_POW_FLOOR);
    expect(plain.l2).toEqual({
      controlBlockDepth: 0,
      singleLeafTree: true,
      singleInputReveal: true,
    });

    // a sibling in the control block: the taptree committed more than the leaf shown
    const multileaf = verifyProofBundle(l2Bundle(MAIN, AT.multileaf, MULTILEAF), NO_POW_FLOOR);
    expect(multileaf.l2).toEqual({
      controlBlockDepth: 1,
      singleLeafTree: false,
      singleInputReveal: true,
    });

    // a second input: another witness can contribute envelopes
    const pair = verifyProofBundle(l2Bundle(MAIN, AT.pair, PAIR), NO_POW_FLOOR);
    expect(pair.l2?.singleInputReveal).toBe(false);
    expect(pair.l2?.singleLeafTree).toBe(true);

    // L3 states none of them, because they are what L2 leaves open
    const l3 = verifyProofBundle(l3Bundle(MAIN, AT.pair, PAIR.id), NO_POW_FLOOR);
    expect(l3.level).toBe('L3');
    expect(l3.l2).toBeUndefined();
  });

  conformance('l2-list-unproven', () => {
    // the same reveal at both levels. At L2 the list carries an envelope from
    // an input this level binds nothing about, and the flag says so
    const l2 = verifyProofBundle(l2Bundle(MAIN, AT.pair, PAIR), NO_POW_FLOOR);
    expect(l2.allInscriptions).toHaveLength(2);
    expect(l2.allInscriptions.map((i) => i.input)).toEqual([0, 1]);
    expect(l2.l2?.singleInputReveal).toBe(false);

    // at L3 the whole witness is committed, so the list is proven and no flag
    // stands between the caller and it
    const l3 = verifyProofBundle(l3Bundle(MAIN, AT.pair, PAIR.id), NO_POW_FLOOR);
    expect(l3.allInscriptions).toHaveLength(2);
    expect(l3.l2).toBeUndefined();

    // the single-input case, where the same list IS proven at L2
    const single = verifyProofBundle(l2Bundle(MAIN, AT.plain, PLAIN), NO_POW_FLOOR);
    expect(single.l2?.singleInputReveal).toBe(true);

    // and the sentence this repository's own consumers print for the L2 case,
    // so a consumer told to escalate is told why
    expect(L2_NUMBERING_RESIDUAL).toMatch(/numbering is not proven/);
    expect(L2_NUMBERING_RESIDUAL).toMatch(/L3 witness commitment/);
  });

  conformance('l3-checks', () => {
    const good = l3Bundle(MAIN, AT.plain, PLAIN.id);
    expect(verifyProofBundle(good, NO_POW_FLOOR).level).toBe('L3');
    // the OPTIONAL half of the same sentence, which is what makes this list a
    // different requirement from L2's: no commit section, and still L3
    expect(good.commit).toBeUndefined();

    // 7. the coinbase parses, IS a coinbase, and merkle-proves at position 0
    const notCoinbase = clone(good);
    notCoinbase.witness!.coinbaseHex = bytesToHex(MAIN.txs[AT.plain].raw);
    expect(() => verifyProofBundle(notCoinbase, NO_POW_FLOOR)).toThrow(
      /claimed coinbase is not a coinbase/,
    );
    const offPosition = clone(good);
    offPosition.witness!.coinbaseTxidBranch = MAIN.txidBranch(AT.plain);
    expect(() => verifyProofBundle(offPosition, NO_POW_FLOOR)).toThrow(
      /coinbase txid merkle proof does not match/,
    );

    // 8. the commitment output, and the reserved value read from the
    // coinbase's own witness. The reserved value is not txid-committed, so
    // this arm reaches through a bundle: the branch of check 7 still folds
    const reserved = clone(good);
    const cb = parseTx(hexToBytes(reserved.witness!.coinbaseHex));
    reserved.witness!.coinbaseHex = bytesToHex(
      serializeFull({ ...cb, inputs: [{ ...cb.inputs[0], witness: [sha256(ZERO32)] }] }),
    );
    expect(parseTx(hexToBytes(reserved.witness!.coinbaseHex)).txid, 'the tamper moved the txid')
      .toBe(cb.txid);
    expect(() => verifyProofBundle(reserved, NO_POW_FLOOR)).toThrow(/witness commitment mismatch/);

    // the output itself cannot be removed through a bundle, since removing it
    // moves the coinbase txid and check 7 refuses first, so the rule is driven
    // on a block mined around a coinbase that never had one
    const bare = parseTx(
      serializeFull({
        version: 1,
        inputs: [
          {
            prevTxidLE: ZERO32,
            prevTxid: '0'.repeat(64),
            vout: 0xffffffff,
            scriptSig: new Uint8Array([0x03, 0x09, 0x09, 0x09]),
            sequence: 0xffffffff,
            witness: [ZERO32],
          },
        ],
        outputs: [{ value: 312_500_000n, scriptPubKey: new Uint8Array([0x51]) }],
        locktime: 0,
      }),
    );
    const leaves = [bare.txidLE, PLAIN.reveal.txidLE];
    expect(() =>
      verifyWitnessAnchoring({
        witness: {
          coinbaseHex: bytesToHex(bare.raw),
          coinbaseTxidBranch: buildMerkleBranch(leaves, 0).map(internalToDisplay),
          wtxidBranch: [internalToDisplay(ZERO32)],
        },
        header: parseHeader(mineHeader(computeMerkleRoot(leaves), 0x207fffff)),
        txCount: 2,
        reveal: PLAIN.reveal,
        pos: 1,
      }),
    ).toThrow(/no BIP-141 witness commitment output/);

    // 9. the fold itself, which l3-wtxid drives on its own rules as well
    const foldedWrong = clone(good);
    foldedWrong.witness!.wtxidBranch = MAIN.wtxidBranch(AT.multileaf);
    expect(() => verifyProofBundle(foldedWrong, NO_POW_FLOOR)).toThrow(
      /witness commitment mismatch/,
    );

    // 10. the envelope at the id's index, read from the now-committed witness
    const absent = l3Bundle(MAIN, AT.plain, `${PLAIN.id.slice(0, 64)}i9`);
    expect(() => verifyProofBundle(absent, NO_POW_FLOOR)).toThrow(/9/);
  });

  conformance('l3-wtxid', () => {
    // pos 1 is reachable only in a block of two transactions, where the
    // sibling of the reveal's wtxid leaf is the zeroed coinbase leaf
    const bundle = l3Bundle(MINI, 1, PLAIN.id);
    expect(bundle.witness?.wtxidBranch).toEqual([internalToDisplay(ZERO32)]);
    expect(verifyProofBundle(bundle, NO_POW_FLOOR).level).toBe('L3');

    const notZero = clone(bundle);
    notZero.witness!.wtxidBranch = [bytesToHex(sha256(new TextEncoder().encode('not the leaf')))];
    expect(() => verifyProofBundle(notZero, NO_POW_FLOOR)).toThrow(
      /sibling at position 1 must be the zeroed coinbase leaf/,
    );

    // what the fold is for: the same transaction with another witness keeps
    // its txid and reaches a different wtxid, so the committed 32 bytes no
    // longer match. This is §9's witness-swap vector
    const swapped = clone(bundle);
    const rewritten = rewriteWitness(
      PLAIN.reveal,
      envelopeScript({ fields: [[1, 'text/plain']], body: ['other bytes'] }, { checksigPrefix: true }),
    );
    expect(rewritten.txid).toBe(PLAIN.reveal.txid);
    expect(rewritten.wtxid).not.toBe(PLAIN.reveal.wtxid);
    swapped.reveal.hex = bytesToHex(rewritten.raw);
    expect(() => verifyProofBundle(swapped, NO_POW_FLOOR)).toThrow(/witness commitment mismatch/);

    // position 0 is the coinbase, which carries no envelope, so a bundle
    // cannot present it. The rule lives where the position is read
    expect(() =>
      verifyWitnessAnchoring({
        witness: {
          coinbaseHex: bytesToHex(MINI.txs[0].raw),
          coinbaseTxidBranch: MINI.txidBranch(0),
          wtxidBranch: MINI.wtxidBranch(0),
        },
        header: headerOf(MINI),
        txCount: MINI.txCount,
        reveal: MINI.txs[0],
        pos: 0,
      }),
    ).toThrow(/reveal tx cannot be the coinbase/);
  });

  // -------------------------------------------------------------------------
  // §3 Proof bundle format v1
  // -------------------------------------------------------------------------

  conformance('wire-byte-order', () => {
    const bundle = l2Bundle(MAIN, AT.plain, PLAIN);
    const verified = verifyProofBundle(bundle, NO_POW_FLOOR);
    const reverseHex = (h: string) => bytesToHex(hexToBytes(h).reverse());

    // display order is the reverse of what the hash function produces, and it
    // is what the public API prints, which is the whole of the sentence
    expect(bundle.block.hash).toBe(reverseHex(bytesToHex(sha256d(hexToBytes(bundle.block.header)))));
    expect(bundle.block.hash).toBe(verified.header.hash);
    expect(bundle.inscriptionId.slice(0, 64)).toBe(verified.revealTx.txid);

    // each hash-carrying field in turn, written the other way round. A
    // verifier that read either order would pass all four of these
    const flippedHash = clone(bundle);
    flippedHash.block.hash = reverseHex(bundle.block.hash);
    expect(() => verifyProofBundle(flippedHash, NO_POW_FLOOR)).toThrow(/header hashes to/);

    const flippedId = clone(bundle);
    flippedId.inscriptionId = `${reverseHex(bundle.inscriptionId.slice(0, 64))}i0`;
    expect(() => verifyProofBundle(flippedId, NO_POW_FLOOR)).toThrow(/reveal tx hashes to/);

    const flippedBranch = clone(bundle);
    flippedBranch.reveal.txidBranch = bundle.reveal.txidBranch.map(reverseHex);
    expect(flippedBranch.reveal.txidBranch).not.toEqual(bundle.reveal.txidBranch);
    expect(() => verifyProofBundle(flippedBranch, NO_POW_FLOOR)).toThrow(/merkle/);

    const l3 = l3Bundle(MAIN, AT.plain, PLAIN.id);
    for (const field of ['coinbaseTxidBranch', 'wtxidBranch'] as const) {
      const flipped = clone(l3);
      flipped.witness![field] = l3.witness![field].map(reverseHex);
      expect(() => verifyProofBundle(flipped, NO_POW_FLOOR), field).toThrow();
    }

    // and the transactions, which the same sentence says are hex
    const notHex = clone(bundle);
    notHex.reveal.hex = Buffer.from(hexToBytes(bundle.reveal.hex)).toString('base64');
    expect(() => verifyProofBundle(notHex, NO_POW_FLOOR)).toThrow();
  });

  conformance('txcount-required', () => {
    const good = l2Bundle(MAIN, AT.plain, PLAIN);
    for (const bad of [undefined, null, '5', 5.5, 0, -1]) {
      const b = clone(good);
      (b.block as { txCount?: unknown }).txCount = bad;
      expect(() => verifyProofBundle(b, NO_POW_FLOOR), String(bad)).toThrow(
        /missing valid txCount/,
      );
    }
    expect(verifyProofBundle(good, NO_POW_FLOOR).height).toBe(HEIGHT);
  });

  conformance('commit-required', () => {
    const good = l2Bundle(MAIN, AT.plain, PLAIN);
    const b = clone(good);
    delete (b as { commit?: unknown }).commit;
    expect(() => verifyProofBundle(b, NO_POW_FLOOR)).toThrow(/L2 bundle missing commit tx/);
    expect(verifyProofBundle(good, NO_POW_FLOOR).level).toBe('L2');
  });

  conformance('witness-required', () => {
    const good = l3Bundle(MAIN, AT.plain, PLAIN.id);
    const b = clone(good);
    delete (b as { witness?: unknown }).witness;
    expect(() => verifyProofBundle(b, NO_POW_FLOOR)).toThrow(/L3 bundle missing witness section/);
    expect(verifyProofBundle(good, NO_POW_FLOOR).level).toBe('L3');
  });

  conformance('l2-no-witness', () => {
    // the section attached below verifies at L3 on this very block, so the
    // refusal rests on its presence at L2 and not on its contents
    const l3 = l3Bundle(MAIN, AT.plain, PLAIN.id);
    expect(verifyProofBundle(l3, NO_POW_FLOOR).level).toBe('L3');

    const l2 = l2Bundle(MAIN, AT.plain, PLAIN);
    const carrying = clone(l2) as ProofBundleJson;
    carrying.witness = clone(l3.witness);
    expect(() => verifyProofBundle(carrying, NO_POW_FLOOR)).toThrow(
      /witness section on an L2 bundle/,
    );

    // a null section carries nothing and is still refused, which is the shape
    // a hand-edited bundle reaches for
    const nulled = clone(l2);
    (nulled as { witness?: unknown }).witness = null;
    expect(() => verifyProofBundle(nulled, NO_POW_FLOOR)).toThrow(
      /witness section on an L2 bundle/,
    );

    expect(verifyProofBundle(l2, NO_POW_FLOOR).level).toBe('L2');
  });

  // -------------------------------------------------------------------------
  // §4 Header anchoring
  // -------------------------------------------------------------------------

  conformance('pow-floor', () => {
    // every header here is mined at regtest difficulty, which is exactly the
    // free case the floor exists to remove
    const proof = l2Bundle(MAIN, AT.plain, PLAIN);
    expect(() => verifyProofBundle(proof)).toThrow(/proof-of-work limit 0x1d00ffff/);
    expect(verifyProofBundle(proof, NO_POW_FLOOR).level).toBe('L2');

    const custody = custodyBundle(MAIN, AT.plain, PLAIN);
    expect(() => verifyCustodyBundle(custody)).toThrow(/proof-of-work limit 0x1d00ffff/);
    expect(verifyCustodyBundle(custody, NO_POW_FLOOR).inscriptionId).toBe(PLAIN.id);

    // the genealogy verifier refuses at its reveal hop, the first header it
    // reads. With the floor disabled the same bundle fails further down, so
    // the floor is what refused it above rather than the rest of the document
    const genealogy = genealogyStub(MAIN, AT.plain, PLAIN);
    expect(() => verifySatGenealogy(genealogy)).toThrow(/proof-of-work limit 0x1d00ffff/);
    expect(() => verifySatGenealogy(genealogy, NO_POW_FLOOR)).not.toThrow(
      /proof-of-work limit/,
    );
  });

  conformance('unanchored-note', () => {
    // the sentence a reader is given, in the words the spec uses: nothing was
    // anchored, and the hash at the printed height is what to check
    expect(BUNDLE_HEADERS_UNANCHORED).toMatch(/no header in this bundle was anchored/);
    expect(BUNDLE_HEADERS_UNANCHORED).toMatch(/anchor each block hash at the height/);

    // and the MAY: a result is still reported. The report claims nothing about
    // anchoring, so no consumer can read a yes out of it
    const result = verifyProofBundle(l2Bundle(MAIN, AT.plain, PLAIN), NO_POW_FLOOR);
    expect(result.level).toBe('L2');
    expect(Object.keys(result)).not.toContain('anchored');
  });

  conformance('no-uncheckable-fact', () => {
    // the case the sentence names. The bundle it needs is built and driven on
    // both arms at packages/core/test/satnumber.test.ts, which the citation
    // guard below holds to that test's name; what is re-asserted here is the
    // shape of the rule at the site it lives on
    const source = readFileSync(join(ROOT, 'packages/core/src/satnumber.ts'), 'utf8');
    // refused outright rather than noted: the sub-BIP34 arm throws, and what
    // lifts the refusal is the hook asserting the hash at that height
    expect(source).toMatch(/throw new CoinbaseHeightUnprovenError/);
    expect(source).toMatch(/coinbaseAttestation !== 'hash-at-height'/);
  });

  // -------------------------------------------------------------------------
  // §5 Merkle hardening
  // -------------------------------------------------------------------------

  conformance('merkle-depth-position', () => {
    // REQUIRED in bundles, plural: the proof bundle and the custody hop are
    // the two shapes that carry the field
    const custody = custodyBundle(MAIN, AT.plain, PLAIN);
    const noCount = clone(custody);
    delete (noCount.hops[0].block as { txCount?: unknown }).txCount;
    expect(() => verifyCustodyBundle(noCount, NO_POW_FLOOR)).toThrow(/missing valid txCount/);

    // branch length equals the tree height for txCount
    const leaves = Array.from({ length: 5 }, (_, i) => sha256(new TextEncoder().encode(`leaf${i}`)));
    const root = computeMerkleRoot(leaves);
    const branch = buildMerkleBranch(leaves, 2);
    expect(verifyMerkleBranch(leaves[2], branch, 2, 5).root).toEqual(root);
    expect(() => verifyMerkleBranch(leaves[2], branch.slice(0, 2), 2, 5)).toThrow(
      /branch length 2 != expected height 3/,
    );

    // positions are < txCount
    expect(() => verifyMerkleBranch(leaves[2], branch, 5, 5)).toThrow(
      /position 5 out of range for 5 txs/,
    );

    // and the shape the depth hardening exists to refuse: a count inflated to
    // the next tree height, which would otherwise let a branch prove an inner
    // node as though it were a transaction
    const inflated = clone(l2Bundle(MAIN, AT.plain, PLAIN));
    inflated.block.txCount = 9;
    expect(() => verifyProofBundle(inflated, NO_POW_FLOOR)).toThrow(/branch depth 3 != tree height 4/);
  });

  conformance('merkle-selfpair', () => {
    // odd width, last node: the branch MUST carry the node itself
    const three = Array.from({ length: 3 }, (_, i) => sha256(new TextEncoder().encode(`odd${i}`)));
    const honest = buildMerkleBranch(three, 2);
    expect(honest[0]).toEqual(three[2]);
    expect(verifyMerkleBranch(three[2], honest, 2, 3).root).toEqual(computeMerkleRoot(three));

    const notSelfPaired = [three[0], honest[1]];
    expect(() => verifyMerkleBranch(three[2], notSelfPaired, 2, 3)).toThrow(
      /expected self-paired final node/,
    );

    // even width, final pair identical: the CVE-2012-2459 mutation shape,
    // refused whichever member is being proved
    const four = Array.from({ length: 4 }, (_, i) => sha256(new TextEncoder().encode(`even${i}`)));
    four[3] = four[2];
    for (const pos of [2, 3]) {
      expect(() => verifyMerkleBranch(four[pos], buildMerkleBranch(four, pos), pos, 4), String(pos)).toThrow(
        /duplicate sibling \(possible mutation\)/,
      );
    }

    // the honest odd-width self-pair still verifies through a whole bundle:
    // MAIN holds five transactions, so the leaf at position 4 is the last of
    // an odd-width level and its branch opens with the leaf itself
    expect(MAIN.txCount).toBe(5);
    expect(AT.pair).toBe(4);
    expect(MAIN.txidBranch(4)[0]).toBe(internalToDisplay(MAIN.txs[4].txidLE));
    expect(verifyProofBundle(l2Bundle(MAIN, AT.pair, PAIR), NO_POW_FLOOR).level).toBe('L2');
  });

  conformance('sixty-four-byte', () => {
    expect(TX64.strippedRaw.length).toBe(64);
    const hex = bytesToHex(TX64.raw);

    // the reveal of a proof bundle
    const proof = clone(l2Bundle(MAIN, AT.plain, PLAIN));
    proof.reveal.hex = hex;
    expect(() => verifyProofBundle(proof, NO_POW_FLOOR)).toThrow(/64-byte transactions are rejected/);

    // a custody hop transaction
    const custody = clone(custodyBundle(MAIN, AT.plain, PLAIN));
    custody.hops[0].tx.hex = hex;
    expect(() => verifyCustodyBundle(custody, NO_POW_FLOOR)).toThrow(
      /64-byte transactions are rejected/,
    );

    // the reveal endpoint of a genealogy bundle, which runs the same guard the
    // terminal coinbase and the funding steps run
    const genealogy = clone(genealogyStub(MAIN, AT.plain, PLAIN));
    genealogy.reveal.tx.hex = hex;
    expect(() => verifySatGenealogy(genealogy, NO_POW_FLOOR)).toThrow(
      /64-byte transactions are rejected/,
    );

    // the coinbase of a witness section
    expect(() =>
      verifyWitnessAnchoring({
        witness: {
          coinbaseHex: hex,
          coinbaseTxidBranch: MINI.txidBranch(0),
          wtxidBranch: MINI.wtxidBranch(1),
        },
        header: headerOf(MINI),
        txCount: MINI.txCount,
        reveal: MINI.txs[1],
        pos: 1,
      }),
    ).toThrow(/coinbase: 64-byte transactions are rejected/);
  });

  conformance('coinbase-position-0', () => {
    // MAIN has five transactions, so a branch for position 1 exists and is a
    // different fold from the one the coinbase gets
    const forPositionOne = MAIN.txidBranch(1);
    expect(forPositionOne).not.toEqual(MAIN.txidBranch(0));
    expect(() =>
      verifyWitnessAnchoring({
        witness: {
          coinbaseHex: bytesToHex(MAIN.txs[0].raw),
          coinbaseTxidBranch: forPositionOne,
          wtxidBranch: MAIN.wtxidBranch(AT.plain),
        },
        header: headerOf(MAIN),
        txCount: MAIN.txCount,
        reveal: MAIN.txs[AT.plain],
        pos: AT.plain,
      }),
    ).toThrow(/coinbase txid merkle proof does not match header merkle root/);

    // the honest section, folded at position 0, verifies
    expect(() =>
      verifyWitnessAnchoring({
        witness: {
          coinbaseHex: bytesToHex(MAIN.txs[0].raw),
          coinbaseTxidBranch: MAIN.txidBranch(0),
          wtxidBranch: MAIN.wtxidBranch(AT.plain),
        },
        header: headerOf(MAIN),
        txCount: MAIN.txCount,
        reveal: MAIN.txs[AT.plain],
        pos: AT.plain,
      }),
    ).not.toThrow();

    // The genealogy verifier's own copy of the rule, on a chain that walks to
    // the coinbase it names. This was a source-text assertion until the
    // SPEC-SAT session moved the chain builders into helpers.ts
    const moved = genealogyChain();
    moved.coinbase.tx.pos = 1;
    expect(() => verifySatGenealogy(moved, GENEALOGY_OPTS)).toThrow(
      /coinbase must be at position 0, bundle says 1/,
    );
    expect(verifySatGenealogy(genealogyChain(), GENEALOGY_OPTS).coinbaseHeight).toBe(
      GENEALOGY_HEIGHT,
    );
  });

  // -------------------------------------------------------------------------
  // §7 Galleries
  // -------------------------------------------------------------------------

  conformance('gallery-encodings', () => {
    const a = 'a'.repeat(64);
    const b = '00'.repeat(31) + 'ff';
    const expected = [`${a}i0`, `${b}i7`];

    // inline: each Item carries its own serialized id under Item key 0. The
    // 32-byte form is index 0 with every trailing zero trimmed away
    const inline = cbMap([
      [
        0,
        cbArray([
          cbMap([[0, cbBytes(serializedId(a, 0))]]),
          cbMap([[0, cbBytes(serializedId(b, 7))]]),
        ]),
      ],
    ]);
    expect(serializedId(a, 0)).toHaveLength(32);
    expect(parseGallery(inline)).toEqual({ isGallery: true, items: expected, skipped: 0 });

    // packed: properties key 2 holds the concatenated txids and the Item at
    // array position i takes txid slice i. An absent index means 0
    const packed = cbMap([
      [
        0,
        cbArray([cbMap([]), cbMap([[2, cbUint(7)]])]),
      ],
      [2, cbBytes(concatBytes(displayToInternal(a), displayToInternal(b)))],
    ]);
    expect(parseGallery(packed)).toEqual({ isGallery: true, items: expected, skipped: 0 });

    // interchangeable: the same member list, either way round
    expect(parseGallery(packed).items).toEqual(parseGallery(inline).items);
  });

  conformance('gallery-lenient', () => {
    const a = 'a'.repeat(64);
    const b = '00'.repeat(31) + 'ff';

    // the middle entry is a truncated id, which decodes to nothing. The
    // entries around it survive, in order, and the count states what was
    // dropped, so a caller can tell a complete list from a partial one
    const withJunk = cbMap([
      [
        0,
        cbArray([
          cbMap([[0, cbBytes(serializedId(a, 0))]]),
          cbMap([[0, cbBytes(serializedId(b, 0).slice(0, 12))]]),
          cbMap([[0, cbBytes(serializedId(b, 7))]]),
        ]),
      ],
    ]);
    expect(parseGallery(withJunk)).toEqual({
      isGallery: true,
      items: [`${a}i0`, `${b}i7`],
      skipped: 1,
    });

    // the same list with the junk removed, so the skip is shown to cost the
    // list nothing but the entry that did not decode
    const clean = cbMap([
      [
        0,
        cbArray([
          cbMap([[0, cbBytes(serializedId(a, 0))]]),
          cbMap([[0, cbBytes(serializedId(b, 7))]]),
        ]),
      ],
    ]);
    expect(parseGallery(clean).items).toEqual(parseGallery(withJunk).items);
    expect(parseGallery(clean).skipped).toBe(0);

    // properties carrying no Items array: a non-gallery result. The packed
    // txids alone are not a member list, since nothing says how many members
    // they name
    expect(parseGallery(cbMap([[2, cbBytes(displayToInternal(a))]]))).toEqual({
      isGallery: false,
      items: [],
      skipped: 0,
    });
    expect(parseGallery(cbMap([])).isGallery).toBe(false);

    // and the condition the promoted sentence had to gain: an Items array
    // that IS there and IS empty declares a gallery with no members, which
    // keeps it distinguishable from an inscription declaring no gallery
    expect(parseGallery(cbMap([[0, cbArray([])]]))).toEqual({
      isGallery: true,
      items: [],
      skipped: 0,
    });
  });

  conformance('gallery-compressed', () => {
    const items = cbMap([[0, cbArray([cbMap([[0, cbBytes(serializedId('a'.repeat(64), 0))]])])]]);

    // the same properties bytes, with and without a declared encoding. The
    // second is the answer a reader gets when it can read them
    const readable: Pick<Inscription, 'properties' | 'propertyEncoding'> = { properties: items };
    expect(galleryItems(readable)).toEqual([`${'a'.repeat(64)}i0`]);

    const compressed = { properties: items, propertyEncoding: 'br' } as Pick<
      Inscription,
      'properties' | 'propertyEncoding'
    >;
    expect(() => inscriptionGallery(compressed)).toThrow(GalleryEncodingError);
    expect(() => inscriptionGallery(compressed)).toThrow(/still compressed/);

    // distinguishable by the caller: a refusal is a class it can catch, and an
    // inscription declaring no gallery is a value it can read. The two answers
    // cannot be confused for each other
    const noGallery = { properties: undefined } as Pick<
      Inscription,
      'properties' | 'propertyEncoding'
    >;
    expect(inscriptionGallery(noGallery)).toEqual({ isGallery: false, items: [], skipped: 0 });

    // and once the caller decompresses them, the same inscription reads
    expect(inscriptionGallery(compressed, { decodedProperties: items }).items).toEqual([
      `${'a'.repeat(64)}i0`,
    ]);
  });

  // -------------------------------------------------------------------------
  // §9 Conformance vectors
  // -------------------------------------------------------------------------

  /**
   * §9's negative vectors are driven in the fetch companion, because two of
   * the seven fail with codes only a resolver assigns. Five of them are also
   * covered by rows above, harder and one mechanism at a time: the witness
   * swap by `l3-wtxid`, the absent envelope index and the tampered tapscript
   * by `l2-checks`, and the txCount inflation by `merkle-depth-position`.
   */

  // -------------------------------------------------------------------------
  // the accounting
  // -------------------------------------------------------------------------

  /**
   * SPEC-VERIFICATION states three requirements with REQUIRED and no MUST, so
   * the normative set is every line carrying either keyword. The spec has no
   * RFC 2119 boilerplate line, so no line is excluded by name.
   */
  const NORMATIVE = /\b(MUST|REQUIRED)\b/;

  it('SPEC-VERIFICATION.md: every normative line is accounted for by a row in the table', () => {
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
      `SPEC-VERIFICATION.md states requirements no row accounts for:\n${unaccounted.join('\n')}`,
    ).toEqual([]);

    // and the other direction: a row claiming a line that carries no keyword
    // would mean the table drifted off the requirements it accounts for
    expect(claimed.size).toBe(normative.length);
  });

  /**
   * The filter choice itself, measured rather than assumed. A SHALL added to
   * this spec would state a requirement the accounting above cannot see, so
   * the choice is re-measured here and fails when the file gains a keyword the
   * pattern does not carry. The REQUIRED count is measured beside the MUST
   * count because widening the pattern was a judgement call: three lines carry
   * REQUIRED alone and a fourth shares its line with a MUST, so the two counts
   * differing by three is what the widening buys. SHOULD, OPTIONAL and MAY
   * state no requirement, so they are counted rather than banned: a reader can
   * see what the filter leaves outside it.
   */
  it('SPEC-VERIFICATION.md: MUST and REQUIRED are the only RFC 2119 requirement keywords in the file', () => {
    for (const keyword of ['SHALL', 'RECOMMENDED']) {
      expect(SPEC.match(new RegExp(`\\b${keyword}\\b`, 'g')), keyword).toBeNull();
    }
    expect(SPEC.match(/\bMUST\b/g)).toHaveLength(37);
    expect(SPEC.match(/\bMUST NOT\b/g)).toHaveLength(7);
    expect(SPEC.match(/\bREQUIRED\b/g)).toHaveLength(4);

    const lines = SPEC.split('\n');
    expect(lines.filter((l) => NORMATIVE.test(l))).toHaveLength(38);
    expect(
      lines.filter((l) => /\bMUST\b/.test(l)),
      'the three the widened pattern adds carry REQUIRED alone',
    ).toHaveLength(35);

    expect(SPEC.match(/\bSHOULD\b/g)).toHaveLength(6);
    expect(SPEC.match(/\bOPTIONAL\b/g)).toHaveLength(1);
    expect(SPEC.match(/\bMAY\b/g)).toHaveLength(3);
  });

  it('SPEC-VERIFICATION.md: the table says how each requirement is covered', () => {
    for (const r of TABLE) {
      expect(r.why.length, `${r.id} has no reasoning`).toBeGreaterThan(20);
      expect(r.binds.length, `${r.id} does not say who it binds`).toBeGreaterThan(0);
      expect(r.title, `${r.id} is not named for its requirement`).toMatch(/MUST|REQUIRED/);
    }
    // the rows no test asserts, kept visible rather than counted: a reader of
    // the list sees the coverage gap without reading the file
    const notTested = TABLE.filter((r) => r.status.startsWith('unimplemented,')).map((r) => r.id);
    expect(notTested).toEqual([]);
  });

  it('SPEC-VERIFICATION.md: every `tested at` row names a test that still exists', () => {
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
   * The split across three files, checked from both ends. Each companion runs
   * the same check for its own rows, so a row that moved between files without
   * a test moving with it fails on one side or the other. Each is named here
   * and asserted to read this table, so a companion deleted wholesale takes
   * this test down with it rather than leaving its rows unspoken for.
   */
  it('SPEC-VERIFICATION.md: this file speaks for exactly the core rows', () => {
    expect([...SPOKEN].sort()).toEqual(drivenIdsFor('core').sort());
    for (const [file, path] of [
      ['fetch', 'packages/fetch/test/spec-verification.anchoring.test.ts'],
      ['servers', 'packages/sidecar/test/spec-verification.servers.test.ts'],
    ] as const) {
      expect(idsFor(file).length, `${file} drives no rows`).toBeGreaterThan(0);
      expect(readFileSync(join(ROOT, path), 'utf8')).toContain('spec-verification.rows.js');
    }
  });
});

