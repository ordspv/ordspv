/**
 * Conformance suite for SPEC-CUSTODY.md: one test per normative sentence,
 * named for the sentence it speaks for.
 *
 * The accounting table is `spec-custody.rows.ts`, shared with
 * `packages/fetch/test/spec-custody.builder.test.ts`, which drives the rows
 * whose code lives in @ordspv/fetch. The accounting test at the bottom of this
 * file sums the WHOLE spec against every row in that table, whichever file
 * drives it, so a requirement added to the spec fails this suite until
 * somebody accounts for it and a row cannot be lost between the two files.
 *
 * Duplication with custody.test.ts is deliberate, and heavier here than in the
 * SPEC-SAT suite, because `custody.ts` is the older code and its own file
 * covers it hard. The job here is traceability from the sentence to a test, so
 * a thin re-assertion is the normal case and a `tested at` row is for where a
 * thin one would be disproportionate.
 *
 * Every fixture is a real chain: a commit paying a taproot output that commits
 * the envelope, a reveal spending it, and where a rule needs one, a later hop
 * spending the reveal. Blocks come from `buildBlock`, so each carries a
 * coinbase beside its transaction and the merkle branches are real.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  bytesToHex,
  formatSatpoint,
  genesisSatpoint,
  hexToBytes,
  inscriptionsFromTx,
  parseHeader,
  parseTx,
  serializeFull,
  sha256d,
  internalToDisplay,
  transferSatpoint,
  verifyCustodyBundle,
  verifyEnvelopeBinding,
  type CustodyBundleJson,
  type CustodyHopJson,
  type ParsedTx,
} from '../src/index.js';
import {
  NO_POW_FLOOR,
  buildBlock,
  buildSegwitTx,
  buildTx,
  envelopeScript,
  taprootCommit,
  type OutSpec,
  type TestBlock,
} from './helpers.js';
import { ROOT, SPEC, TABLE, anchor, drivenIdsFor, idsFor, row } from './spec-custody.rows.js';

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
  it(`SPEC-CUSTODY.md ${r.section}: ${r.title}`, async () => {
    anchor(r.quote);
    await body();
  });
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * Blocks here are mined at regtest difficulty, which the default
 * proof-of-work floor refuses. The floor is a rule of its own and the
 * per-hop-anchoring row drives it; every other row disables it so the
 * refusal under test is the one the sentence names.
 */
const SIG = new Uint8Array(64).fill(7);
const T0 = '11'.repeat(32);
const T1 = '22'.repeat(32);

/** distinct commits, so no two fixtures share a txid */
let commitSeed = 0;

function envelope(fields: [number, Uint8Array | string][], body: string): Uint8Array {
  return envelopeScript({ fields, body: [body] }, { checksigPrefix: true });
}

/** tag 2, the pointer, little-endian */
function pointerField(n: number): [number, Uint8Array] {
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.push(v % 256);
  return [2, new Uint8Array(b.length ? b : [0])];
}

const ENV = envelope([[1, 'text/plain']], 'custody');
const ENV_B = envelope([[1, 'text/plain']], 'second');

interface Chain {
  commit: { hex: string; tx: ParsedTx };
  reveal: { hex: string; tx: ParsedTx };
  block: TestBlock;
  /** the reveal's position in its block; buildBlock puts the coinbase at 0 */
  pos: number;
  bundle(index?: number): CustodyBundleJson;
}

/**
 * commit -> single-input reveal, the reveal alone in its block beside the
 * coinbase. `commitValue` at zero is the unbound case; `commitSpk` overrides
 * the taproot output for the non-P2TR case.
 */
function revealChain(
  leaf: Uint8Array,
  outputs: OutSpec[],
  opts: { commitValue?: bigint; commitSpk?: Uint8Array } = {},
): Chain {
  const tap = taprootCommit(leaf);
  const commit = buildTx(
    [{ txid: T0, vout: commitSeed++ }],
    [{ value: opts.commitValue ?? 10_000n, spk: opts.commitSpk ?? tap.scriptPubKey }],
  );
  const reveal = buildSegwitTx(
    [{ txid: commit.tx.txid, vout: 0, witness: [SIG, leaf, tap.controlBlock] }],
    outputs,
  );
  const block = buildBlock([reveal.tx]);
  const pos = 1;
  return {
    commit,
    reveal,
    block,
    pos,
    bundle(index = 0): CustodyBundleJson {
      // the claim the verifier recomputes. A chain built to be refused has no
      // genesis to claim, and the refusal fires above the comparison, so the
      // placeholder is never read
      let claim = `${reveal.tx.txid}:0:0`;
      try {
        claim = formatSatpoint(
          genesisSatpoint(
            reveal.tx,
            inscriptionsFromTx(reveal.tx).find((i) => i.index === index)!,
            [opts.commitValue ?? 10_000n],
          ),
        );
      } catch {
        /* the fixture is one the verifier refuses before reading the claim */
      }
      return {
        version: 1,
        inscriptionId: `${reveal.tx.txid}i${index}`,
        hops: [revealHop(block, pos, reveal.hex, [commit.hex])],
        finalSatpoint: claim,
      };
    },
  };
}

function revealHop(
  block: TestBlock,
  pos: number,
  hex: string,
  prevTxs: string[],
  height = 800_000,
): CustodyHopJson {
  return {
    block: { height, hash: block.blockHash, header: block.headerHex, txCount: block.txCount },
    tx: { hex, pos, txidBranch: block.txidBranch(pos) },
    prevTxs,
  };
}

/** the L3 witness section for the transaction at `pos` in `block` */
function section(block: TestBlock, pos: number): NonNullable<CustodyHopJson['witness']> {
  return {
    coinbaseHex: bytesToHex(block.txs[0].raw),
    coinbaseTxidBranch: block.txidBranch(0),
    wtxidBranch: block.wtxidBranch(pos),
  };
}

/** re-serialize with one witness replaced; the txid cannot change */
function withWitness(tx: ParsedTx, k: number, witness: Uint8Array[]): ParsedTx {
  return parseTx(
    serializeFull({
      version: tx.version,
      inputs: tx.inputs.map((inp, i) => (i === k ? { ...inp, witness } : inp)),
      outputs: tx.outputs,
      locktime: tx.locktime,
    }),
  );
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** the plain single-input chain most rows start from: genesis at reveal:0:0 */
const SINGLE = revealChain(ENV, [{ value: 9_000n }]);

/**
 * A two-input reveal carrying two envelopes, each committed by its own
 * prevout. Envelope 1 starts at 10,000, which is inside output 0.
 */
const commitM = buildTx(
  [{ txid: T1, vout: commitSeed++ }],
  [
    { value: 10_000n, spk: taprootCommit(ENV).scriptPubKey },
    { value: 20_000n, spk: taprootCommit(ENV_B).scriptPubKey },
  ],
);
const revealM = buildSegwitTx(
  [
    { txid: commitM.tx.txid, vout: 0, witness: [SIG, ENV, taprootCommit(ENV).controlBlock] },
    { txid: commitM.tx.txid, vout: 1, witness: [SIG, ENV_B, taprootCommit(ENV_B).controlBlock] },
  ],
  [{ value: 25_000n }],
);
const blockM = buildBlock([revealM.tx]);

/**
 * The same reveal one position deeper, so its wtxid branch carries an element
 * the position-1 rule does not speak for and the commitment fold can be broken
 * on its own.
 */
const filler = buildTx([{ txid: T1, vout: commitSeed++ }], [{ value: 1n }]);
const blockM3 = buildBlock([filler.tx, revealM.tx]);

function multiBundle3(): CustodyBundleJson {
  const hop = revealHop(blockM3, 2, revealM.hex, [commitM.hex, commitM.hex]);
  hop.witness = section(blockM3, 2);
  return {
    version: 1,
    inscriptionId: `${revealM.tx.txid}i1`,
    hops: [hop],
    finalSatpoint: `${revealM.tx.txid}:0:10000`,
  };
}

/**
 * A two-input reveal carrying an envelope on each input, its witness section
 * attached so the numbering is proven, and the caller stating the satpoint it
 * expects the walk to fold to. The input values are the row's own, since the
 * position rules are about what the inputs before the envelope's hold.
 */
function multiChain(
  v0: bigint,
  v1: bigint,
  outputs: OutSpec[],
): { reveal: ParsedTx; bundle(index: number, claim: string): CustodyBundleJson } {
  const commit = buildTx(
    [{ txid: T1, vout: commitSeed++ }],
    [
      { value: v0, spk: taprootCommit(ENV).scriptPubKey },
      { value: v1, spk: taprootCommit(ENV_B).scriptPubKey },
    ],
  );
  const reveal = buildSegwitTx(
    [
      { txid: commit.tx.txid, vout: 0, witness: [SIG, ENV, taprootCommit(ENV).controlBlock] },
      { txid: commit.tx.txid, vout: 1, witness: [SIG, ENV_B, taprootCommit(ENV_B).controlBlock] },
    ],
    outputs,
  );
  const block = buildBlock([reveal.tx]);
  return {
    reveal: reveal.tx,
    bundle(index: number, claim: string): CustodyBundleJson {
      const hop = revealHop(block, 1, reveal.hex, [commit.hex, commit.hex]);
      hop.witness = section(block, 1);
      return {
        version: 1,
        inscriptionId: `${reveal.tx.txid}i${index}`,
        hops: [hop],
        finalSatpoint: claim,
      };
    },
  };
}

/** a multi-input bundle, with the witness section unless `bare` is set */
function multiBundle(index: number, bare = false): CustodyBundleJson {
  const hop = revealHop(blockM, 1, revealM.hex, [commitM.hex, commitM.hex]);
  if (!bare) hop.witness = section(blockM, 1);
  return {
    version: 1,
    inscriptionId: `${revealM.tx.txid}i${index}`,
    hops: [hop],
    finalSatpoint: `${revealM.tx.txid}:0:${index === 0 ? 0 : 10_000}`,
  };
}

/** a later hop spending `from`:0 into `outputs`, in its own block */
function laterHop(
  from: ParsedTx,
  outputs: OutSpec[],
  height: number,
  extra: { vout?: number; alsoSpend?: { txid: string; vout: number } } = {},
): { spend: { hex: string; tx: ParsedTx }; block: TestBlock; hop: CustodyHopJson } {
  const inputs = [{ txid: from.txid, vout: extra.vout ?? 0 }];
  if (extra.alsoSpend) inputs.push(extra.alsoSpend);
  const spend = buildTx(inputs, outputs);
  const block = buildBlock([spend.tx]);
  return { spend, block, hop: revealHop(block, 1, spend.hex, [bytesToHex(from.raw)], height) };
}

/** SINGLE plus one hop: reveal:0:0 -> spend:0:0. Cloned, since tests mutate. */
function twoHopBundle(): CustodyBundleJson {
  const b = SINGLE.bundle();
  b.hops.push(clone(SPEND.hop));
  b.finalSatpoint = `${SPEND.spend.tx.txid}:0:0`;
  return b;
}
const SPEND = laterHop(SINGLE.reveal.tx, [{ value: 8_000n }], 800_010);

/** a header re-stamped with a harder target, so it fails the target it states */
function harderTarget(headerHex: string): { header: string; hash: string } {
  const bytes = hexToBytes(headerHex);
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(72, 0x1d00ffff, true);
  return { header: bytesToHex(bytes), hash: internalToDisplay(sha256d(bytes)) };
}

// ---------------------------------------------------------------------------

describe('SPEC-CUSTODY conformance', () => {
  // -------------------------------------------------------------------------
  // Genesis satpoint
  // -------------------------------------------------------------------------

  conformance('default-genesis-position', () => {
    // the sum runs over the inputs BEFORE the envelope's own, and the result
    // is mapped through the outputs in order. Input 0 holds 700 sats and the
    // outputs are 500 then 450, so the envelope at input 1 starts 200 sats
    // into output 1
    const chain = multiChain(700n, 20_000n, [{ value: 500n }, { value: 450n }]);
    const at1 = verifyCustodyBundle(chain.bundle(1, `${chain.reveal.txid}:1:200`), NO_POW_FLOOR);
    expect(at1.genesis.vout, 'the position walked past output 0').toBe(1);
    expect(at1.genesis.offset).toBe(200n);
    expect(at1.indexProof, 'the numbering is proven, so the position is the only rule left').toBe(
      'wtxid',
    );

    // the empty sum at k = 0, which is the same rule with nothing before it
    const at0 = verifyCustodyBundle(chain.bundle(0, `${chain.reveal.txid}:0:0`), NO_POW_FLOOR);
    expect(at0.genesis.vout).toBe(0);
    expect(at0.genesis.offset).toBe(0n);

    // the two answers a different reading of the sentence gives, refused by
    // the recomputation rather than accepted from the claim
    for (const [what, claim] of [
      ['a verifier starting the sum at the envelope input', `${chain.reveal.txid}:0:0`],
      ['one not mapping the position through the outputs in order', `${chain.reveal.txid}:0:700`],
    ] as const) {
      expect(() => verifyCustodyBundle(chain.bundle(1, claim), NO_POW_FLOOR), what).toThrow(
        /path folds to/,
      );
    }
  });

  conformance('zero-value-outputs-skipped', () => {
    // a leading zero-value output is the sharp arm: the first sat of the
    // transaction is in output 1, and an implementation indexing outputs by
    // position rather than by sat space names a location holding no sat
    const leading = revealChain(ENV, [{ value: 0n }, { value: 900n }]);
    const g = verifyCustodyBundle(leading.bundle(), NO_POW_FLOOR).genesis;
    expect(g.vout, 'output 0 occupies no sat space').toBe(1);
    expect(g.offset).toBe(0n);

    // an interior one, reached by a pointer landing exactly where it sits
    const interior = revealChain(envelope([[1, 'text/plain'], pointerField(500)], 'custody'), [
      { value: 500n },
      { value: 0n },
      { value: 450n },
    ]);
    const gi = verifyCustodyBundle(interior.bundle(), NO_POW_FLOOR).genesis;
    expect(gi.vout, 'the position skips the empty output between them').toBe(2);
    expect(gi.offset).toBe(0n);

    // and on a later hop, since one mapping serves the reveal and every
    // transfer and the sentence speaks of "a position" rather than of genesis
    const onward = laterHop(leading.reveal.tx, [{ value: 0n }, { value: 900n }], 800_010, {
      vout: 1,
    });
    const b = leading.bundle();
    b.hops.push(onward.hop);
    b.finalSatpoint = `${onward.spend.tx.txid}:1:0`;
    expect(verifyCustodyBundle(b, NO_POW_FLOOR).satpoint.vout).toBe(1);
  });

  conformance('pointer-out-of-range-ignored', () => {
    // "ignored" is a claim about which of two answers comes back, not about a
    // refusal, so the fallback is compared against the answer the same reveal
    // gives with no pointer at all
    const outputs: OutSpec[] = [{ value: 500n }, { value: 450n }];
    const plain = revealChain(ENV, outputs);
    const dflt = verifyCustodyBundle(plain.bundle(), NO_POW_FLOOR).genesis;
    expect(dflt.vout, 'the default position is the first sat of output 0').toBe(0);
    expect(dflt.offset).toBe(0n);

    // one below the total: the pointer decides
    const inside = revealChain(envelope([[1, 'text/plain'], pointerField(949)], 'custody'), outputs);
    const at949 = verifyCustodyBundle(inside.bundle(), NO_POW_FLOOR).genesis;
    expect(at949.vout).toBe(1);
    expect(at949.offset).toBe(449n);

    // the total itself and one past it: ignored, so the default comes back
    for (const p of [950, 951]) {
      const chain = revealChain(envelope([[1, 'text/plain'], pointerField(p)], 'custody'), outputs);
      const res = verifyCustodyBundle(chain.bundle(), NO_POW_FLOOR);
      expect(inscriptionsFromTx(chain.reveal.tx)[0].pointer, `pointer ${p} is in the envelope`).toBe(
        BigInt(p),
      );
      expect(res.genesis.vout, `pointer ${p} is ignored`).toBe(0);
      expect(res.genesis.offset).toBe(0n);
    }
  });

  conformance('unbound-refusal', () => {
    // a zero-value envelope input, whose default position is inside the
    // outputs, so only the unbound rule can refuse it
    const zero = revealChain(ENV, [{ value: 700n }], { commitValue: 0n });
    expect(() => verifyCustodyBundle(zero.bundle(), NO_POW_FLOOR)).toThrow(CustodyUnsupportedError);
    expect(() => verifyCustodyBundle(zero.bundle(), NO_POW_FLOOR)).toThrow(/unbound/);

    // "regardless of pointer or position": the same input with a pointer that
    // would otherwise resolve
    const zeroPtr = revealChain(envelope([[1, 'text/plain'], pointerField(300)], 'custody'), [
      { value: 700n },
    ], { commitValue: 0n });
    expect(() => verifyCustodyBundle(zeroPtr.bundle(), NO_POW_FLOOR)).toThrow(
      CustodyUnsupportedError,
    );

    // and the other condition, on a funded input: an unrecognized EVEN field
    const evenField = revealChain(envelope([[1, 'text/plain'], [22, 'x']], 'custody'), [
      { value: 700n },
    ]);
    expect(inscriptionsFromTx(evenField.reveal.tx)[0].flags.unrecognizedEvenField).toBe(true);
    expect(() => verifyCustodyBundle(evenField.bundle(), NO_POW_FLOOR)).toThrow(
      CustodyUnsupportedError,
    );
  });

  conformance('fee-bound-refusal', () => {
    // the boundary with one sat moved across it. The envelope input starts at
    // position 0, so the total output sats is what decides: one sat of output
    // space resolves, none of it is a reveal that paid everything to fees
    const oneSat = revealChain(ENV, [{ value: 1n }]);
    expect(verifyCustodyBundle(oneSat.bundle(), NO_POW_FLOOR).genesis.offset).toBe(0n);

    const noSats = revealChain(ENV, [{ value: 0n }]);
    const b = noSats.bundle();
    b.finalSatpoint = `${noSats.reveal.tx.txid}:0:0`; // never reached
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(CustodyUnsupportedError);
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(/fee/);
    // the block a caller would have to account for is named
    try {
      verifyCustodyBundle(b, NO_POW_FLOOR);
      expect.unreachable('the fee-bound reveal verified');
    } catch (e) {
      expect((e as CustodyUnsupportedError).height).toBe(800_000);
    }
  });

  conformance('values-from-prevtxs', () => {
    // a two-input hop, so the entries can be right transactions in the wrong
    // places: a verifier matching by txid rather than by position accepts this
    const fundX = buildTx([{ txid: T1, vout: commitSeed++ }], [{ value: 5_000n }]);
    const two = laterHop(SINGLE.reveal.tx, [{ value: 13_000n }], 800_010, {
      alsoSpend: { txid: fundX.tx.txid, vout: 0 },
    });
    const good = SINGLE.bundle();
    good.hops.push({ ...two.hop, prevTxs: [SINGLE.reveal.hex, fundX.hex] });
    good.finalSatpoint = `${two.spend.tx.txid}:0:0`;
    expect(verifyCustodyBundle(good, NO_POW_FLOOR).satpoint.txid).toBe(two.spend.tx.txid);

    const swapped = clone(good);
    swapped.hops[1].prevTxs = [fundX.hex, SINGLE.reveal.hex];
    expect(() => verifyCustodyBundle(swapped, NO_POW_FLOOR)).toThrow(/prev tx 0 hashes to/);

    // and the values really come from those bytes: editing the funded output
    // moves the txid, so a verifier reading values from anywhere else would
    // have to be handed them
    const edited = buildTx([{ txid: T0, vout: 0 }], [{ value: 9_001n }]);
    expect(edited.tx.txid).not.toBe(SINGLE.reveal.tx.txid);
    const lied = clone(good);
    lied.hops[1].prevTxs = [edited.hex, fundX.hex];
    expect(() => verifyCustodyBundle(lied, NO_POW_FLOOR)).toThrow(/prev tx 0 hashes to/);
  });

  conformance('prevtx-past-input-count', () => {
    // the sentence draws a line between two surpluses, and the arms fall on
    // opposite sides: within the input count, ignored; past it, refused
    const fundX = buildTx([{ txid: T1, vout: commitSeed++ }], [{ value: 5_000n }]);
    const two = laterHop(SINGLE.reveal.tx, [{ value: 13_000n }], 800_010, {
      alsoSpend: { txid: fundX.tx.txid, vout: 0 },
    });
    const b = SINGLE.bundle();
    b.hops.push({ ...two.hop, prevTxs: [SINGLE.reveal.hex, fundX.hex] });
    b.finalSatpoint = `${two.spend.tx.txid}:0:0`;

    // input 1 is inside the count and past the input the walk reads, so its
    // entry is never hashed: a verifier hashing everything supplied fails here
    const unhashed = clone(b);
    unhashed.hops[1].prevTxs = [SINGLE.reveal.hex, 'not a transaction at all'];
    expect(verifyCustodyBundle(unhashed, NO_POW_FLOOR).satpoint.txid).toBe(two.spend.tx.txid);

    // one more entry than the transaction has inputs corresponds to no input
    const surplus = clone(b);
    surplus.hops[1].prevTxs = [SINGLE.reveal.hex, fundX.hex, SINGLE.reveal.hex];
    expect(() => verifyCustodyBundle(surplus, NO_POW_FLOOR)).toThrow(
      /3 prev txs supplied for 2 input\(s\)/,
    );
    expect(() => verifyCustodyBundle(surplus, NO_POW_FLOOR)).toThrow(
      /corresponds to no input/,
    );
  });

  // -------------------------------------------------------------------------
  // Envelope binding
  // -------------------------------------------------------------------------

  conformance('indexproof-recorded', () => {
    // a field that never varies would satisfy a thinner test, so both values
    // are read off bundles that verify
    expect(verifyCustodyBundle(SINGLE.bundle(), NO_POW_FLOOR).indexProof).toBe('single-input');
    expect(verifyCustodyBundle(multiBundle(1), NO_POW_FLOOR).indexProof).toBe('wtxid');
  });

  conformance('wtxid-section-verified', () => {
    // the honest section first, so every breakage below is the one thing moved
    expect(verifyCustodyBundle(multiBundle(1), NO_POW_FLOOR).indexProof).toBe('wtxid');

    const breakages: [string, (b: CustodyBundleJson) => void, RegExp][] = [
      [
        'a coinbase that is not one',
        (b) => {
          b.hops[0].witness!.coinbaseHex = SINGLE.reveal.hex;
        },
        /coinbase/i,
      ],
      [
        'a coinbase branch of the wrong depth',
        (b) => {
          b.hops[0].witness!.coinbaseTxidBranch = [];
        },
        /depth|branch/i,
      ],
      [
        'a coinbase branch that folds elsewhere',
        (b) => {
          b.hops[0].witness!.coinbaseTxidBranch = ['00'.repeat(32)];
        },
        /merkle|coinbase/i,
      ],
      [
        'a wtxid branch of the wrong depth',
        (b) => {
          b.hops[0].witness!.wtxidBranch = [];
        },
        /wtxid branch depth/,
      ],
      [
        'the zeroed coinbase leaf replaced at position 1',
        (b) => {
          b.hops[0].witness!.wtxidBranch = ['11'.repeat(32)];
        },
        /must be the zeroed coinbase leaf/,
      ],
    ];
    for (const [what, breakIt, message] of breakages) {
      const b = multiBundle(1);
      breakIt(b);
      expect(() => verifyCustodyBundle(b, NO_POW_FLOOR), what).toThrow(message);
    }

    // the commitment fold itself, which the zeroed-leaf rule hides at position
    // 1: the same reveal a block deeper, where the branch has a second element
    // no other rule speaks for
    expect(verifyCustodyBundle(multiBundle3(), NO_POW_FLOOR).indexProof).toBe('wtxid');
    const folds = multiBundle3();
    folds.hops[0].witness!.wtxidBranch = [
      folds.hops[0].witness!.wtxidBranch[0],
      '11'.repeat(32),
    ];
    expect(() => verifyCustodyBundle(folds, NO_POW_FLOOR)).toThrow(/witness commitment mismatch/);

    // and the reveal presented as the coinbase, which a verifier checking only
    // the fold would accept
    const swapped = multiBundle(1);
    swapped.hops[0].witness!.coinbaseHex = bytesToHex(blockM.txs[1].raw);
    swapped.hops[0].witness!.coinbaseTxidBranch = blockM.txidBranch(1);
    expect(() => verifyCustodyBundle(swapped, NO_POW_FLOOR)).toThrow();

    // an absent commitment output in an otherwise real coinbase
    const noCommit = multiBundle(1);
    const cb = blockM.txs[0];
    noCommit.hops[0].witness!.coinbaseHex = bytesToHex(
      serializeFull({
        version: cb.version,
        inputs: cb.inputs,
        outputs: [cb.outputs[0]],
        locktime: cb.locktime,
      }),
    );
    expect(() => verifyCustodyBundle(noCommit, NO_POW_FLOOR)).toThrow();
  });

  conformance('no-fallback-past-failing-section', () => {
    // the fallback is only visible where it would have succeeded: a
    // single-input reveal needs no section, and the same bundle without one
    // verifies
    expect(verifyCustodyBundle(SINGLE.bundle(), NO_POW_FLOOR).indexProof).toBe('single-input');

    const broken = SINGLE.bundle();
    broken.hops[0].witness = { ...section(SINGLE.block, SINGLE.pos), wtxidBranch: ['22'.repeat(32)] };
    expect(() => verifyCustodyBundle(broken, NO_POW_FLOOR)).toThrow();

    // presence, not truth: untrusted JSON can carry a section with no data,
    // and a verifier downgrading it to single-input would report a satpoint
    const falsy = SINGLE.bundle();
    (falsy.hops[0] as { witness?: unknown }).witness = 0;
    expect(() => verifyCustodyBundle(falsy, NO_POW_FLOOR)).toThrow();
  });

  conformance('multi-input-no-section-refused', () => {
    // driven at index 0, the case a verifier could think it knows without
    // proof: the first envelope it finds is the one the id names, whatever the
    // other input carries
    expect(() => verifyCustodyBundle(multiBundle(0, true), NO_POW_FLOOR)).toThrow(
      EnvelopeIndexUnprovenError,
    );

    // the same reveal with a section is read, and so is a single-input reveal
    // with none, so the refusal is the input count meeting the absent proof
    expect(verifyCustodyBundle(multiBundle(0), NO_POW_FLOOR).indexProof).toBe('wtxid');
    expect(verifyCustodyBundle(SINGLE.bundle(), NO_POW_FLOOR).indexProof).toBe('single-input');
  });

  conformance('unproven-index-distinguishable', () => {
    const bare = multiBundle(1, true);
    expect(() => verifyCustodyBundle(bare, NO_POW_FLOOR)).toThrow(EnvelopeIndexUnprovenError);

    // distinguishable from the two things it could be confused with
    try {
      verifyCustodyBundle(bare, NO_POW_FLOOR);
      expect.unreachable('a multi-input reveal with no section verified');
    } catch (e) {
      expect(e, 'a forgery is a plain Error').toBeInstanceOf(EnvelopeIndexUnprovenError);
      expect(e, 'and an out-of-domain path is CustodyUnsupportedError').not.toBeInstanceOf(
        CustodyUnsupportedError,
      );
      // both numbers the sentence asks for
      expect((e as Error).message, 'the input count').toMatch(/\b2\b/);
      expect((e as Error).message, 'the requested index').toMatch(/index 1\b/);
    }

    // the same bundle with the section attached verifies, so the refusal is
    // the missing proof rather than anything else in the document
    expect(verifyCustodyBundle(multiBundle(1), NO_POW_FLOOR).indexProof).toBe('wtxid');
  });

  conformance('refuse-before-selecting', () => {
    // an index no envelope holds. Without a section the count itself is
    // unproven, so reporting absence would assert a count the bundle cannot
    // support; with one, the same index reaches the absence message
    const bare = multiBundle(7, true);
    expect(() => verifyCustodyBundle(bare, NO_POW_FLOOR)).toThrow(EnvelopeIndexUnprovenError);
    expect(() => verifyCustodyBundle(bare, NO_POW_FLOOR)).not.toThrow(/not present/);

    const withSection = multiBundle(7);
    expect(() => verifyCustodyBundle(withSection, NO_POW_FLOOR)).toThrow(/index 7 not present/);
    expect(() => verifyCustodyBundle(withSection, NO_POW_FLOOR)).not.toThrow(
      EnvelopeIndexUnprovenError,
    );
  });

  conformance('section-only-at-reveal', () => {
    // the section is the reveal's own, so it verifies where it came from and
    // the refusal rests on where it now sits
    const b = twoHopBundle();
    expect(verifyCustodyBundle(b, NO_POW_FLOOR).indexProof).toBe('single-input');

    const late = twoHopBundle();
    late.hops[1].witness = section(SPEND.block, 1);
    expect(() => verifyCustodyBundle(late, NO_POW_FLOOR)).toThrow(
      /hop 1: witness section is only accepted at the reveal/,
    );

    // presence rather than truth, the same rule the reveal's guard reads
    const falsy = twoHopBundle();
    (falsy.hops[1] as { witness?: unknown }).witness = 0;
    expect(() => verifyCustodyBundle(falsy, NO_POW_FLOOR)).toThrow(
      /only accepted at the reveal/,
    );

    // and the accepted position, on the same block
    expect(verifyCustodyBundle(multiBundle(1), NO_POW_FLOOR).indexProof).toBe('wtxid');
  });

  conformance('bind-envelope-input-k', () => {
    // the forgery the ordering exists to catch: same txid, same anchored
    // header, an envelope rewritten to one ord calls unbound. A verifier
    // deriving the position first reports CustodyUnsupportedError, which a
    // caller reads as out of scope; one binding first reports a forgery
    const forgedLeaf = envelope([[1, 'text/plain'], [22, 'x']], 'custody');
    const forged = withWitness(SINGLE.reveal.tx, 0, [
      SIG,
      forgedLeaf,
      taprootCommit(forgedLeaf).controlBlock,
    ]);
    expect(forged.txid, 'the rewrite left the txid alone').toBe(SINGLE.reveal.tx.txid);
    expect(
      inscriptionsFromTx(forged)[0].flags.unrecognizedEvenField,
      'and made it unbound',
    ).toBe(true);

    const b = SINGLE.bundle();
    b.hops[0].tx.hex = bytesToHex(forged.raw);
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(/taproot commitment/);
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).not.toThrow(CustodyUnsupportedError);

    // "in every case, including wtxid": the same rewrite under a section that
    // verifies is still refused by the binding
    const forgedM = withWitness(revealM.tx, 1, [
      SIG,
      forgedLeaf,
      taprootCommit(forgedLeaf).controlBlock,
    ]);
    const bm = multiBundle(1);
    bm.hops[0].tx.hex = bytesToHex(forgedM.raw);
    expect(() => verifyCustodyBundle(bm, NO_POW_FLOOR)).toThrow();

    // the prev tx for input k MUST hash to the txid it names
    const wrongPrev = SINGLE.bundle();
    wrongPrev.hops[0].prevTxs = [buildTx([{ txid: T1, vout: 77 }], [{ value: 10_000n }]).hex];
    expect(() => verifyCustodyBundle(wrongPrev, NO_POW_FLOOR)).toThrow(/hashes to/);

    // and MUST contain the output the input names
    const shortPrev = revealChain(ENV, [{ value: 9_000n }]);
    const missing = shortPrev.bundle();
    const commitTxParsed = shortPrev.commit.tx;
    missing.hops[0].tx.hex = bytesToHex(
      serializeFull({
        version: shortPrev.reveal.tx.version,
        inputs: [{ ...shortPrev.reveal.tx.inputs[0], vout: 3 }],
        outputs: shortPrev.reveal.tx.outputs,
        locktime: shortPrev.reveal.tx.locktime,
      }),
    );
    expect(commitTxParsed.outputs.length, 'the commit has no output 3').toBe(1);
    // the rewrite moved the txid, so this bundle needs its own anchoring
    const moved = parseTx(hexToBytes(missing.hops[0].tx.hex));
    const movedBlock = buildBlock([moved]);
    missing.inscriptionId = `${moved.txid}i0`;
    missing.hops[0] = revealHop(movedBlock, 1, missing.hops[0].tx.hex, [shortPrev.commit.hex]);
    expect(() => verifyCustodyBundle(missing, NO_POW_FLOOR)).toThrow(/no output 3/);
  });

  conformance('input-k-spend-checks', () => {
    // a prevout that is not P2TR: an envelope is committed in a taproot script
    // path, so nothing else can carry one
    const bare = revealChain(ENV, [{ value: 9_000n }], { commitSpk: new Uint8Array([0x51]) });
    expect(() => verifyCustodyBundle(bare.bundle(), NO_POW_FLOOR)).toThrow(/P2TR/);

    // a tapscript the commit output never committed, under an unchanged txid
    const rogue = envelope([[1, 'text/plain']], 'rogue');
    const rewritten = withWitness(SINGLE.reveal.tx, 0, [
      SIG,
      rogue,
      taprootCommit(rogue).controlBlock,
    ]);
    expect(rewritten.txid).toBe(SINGLE.reveal.tx.txid);
    const b = SINGLE.bundle();
    b.hops[0].tx.hex = bytesToHex(rewritten.raw);
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(/taproot commitment/);

    // the key-path arm is driven at the helper rather than through a bundle:
    // an input spent by key path carries no envelope for ord to number, so no
    // bundle can present one at input k. The check guards callers of the
    // helper, which the genealogy verifier is
    const keyPath = withWitness(SINGLE.reveal.tx, 0, [SIG]);
    expect(inscriptionsFromTx(keyPath), 'a key-path spend reveals no envelope').toEqual([]);
    expect(() =>
      verifyEnvelopeBinding(
        keyPath,
        inscriptionsFromTx(SINGLE.reveal.tx)[0],
        [SINGLE.commit.hex],
        'hop 0 (reveal)',
      ),
    ).toThrow(/key-path/);
  });

  // -------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------

  conformance('offset-inside-spent-output', () => {
    // the reachable side of "strictly": a tracked offset at the last sat of
    // the spent output walks
    const ptr = revealChain(envelope([[1, 'text/plain'], pointerField(949)], 'custody'), [
      { value: 500n },
      { value: 450n },
    ]);
    const genesis = verifyCustodyBundle(ptr.bundle(), NO_POW_FLOOR).genesis;
    expect(genesis.vout, 'the last sat of output 1').toBe(1);
    expect(genesis.offset).toBe(449n);

    const onward = laterHop(ptr.reveal.tx, [{ value: 450n }], 800_010, { vout: 1 });
    const b = ptr.bundle();
    b.hops.push(onward.hop);
    b.finalSatpoint = `${onward.spend.tx.txid}:0:449`;
    expect(verifyCustodyBundle(b, NO_POW_FLOOR).satpoint.offset).toBe(449n);

    // the violating side cannot be built. The tracked offset is produced by
    // mapping into the very output the next hop's prev tx has to hash to, and
    // that mapping only returns an offset strictly inside the output's value,
    // so a bundle reaching the guard would need a prev tx that both hashes to
    // the tracked txid and states a different value for the tracked output.
    // What that leaves is a helper a caller could misuse, and the guard the
    // verifier keeps for it: called directly, the arithmetic follows an
    // over-large offset instead of refusing it
    const spent = ptr.reveal.tx.outputs[1].value;
    const roomy = buildTx([{ txid: ptr.reveal.tx.txid, vout: 1 }], [{ value: 1_000n }]);
    const past = transferSatpoint(
      roomy.tx,
      [spent],
      { txid: ptr.reveal.tx.txid, vout: 1, offset: spent },
      800_010,
    );
    expect(past.offset, 'the helper maps it rather than refusing').toBe(spent);
    // which is why the verifier holds the check itself
    expect(
      readFileSync(join(ROOT, 'packages/core/src/custody.ts'), 'utf8'),
    ).toContain('outside spent output value');
  });

  conformance('transfer-fee-refusal', () => {
    // the genesis rule at :38 is the same arithmetic one transaction earlier;
    // this is a later hop, where the tracked offset is what the outputs have
    // to cover. One sat across the boundary either way
    const ptr = revealChain(envelope([[1, 'text/plain'], pointerField(700)], 'custody'), [
      { value: 500n },
      { value: 450n },
    ]);
    expect(verifyCustodyBundle(ptr.bundle(), NO_POW_FLOOR).genesis.offset).toBe(200n);

    const walks = laterHop(ptr.reveal.tx, [{ value: 201n }], 800_010, { vout: 1 });
    const ok = ptr.bundle();
    ok.hops.push(walks.hop);
    ok.finalSatpoint = `${walks.spend.tx.txid}:0:200`;
    expect(verifyCustodyBundle(ok, NO_POW_FLOOR).satpoint.offset).toBe(200n);

    const fees = laterHop(ptr.reveal.tx, [{ value: 200n }], 800_010, { vout: 1 });
    const gone = ptr.bundle();
    gone.hops.push(fees.hop);
    gone.finalSatpoint = `${fees.spend.tx.txid}:0:0`;
    expect(() => verifyCustodyBundle(gone, NO_POW_FLOOR)).toThrow(CustodyUnsupportedError);
    expect(() => verifyCustodyBundle(gone, NO_POW_FLOOR)).toThrow(/fees/);
    try {
      verifyCustodyBundle(gone, NO_POW_FLOOR);
      expect.unreachable('the fee-spillover hop verified');
    } catch (e) {
      expect((e as CustodyUnsupportedError).height).toBe(800_010);
    }
  });

  // -------------------------------------------------------------------------
  // Custody bundle
  // -------------------------------------------------------------------------

  conformance('per-hop-anchoring', () => {
    // "per hop" is the clause a reveal-only test would miss, so each check is
    // broken at hop 0 and again at hop 1 and the refusal names the hop
    expect(verifyCustodyBundle(twoHopBundle(), NO_POW_FLOOR).hops).toBe(2);

    const breakages: [string, (h: CustodyHopJson, blk: TestBlock) => void, RegExp][] = [
      [
        'the header hash',
        (h) => {
          h.block.hash = '00'.repeat(32);
        },
        /header hashes to .* bundle claims/,
      ],
      [
        'the target the header states',
        (h) => {
          const re = harderTarget(h.block.header);
          h.block.header = re.header;
          h.block.hash = re.hash;
        },
        /fails proof of work/,
      ],
      [
        'the transaction count',
        (h) => {
          h.block.txCount = 0;
        },
        /missing valid txCount/,
      ],
      [
        'the branch depth',
        (h) => {
          h.tx.txidBranch = [...h.tx.txidBranch, '00'.repeat(32)];
        },
        /branch depth \d+ != tree height/,
      ],
      [
        'the branch itself',
        (h) => {
          h.tx.txidBranch = h.tx.txidBranch.map(() => '00'.repeat(32));
        },
        /merkle proof does not match/,
      ],
    ];

    for (const [what, breakIt, message] of breakages) {
      for (const hop of [0, 1]) {
        const b = twoHopBundle();
        breakIt(b.hops[hop], hop === 0 ? SINGLE.block : SPEND.block);
        const label = hop === 0 ? /hop 0 \(reveal\)/ : /hop 1/;
        expect(() => verifyCustodyBundle(b, NO_POW_FLOOR), `${what} at hop ${hop}`).toThrow(message);
        expect(() => verifyCustodyBundle(b, NO_POW_FLOOR), `${what} names hop ${hop}`).toThrow(
          label,
        );
      }
    }

    // the proof-of-work floor, which refuses these regtest headers by default
    expect(() => verifyCustodyBundle(twoHopBundle())).toThrow(/proof-of-work limit/);

    // 64-byte transactions, in both serializations: the rule is about the
    // stripped preimage, so a verifier measuring raw bytes passes the first
    // arm and fails the second
    const stripped = hexToBytes(
      buildTx(
        [{ txid: T0, vout: 0, scriptSig: new Uint8Array(0) }],
        [{ value: 1000n, spk: new Uint8Array([0x51, 0x51, 0x51, 0x51]) }],
      ).hex,
    );
    expect(stripped.length).toBe(64);
    const wrapped = new Uint8Array([
      ...stripped.slice(0, 4),
      0x00,
      0x01,
      ...stripped.slice(4, 60),
      0x01,
      0x01,
      0x00,
      ...stripped.slice(60),
    ]);
    for (const [what, hex] of [
      ['legacy', bytesToHex(stripped)],
      ['segwit-wrapped', bytesToHex(wrapped)],
    ] as const) {
      for (const hop of [0, 1]) {
        const b = twoHopBundle();
        b.hops[hop].tx.hex = hex;
        expect(() => verifyCustodyBundle(b, NO_POW_FLOOR), `${what} at hop ${hop}`).toThrow(
          /64-byte/,
        );
      }
    }
  });

  conformance('hop-order-and-distinctness', () => {
    // the equal-height arm is the one a height comparison alone would miss
    const lower = twoHopBundle();
    lower.hops[1].block.height = 799_999;
    expect(() => verifyCustodyBundle(lower, NO_POW_FLOOR)).toThrow(
      /hop 1: does not come after hop 0 in chain order/,
    );

    for (const [what, pos] of [
      ['an equal position', 1],
      ['a lower position', 0],
    ] as const) {
      const same = twoHopBundle();
      same.hops[1].block.height = 800_000;
      same.hops[0].tx.pos = 1;
      same.hops[1].tx.pos = pos;
      expect(() => verifyCustodyBundle(same, NO_POW_FLOOR), what).toThrow(/chain order/);
    }

    // strictly greater at the same height is accepted, which is what makes the
    // two refusals above the ordering rule rather than the height comparison
    const ok = twoHopBundle();
    ok.hops[1].block.height = 800_000;
    ok.hops[1].tx.pos = 2;
    expect(() => verifyCustodyBundle(ok, NO_POW_FLOOR)).not.toThrow(/chain order/);

    // distinctness, which this walk can reach where the genealogy walk cannot,
    // because a server names each next transaction here
    const repeated = twoHopBundle();
    repeated.hops.push(clone(repeated.hops[1]));
    repeated.hops[2].block.height = 800_020;
    expect(() => verifyCustodyBundle(repeated, NO_POW_FLOOR)).toThrow(
      /hop 2: duplicate transaction/,
    );
  });

  conformance('no-coinbase-after-reveal-and-bind-at-hop-0', () => {
    // a real coinbase as a later hop: a fee path v1 declines rather than a
    // forgery, so the class is the one callers discriminate on
    const coinbase = buildTx(
      [{ txid: '00'.repeat(32), vout: 0xffffffff }],
      [{ value: 5_000_000_000n }, { value: 0n }],
    );
    const cbBlock = buildBlock([coinbase.tx]);
    const b = SINGLE.bundle();
    b.hops.push(revealHop(cbBlock, 1, coinbase.hex, [], 800_010));
    b.finalSatpoint = `${coinbase.tx.txid}:0:0`;
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(CustodyUnsupportedError);
    expect(() => verifyCustodyBundle(b, NO_POW_FLOOR)).toThrow(/coinbase/);

    // "also": a bundle whose per-hop anchoring all passes, asserted by
    // verifying it before the tamper, whose reveal witness is then rewritten
    // under an unchanged txid
    const honest = twoHopBundle();
    expect(verifyCustodyBundle(honest, NO_POW_FLOOR).hops).toBe(2);
    const rogue = envelope([[1, 'text/plain']], 'rogue');
    const rewritten = withWitness(SINGLE.reveal.tx, 0, [
      SIG,
      rogue,
      taprootCommit(rogue).controlBlock,
    ]);
    expect(rewritten.txid, 'every anchoring check still passes').toBe(SINGLE.reveal.tx.txid);
    const tampered = twoHopBundle();
    tampered.hops[0].tx.hex = bytesToHex(rewritten.raw);
    expect(() => verifyCustodyBundle(tampered, NO_POW_FLOOR)).toThrow(/taproot commitment/);
  });

  conformance('prevtx-alignment', () => {
    // the tracked outpoint is spent at input 1, behind an unrelated funding
    // input, so the walk reads both entries and input 0's value shifts the
    // answer by its whole amount. Every other two-input fixture here spends
    // one commit twice, where a swap would prove nothing
    const fundX = buildTx([{ txid: T1, vout: commitSeed++ }], [{ value: 5_000n }]);
    const spend = buildTx(
      [
        { txid: fundX.tx.txid, vout: 0 },
        { txid: SINGLE.reveal.tx.txid, vout: 0 },
      ],
      [{ value: 14_000n }],
    );
    const blk = buildBlock([spend.tx]);
    const hop = revealHop(blk, 1, spend.hex, [fundX.hex, SINGLE.reveal.hex], 800_010);

    const good = SINGLE.bundle();
    good.hops.push(hop);
    good.finalSatpoint = `${spend.tx.txid}:0:5000`;
    expect(
      verifyCustodyBundle(good, NO_POW_FLOOR).satpoint.offset,
      "the position is input 0's value plus the tracked offset",
    ).toBe(5_000n);

    // swapped: both entries are real transactions this hop's inputs name, so a
    // verifier matching by txid rather than by position accepts it
    const swapped = clone(good);
    swapped.hops[1].prevTxs = [SINGLE.reveal.hex, fundX.hex];
    expect(() => verifyCustodyBundle(swapped, NO_POW_FLOOR)).toThrow(/prev tx 0 hashes to/);

    // the sharper arm: the entry the answer needs, correct, and supplied
    // alone. The list is a prefix from input 0, so it is read at position 0
    // and refused for not being there
    const trackedOnly = clone(good);
    trackedOnly.hops[1].prevTxs = [SINGLE.reveal.hex];
    expect(() => verifyCustodyBundle(trackedOnly, NO_POW_FLOOR)).toThrow(
      /need prev txs for inputs 0\.\.1/,
    );

    // and the alignment decides the answer rather than only the hashing: what
    // a verifier ignoring input 0 would fold to is refused
    const ignoring = clone(good);
    ignoring.finalSatpoint = `${spend.tx.txid}:0:0`;
    expect(() => verifyCustodyBundle(ignoring, NO_POW_FLOOR)).toThrow(/path folds to/);
  });

  conformance('prevtx-surplus-refused', () => {
    // the surplus entry is a copy of one the bundle already carries, so every
    // entry a verifier reads hashes correctly and only the count refuses it
    const atReveal = SINGLE.bundle();
    atReveal.hops[0].prevTxs = [SINGLE.commit.hex, SINGLE.commit.hex];
    expect(() => verifyCustodyBundle(atReveal, NO_POW_FLOOR)).toThrow(
      /hop 0 \(reveal\): 2 prev txs supplied for 1 input\(s\)/,
    );

    const atHop = twoHopBundle();
    atHop.hops[1].prevTxs = [SINGLE.reveal.hex, SINGLE.reveal.hex];
    expect(() => verifyCustodyBundle(atHop, NO_POW_FLOOR)).toThrow(
      /hop 1: 2 prev txs supplied for 1 input\(s\)/,
    );

    // and the aligned list the reference builder writes still verifies
    expect(verifyCustodyBundle(twoHopBundle(), NO_POW_FLOOR).hops).toBe(2);
  });

  conformance('finalsatpoint-recomputed', () => {
    const walked = verifyCustodyBundle(twoHopBundle(), NO_POW_FLOOR);
    expect(formatSatpoint(walked.satpoint)).toBe(`${SPEND.spend.tx.txid}:0:0`);

    // each field on its own, since a verifier comparing the formatted string
    // would pass a claim differing only in a field it never parsed
    for (const [what, claim] of [
      ['the txid', `${SINGLE.reveal.tx.txid}:0:0`],
      ['the vout', `${SPEND.spend.tx.txid}:1:0`],
      ['the offset', `${SPEND.spend.tx.txid}:0:1`],
    ] as const) {
      const b = twoHopBundle();
      b.finalSatpoint = claim;
      expect(() => verifyCustodyBundle(b, NO_POW_FLOOR), what).toThrow(
        /bundle claims final satpoint .*, path folds to/,
      );
    }
  });

  // -------------------------------------------------------------------------
  // the accounting
  // -------------------------------------------------------------------------

  /**
   * SPEC-CUSTODY states every requirement with MUST: 49 occurrences over 45
   * lines, 5 of them MUST NOT per line and a sixth split across the :251/:252
   * break, and no REQUIRED, SHALL or RECOMMENDED anywhere in the file. The
   * pattern catches MUST NOT as well, since it contains MUST. The spec has no
   * RFC 2119 boilerplate line, so no line is excluded by name.
   */
  const NORMATIVE = /\bMUST\b/;

  it('SPEC-CUSTODY.md: every normative line is accounted for by a row in the table', () => {
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
      `SPEC-CUSTODY.md states requirements no row accounts for:\n${unaccounted.join('\n')}`,
    ).toEqual([]);

    // and the other direction: a row claiming a line that carries no keyword
    // would mean the table drifted off the requirements it accounts for
    expect(claimed.size).toBe(normative.length);
  });

  /**
   * The filter choice itself, measured rather than assumed. A REQUIRED added
   * to this spec would state a requirement the accounting above cannot see,
   * so the choice is re-measured here and fails when the file gains a keyword
   * the pattern does not carry. OPTIONAL and SHOULD state no requirement, so
   * they are counted rather than banned: a reader can see what the filter
   * leaves outside it and the rows name where each one sits.
   */
  it('SPEC-CUSTODY.md: MUST is the only RFC 2119 requirement keyword in the file', () => {
    for (const keyword of ['REQUIRED', 'SHALL', 'RECOMMENDED']) {
      expect(SPEC.match(new RegExp(`\\b${keyword}\\b`, 'g')), keyword).toBeNull();
    }
    expect(SPEC.match(/\bMUST\b/g)).toHaveLength(49);
    expect(SPEC.match(/\bMUST NOT\b/g)).toHaveLength(5);
    expect(SPEC.split('\n').filter((l) => /\bMUST\b/.test(l))).toHaveLength(45);
    expect(SPEC.match(/\bSHOULD\b/g)).toHaveLength(5);
    expect(SPEC.match(/\bOPTIONAL\b/g)).toHaveLength(1);
  });

  it('SPEC-CUSTODY.md: the table says how each requirement is covered', () => {
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

  it('SPEC-CUSTODY.md: every `tested at` row names a test that still exists', () => {
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
  it('SPEC-CUSTODY.md: this file speaks for exactly the core rows', () => {
    expect([...SPOKEN].sort()).toEqual(drivenIdsFor('core').sort());
    expect(idsFor('fetch').length, 'the fetch file drives no rows').toBeGreaterThan(0);
    expect(
      readFileSync(join(ROOT, 'packages/fetch/test/spec-custody.builder.test.ts'), 'utf8'),
    ).toContain('spec-custody.rows.js');
  });
});
