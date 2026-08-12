/**
 * Custody proofs: verify WHERE an inscription's sat is from chain data alone.
 *
 * An inscription's location is a satpoint (txid:vout:offset). Its custody
 * history is a finite path through the transaction graph: the reveal binds it
 * to a genesis satpoint, and each later transaction that spends the tracked
 * outpoint moves it by ordinal first-in-first-out arithmetic. Every step of
 * that path is locally checkable:
 *
 * - each hop transaction is SPV-proven into a header (txid tree, hardened
 *   txCount, PoW), with chain anchoring delegated to the caller exactly as in
 *   proof.ts (`trustHeader`);
 * - input values, which FIFO arithmetic needs, are proven by including the
 *   previous transactions themselves: a prev tx's bytes hash to the txid the
 *   spending input names, so values are self-certifying and need no extra
 *   inclusion proofs;
 * - the arithmetic (input concatenation, output slicing, pointer handling)
 *   is recomputed here, never trusted from the server.
 *
 * The role an indexer plays is reduced to FINDING the path (e.g. via esplora
 * outspend lookups); nothing it says is trusted. What custody proofs cannot
 * express is a negative: "this outpoint is still unspent" is not provable by
 * inclusion, so tip liveness stays a resolver-layer concern (multi-source
 * outspend checks, or the caller's own node).
 *
 * v1 explicitly refuses paths that leave the output sat space: a sat that
 * lands in fees flows through the block's coinbase, which requires the whole
 * block's fee picture to track. Those throw CustodyUnsupportedError with the
 * height at which it happened, so callers can distinguish "wrong" from
 * "beyond v1".
 */

import { ParsedTx, parseTx } from './tx.js';
import { Inscription, inscriptionsFromTx } from './envelope.js';
import { checkExpectedInscriptionId, parseInscriptionId } from './inscriptionId.js';
import {
  parseHeader,
  checkProofOfWork,
  checkPowLimit,
  BlockHeader,
  type HeaderAttestation,
} from './header.js';
import { verifyMerkleBranch, treeHeight } from './merkle.js';
import { hexToBytes, bytesEqual, displayToInternal } from './bytes.js';
import {
  extractTapscript,
  isP2TR,
  parseControlBlock,
  verifyScriptPathCommitment,
} from './taproot.js';
import { verifyWitnessAnchoring, type WitnessSectionJson } from './witnesscommit.js';

/** A location in the sat space of a confirmed transaction's outputs. */
export interface Satpoint {
  /** display-order txid */
  txid: string;
  vout: number;
  /** sat offset within the output, 0-based */
  offset: bigint;
}

export function formatSatpoint(sp: Satpoint): string {
  return `${sp.txid}:${sp.vout}:${sp.offset}`;
}

export function parseSatpoint(s: string): Satpoint {
  const m = /^([0-9a-fA-F]{64}):(\d+):(\d+)$/.exec(s);
  if (!m) throw new Error(`invalid satpoint: ${s}`);
  return { txid: m[1].toLowerCase(), vout: Number(m[2]), offset: BigInt(m[3]) };
}

/** A custody path step that v1 cannot follow (sat left the output sat space). */
export class CustodyUnsupportedError extends Error {
  constructor(
    message: string,
    /** block height at which the unsupported step happened, when known */
    public readonly height?: number,
  ) {
    super(message);
    this.name = 'CustodyUnsupportedError';
  }
}

/**
 * The verifier cannot prove WHICH envelope the inscription id names. An
 * envelope's index is a running count over the envelopes of every reveal input
 * before it, and those witnesses are outside the txid, so a multi-input reveal
 * needs the block's BIP-141 witness commitment to pin the numbering. A bundle
 * that carries no witness section for such a reveal may be perfectly honest;
 * it simply cannot prove the numbering, which is a different fact from being
 * forged (plain Error) or leaving v1's sat domain (CustodyUnsupportedError).
 *
 * This is the verifier's refusal and nothing else. Retrying it elsewhere
 * changes nothing, since the bundle it was handed cannot prove its numbering
 * whoever serves it. A builder that could not fetch the block a section is
 * made from throws `WitnessSectionUnavailableError` from `@ordspv/fetch`,
 * which is availability and may well succeed on a retry.
 */
export class EnvelopeIndexUnprovenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeIndexUnprovenError';
  }
}

/**
 * The one refusal EnvelopeIndexUnprovenError now carries: a multi-input reveal
 * whose bundle has no verified witness section. Written once so the custody and
 * genealogy paths refuse in the same words.
 */
export function unprovenIndexMessage(
  label: string,
  reveal: ParsedTx,
  requestedIndex: number,
): string {
  return (
    `${label}: reveal spends ${reveal.inputs.length} inputs and the bundle carries no ` +
    `witness section; every input's witness is outside the txid, so the numbering that ` +
    `would make any envelope index ${requestedIndex} cannot be proven`
  );
}

function totalOutputSats(tx: ParsedTx): bigint {
  let total = 0n;
  for (const out of tx.outputs) total += out.value;
  return total;
}

/**
 * Map an absolute position in a transaction's output sat space to a satpoint.
 * Zero-value outputs occupy no sat space and are skipped naturally.
 * Returns undefined when the position lies beyond the outputs (in the fee).
 */
function mapToOutputs(tx: ParsedTx, position: bigint): Satpoint | undefined {
  if (position < 0n) throw new Error('negative sat position');
  let remaining = position;
  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const value = tx.outputs[vout].value;
    if (remaining < value) return { txid: tx.txid, vout, offset: remaining };
    remaining -= value;
  }
  return undefined;
}

/**
 * A bundle's prev tx list is aligned to the transaction's inputs, so an entry
 * past the input count corresponds to nothing and would be read by nothing.
 * Both verifiers refuse it rather than ignore it, so that SPEC-SAT's "verifiers
 * MUST use every prev tx supplied" is a rule the code keeps and not a rule the
 * code narrows in silence.
 */
export function checkPrevTxCount(tx: ParsedTx, prevTxsHex: string[], label: string): void {
  // untrusted JSON: an absent list must name itself rather than surface as
  // a TypeError on .length
  if (!Array.isArray(prevTxsHex)) {
    throw new Error(`${label}: prevTxs is not a list`);
  }
  if (prevTxsHex.length > tx.inputs.length) {
    throw new Error(
      `${label}: ${prevTxsHex.length} prev txs supplied for ${tx.inputs.length} input(s); ` +
        `an entry past the input count corresponds to no input`,
    );
  }
}

/**
 * Values of a transaction's inputs 0..upTo (inclusive), proven by the previous
 * transactions themselves: prevTxs[i] must hash to the txid named by input i.
 * prevTxs entries within the input count but beyond upTo are ignored, because
 * they cannot affect the position; entries past the input count are refused by
 * checkPrevTxCount before this function is reached.
 */
export function provenInputValues(tx: ParsedTx, prevTxsHex: string[], upTo: number): bigint[] {
  if (upTo >= tx.inputs.length) throw new Error(`input index ${upTo} out of range`);
  if (prevTxsHex.length < upTo + 1) {
    throw new Error(`need prev txs for inputs 0..${upTo}, got ${prevTxsHex.length}`);
  }
  const values: bigint[] = [];
  for (let i = 0; i <= upTo; i++) {
    let prev: ParsedTx;
    try {
      prev = parseTx(hexToBytes(prevTxsHex[i].trim()));
    } catch (e) {
      throw new Error(`prev tx ${i}: cannot parse: ${(e as Error).message}`);
    }
    const input = tx.inputs[i];
    if (prev.txid !== input.prevTxid) {
      throw new Error(`prev tx ${i} hashes to ${prev.txid}, input spends ${input.prevTxid}`);
    }
    const spent = prev.outputs[input.vout];
    if (!spent) throw new Error(`prev tx ${i} has no output ${input.vout}`);
    values.push(spent.value);
  }
  return values;
}

/**
 * How a verifier proved which envelope the inscription id names.
 *
 * 'wtxid': the reveal's whole witness is anchored in the block's BIP-141
 * witness commitment, which pins envelope bytes and numbering outright.
 * 'single-input': the reveal has one input, and the input count is
 * txid-committed, so no other input can contribute an envelope and there is
 * nothing to renumber. It says nothing about whether the observed tapscript
 * was the script the input ran, which is the residual of SPEC-VERIFICATION
 * level 2 and is reported by nothing: `singleLeafTree` is a statement about
 * what the commit output's author committed, and depth 0 leaves the author
 * free to have spent by key path and served the tapscript afterwards.
 */
export type IndexProof = 'wtxid' | 'single-input';

/** What the envelope binding established about the reveal's taptree. */
export interface EnvelopeBinding {
  /** control block merkle path depth; 0 means the taptree provably committed a single leaf */
  controlBlockDepth: number;
  /** the taptree provably committed only the observed tapscript (depth 0) */
  singleLeafTree: boolean;
  /** reveal tx has one input, so no other input can contribute an envelope */
  singleInputReveal: boolean;
}

/**
 * Bind the envelope to txid-committed data.
 *
 * A reveal's txid does not commit to its witness (BIP-141), and the envelope
 * lives in the witness. Anchoring the reveal by txid therefore says nothing
 * about the pointer, the envelope's input, or the envelope bytes: a server can
 * rewrite all of them, keep the txid, and hand over a bundle whose inclusion
 * proofs still fold correctly.
 *
 * What the txid DOES commit to is each input's outpoint, and a bundle's prev
 * txs are pinned by those outpoints. The envelope input's prevout therefore
 * yields a trustworthy P2TR scriptPubKey, and BIP-341 requires the witness
 * tapscript to be committed by it. Checking that commitment is what makes the
 * envelope trustworthy, and it is the same check the L2 content path runs.
 *
 * What this does NOT establish is that the observed tapscript was the script
 * the reveal executed. A single-leaf P2TR output is spendable by key path as
 * well as by script path, and the txid commits to neither the witness nor the
 * spend path chosen, so control block depth 0 proves that the prevout's author
 * committed the observed tapscript and nothing more. Under ord semantics an
 * input spent by key path reveals no envelope at all. Proving which envelope
 * the id names therefore needs the block's BIP-141 witness commitment, and the
 * callers decide that separately (see IndexProof); this function binds input
 * `k` alone.
 *
 * The residual at input k is the L2 residual: a multi-leaf taptree lets a
 * witness present any leaf its author committed, so this proves the commit
 * output's author committed the observed tapscript. `singleLeafTree` reports
 * when the taptree provably held nothing else.
 */
export function verifyEnvelopeBinding(
  reveal: ParsedTx,
  inscription: Inscription,
  prevTxsHex: string[],
  label = 'reveal',
): EnvelopeBinding {
  const k = inscription.input;
  const input = reveal.inputs[k];
  if (!input) {
    throw new Error(`${label}: envelope input ${k} out of range`);
  }
  const role = `envelope input ${k}`;
  const prevHex = prevTxsHex[k];
  if (prevHex === undefined || prevHex.trim() === '') {
    throw new Error(`${label}: no prev tx for ${role}, so its commitment cannot be checked`);
  }
  let prev: ParsedTx;
  try {
    prev = parseTx(hexToBytes(prevHex.trim()));
  } catch (e) {
    throw new Error(`${label}: prev tx for ${role}: cannot parse: ${(e as Error).message}`);
  }
  if (prev.txid !== input.prevTxid) {
    throw new Error(
      `${label}: prev tx for ${role} hashes to ${prev.txid}, input spends ${input.prevTxid}`,
    );
  }
  const spent = prev.outputs[input.vout];
  if (!spent) {
    throw new Error(`${label}: prev tx for ${role} has no output ${input.vout}`);
  }
  const tapscript = extractTapscript(input.witness);
  if (!tapscript) {
    throw new Error(
      `${label}: envelope input ${k} is a key-path spend with no tapscript; ` +
        `an envelope is a script-path commitment, so it cannot be carried there`,
    );
  }
  if (!isP2TR(spent.scriptPubKey)) {
    throw new Error(
      `${label}: envelope input ${k} spends a non-P2TR output; ` +
        `an envelope is committed in a taproot script path, so no envelope can be bound here`,
    );
  }
  try {
    verifyScriptPathCommitment({
      script: tapscript.script,
      controlBlock: tapscript.controlBlock,
      scriptPubKey: spent.scriptPubKey,
    });
  } catch (e) {
    throw new Error(`${label}: envelope input ${k} taproot commitment: ${(e as Error).message}`);
  }
  const controlBlockDepth = parseControlBlock(tapscript.controlBlock).path.length;
  return {
    controlBlockDepth,
    singleLeafTree: controlBlockDepth === 0,
    singleInputReveal: reveal.inputs.length === 1,
  };
}

/** A coinbase spends a single null outpoint; no funding transaction exists. */
export function isCoinbaseTx(tx: ParsedTx): boolean {
  return (
    tx.inputs.length === 1 &&
    tx.inputs[0].vout === 0xffffffff &&
    tx.inputs[0].prevTxidLE.every((b) => b === 0)
  );
}

/**
 * Genesis satpoint of an inscription in its reveal transaction.
 *
 * Default: the first sat of the envelope's input, i.e. the absolute input
 * position sum(inputValues[0..input-1]), mapped through the outputs. A valid
 * pointer (tag 2) instead indexes the OUTPUT sat space directly; a pointer at
 * or past the total output sats is ignored per the handbook.
 *
 * Inscriptions ord considers UNBOUND (zero-value envelope input, or an
 * unrecognized even field) have no output-space location at all and are
 * refused with CustodyUnsupportedError before any arithmetic.
 *
 * inputValues must cover inputs 0..inscription.input (use provenInputValues).
 */
export function genesisSatpoint(
  reveal: ParsedTx,
  inscription: Inscription,
  inputValues: bigint[],
  height?: number,
): Satpoint {
  if (isCoinbaseTx(reveal)) throw new Error('coinbase transactions cannot carry inscriptions');
  if (inscription.input >= reveal.inputs.length) {
    throw new Error(`envelope input ${inscription.input} out of range`);
  }
  if (inputValues.length < inscription.input + 1) {
    throw new Error(`need input values for inputs 0..${inscription.input}`);
  }
  // ord marks an inscription UNBOUND when its envelope input has zero value or
  // its envelope carries an unrecognized even field; unbound inscriptions are
  // assigned to the all-zeros unbound outpoint, never to an output, regardless
  // of pointer or position arithmetic (inscription_updater.rs).
  if (inscription.unboundByEvenField || inputValues[inscription.input] === 0n) {
    throw new CustodyUnsupportedError(
      'inscription is unbound at reveal (zero-value envelope input or unrecognized even field); ord binds it to the unbound outpoint, not to an output',
      height,
    );
  }
  const totalOut = totalOutputSats(reveal);
  if (inscription.pointer !== undefined && inscription.pointer < totalOut) {
    const sp = mapToOutputs(reveal, inscription.pointer);
    /* pointer < totalOut always lands in an output */
    if (!sp) throw new Error('unreachable: valid pointer left output space');
    return sp;
  }
  let position = 0n;
  for (let i = 0; i < inscription.input; i++) position += inputValues[i];
  const sp = mapToOutputs(reveal, position);
  if (!sp) {
    throw new CustodyUnsupportedError(
      'inscription is bound to fee sats at reveal; custody v1 does not track sats through fees',
      height,
    );
  }
  return sp;
}

/**
 * Follow the tracked satpoint through one spending transaction.
 * inputValues must cover inputs 0..j where j is the input spending `from`
 * (use provenInputValues). The caller must have checked `from.offset` against
 * the spent output's value (verifyCustodyBundle does).
 */
export function transferSatpoint(
  tx: ParsedTx,
  inputValues: bigint[],
  from: Satpoint,
  height?: number,
): Satpoint {
  const j = tx.inputs.findIndex((inp) => inp.prevTxid === from.txid && inp.vout === from.vout);
  if (j === -1) {
    throw new Error(`transaction ${tx.txid} does not spend ${from.txid}:${from.vout}`);
  }
  if (inputValues.length < j + 1) throw new Error(`need input values for inputs 0..${j}`);
  let position = from.offset;
  for (let i = 0; i < j; i++) position += inputValues[i];
  const sp = mapToOutputs(tx, position);
  if (!sp) {
    throw new CustodyUnsupportedError(
      `sat enters fees in ${tx.txid}; custody v1 does not track sats through fees`,
      height,
    );
  }
  return sp;
}

// ---------------------------------------------------------------------------
// Custody bundles
// ---------------------------------------------------------------------------

export interface CustodyBlockJson {
  height: number;
  /** display-order hash the server claims; recomputed and checked */
  hash: string;
  /** 160 hex chars */
  header: string;
  /** total number of transactions in the block (required: CVE-2017-12842 hardening) */
  txCount: number;
}

export interface CustodyHopJson {
  block: CustodyBlockJson;
  tx: {
    hex: string;
    /** 0-based position in the block's tx list */
    pos: number;
    /** txid-tree merkle branch, display-order hex, bottom-up */
    txidBranch: string[];
  };
  /**
   * Raw hex of the transactions referenced by this tx's inputs, aligned by
   * input index. Entries are required for inputs 0..k, where k is the
   * envelope input (hop 0) or the input spending the tracked satpoint
   * (later hops); later entries may be omitted.
   *
   * An empty string is not a permitted filler. A genealogy verifier uses
   * every entry supplied on the reveal and on funding steps (SPEC-SAT,
   * "Verifiers MUST use every prev tx supplied"), so a trailing empty entry
   * fails to parse there rather than being skipped, and it refuses any entry
   * on the terminal coinbase, whose null prevout no prev tx can fund. This
   * builder emits trimmed non-empty hex only.
   */
  prevTxs: string[];
  /**
   * Reveal hop only: anchors the reveal's whole witness into the block's
   * BIP-141 witness commitment, proving envelope bytes and numbering
   * outright (indexProof 'wtxid'). Verifiers refuse the section on any
   * other hop; later hops read nothing from witnesses.
   */
  witness?: WitnessSectionJson;
}

export interface CustodyBundleJson {
  version: 1;
  inscriptionId: string;
  /** hop 0 is the reveal transaction; each later hop spends the tracked satpoint */
  hops: CustodyHopJson[];
  /** claimed final satpoint (txid:vout:offset); recomputed and checked */
  finalSatpoint: string;
}

export interface CustodyVerifyOptions {
  /**
   * Anchor each hop's header to a trusted view of the chain; throw to reject.
   *
   * The return value states what the hook checked. `'hash-at-height'` asserts
   * that this block hash IS the chain's hash at this height, which binds the
   * header to the height and is what a sub-BIP34 coinbase height rests on
   * (see `CoinbaseHeightUnprovenError`). Returning nothing keeps the hook
   * rejection-only: it may reject whatever it likes by throwing, and a
   * verifier reads no positive assertion out of its silence.
   */
  trustHeader?: (header: BlockHeader, height: number) => HeaderAttestation;
  /**
   * Compact-bits proof-of-work floor applied to every hop header before its own
   * PoW check counts for anything. Defaults to the mainnet limit (0x1d00ffff);
   * pass another chain's limit, or null to disable it.
   */
  powLimitBits?: number | null;
  /**
   * The inscription id the caller asked for, read by `verifyCustodyBundle` and
   * by `verifySatGenealogy`, which inherits these options. A bundle names the
   * inscription it proves, and every other check reads that claim rather than
   * testing it, so a verification that omits this option establishes that the
   * bundle is internally consistent and establishes nothing about whose
   * inscription it is. A caller that fetched the bundle for a particular id
   * supplies it here and the mismatch is refused; a caller inspecting a bundle
   * it did not request leaves it out. Case is normalized before the
   * comparison, so an id that survived URI case folding still matches.
   * `verifyAnchoredHop` takes these options too and ignores this one: a hop
   * carries no claim of its own to bind.
   */
  expectedInscriptionId?: string;
}

export interface VerifiedCustody {
  inscriptionId: string;
  /** where the sat sits after the last proven hop */
  satpoint: Satpoint;
  genesis: Satpoint;
  /** satpoint after each hop, genesis first */
  path: Satpoint[];
  /** height of the last proven hop */
  height: number;
  hops: number;
  /** control block merkle path depth of the envelope's taproot commitment */
  controlBlockDepth: number;
  /** the reveal's taptree provably committed only the observed tapscript */
  singleLeafTree: boolean;
  /** reveal tx has one input, so no other input can contribute an envelope */
  singleInputReveal: boolean;
  /** how the envelope's index was proven */
  indexProof: IndexProof;
}

function parseHopTx(hex: string, label: string): ParsedTx {
  let tx: ParsedTx;
  try {
    tx = parseTx(hexToBytes(hex.trim()));
  } catch (e) {
    throw new Error(`${label}: cannot parse transaction: ${(e as Error).message}`);
  }
  // the txid-tree leaf preimage is the STRIPPED serialization, so the
  // leaf/node ambiguity class is stripped==64, witness or not
  if (tx.strippedRaw.length === 64) {
    throw new Error(`${label}: 64-byte transactions are rejected (leaf/node ambiguity)`);
  }
  return tx;
}

/**
 * Shape of one hop's containers and its tx hex, checked before any read on
 * a hop a verifier is about to parse: a bundle is untrusted JSON, and a read
 * through an absent section is a TypeError that reads as an internal fault.
 * verifyAnchoredHop re-checks the sections it reads, so a direct caller of
 * that function is covered without this one.
 */
export function checkHopShape(hop: CustodyHopJson, label: string): void {
  if (typeof hop !== 'object' || hop === null) {
    throw new Error(`${label}: missing valid hop object`);
  }
  if (typeof hop.block !== 'object' || hop.block === null) {
    throw new Error(`${label}: missing valid block section`);
  }
  if (typeof hop.tx !== 'object' || hop.tx === null) {
    throw new Error(`${label}: missing valid tx section`);
  }
  if (typeof hop.tx.hex !== 'string') {
    throw new Error(`${label}: missing valid tx hex`);
  }
}

/**
 * Anchor one hop: header, proof-of-work floor, txCount, caller's trust hook,
 * txid merkle branch. Returns what the trust hook asserted, so a caller that
 * needs the height bound to the header (the terminal coinbase below BIP34) can
 * read it; every other caller ignores it.
 */
export function verifyAnchoredHop(
  hop: CustodyHopJson,
  tx: ParsedTx,
  label: string,
  opts: CustodyVerifyOptions,
): HeaderAttestation {
  // one-level-down shape before any read; see checkHopShape for the rule
  if (typeof hop.block !== 'object' || hop.block === null) {
    throw new Error(`${label}: missing valid block section`);
  }
  if (typeof hop.tx !== 'object' || hop.tx === null) {
    throw new Error(`${label}: missing valid tx section`);
  }
  if (typeof hop.block.header !== 'string') {
    throw new Error(`${label}: missing valid block header`);
  }
  if (typeof hop.block.hash !== 'string') {
    throw new Error(`${label}: missing valid block hash`);
  }
  const header = parseHeader(hexToBytes(hop.block.header));
  if (header.hash !== hop.block.hash.toLowerCase()) {
    throw new Error(`${label}: header hashes to ${header.hash}, bundle claims ${hop.block.hash}`);
  }
  checkPowLimit(header, opts.powLimitBits, label);
  if (!checkProofOfWork(header)) throw new Error(`${label}: header fails proof of work`);
  if (!Number.isInteger(hop.block.txCount) || hop.block.txCount < 1) {
    throw new Error(`${label}: missing valid txCount`);
  }
  // a bundle is untrusted JSON, so a string height would flow through the
  // comparisons that coerce and into the report a --json consumer reads
  if (!Number.isInteger(hop.block.height) || hop.block.height < 0) {
    throw new Error(`${label}: missing valid block height`);
  }
  const attestation = opts.trustHeader?.(header, hop.block.height);

  if (!Array.isArray(hop.tx.txidBranch)) {
    throw new Error(`${label}: missing valid txid branch`);
  }
  const branch = hop.tx.txidBranch.map(displayToInternal);
  const expected = treeHeight(hop.block.txCount);
  if (branch.length !== expected) {
    throw new Error(`${label}: txid branch depth ${branch.length} != tree height ${expected}`);
  }
  const { root } = verifyMerkleBranch(tx.txidLE, branch, hop.tx.pos, hop.block.txCount);
  if (!bytesEqual(root, header.merkleRootLE)) {
    throw new Error(`${label}: txid merkle proof does not match header merkle root`);
  }
  return attestation;
}

/**
 * Verify a custody bundle. Throws with a precise reason on any failure;
 * throws CustodyUnsupportedError when the true path leaves v1's domain.
 */
export function verifyCustodyBundle(
  bundle: CustodyBundleJson,
  opts: CustodyVerifyOptions = {},
): VerifiedCustody {
  if (bundle.version !== 1) {
    throw new Error(`unsupported custody bundle version ${(bundle as { version: unknown }).version}`);
  }
  // a bundle is untrusted JSON, so an absent field must name itself rather
  // than surface as a TypeError that reads as an internal fault. The standard
  // covers the top level and one level down (each hop's block, tx and
  // prevTxs); the witness section gets its messages from its own shape
  // checks, and prev tx entries from the parse and hash checks that name
  // the entry
  if (typeof bundle.inscriptionId !== 'string') {
    throw new Error('bundle field inscriptionId is missing or not a string');
  }
  const id = parseInscriptionId(bundle.inscriptionId);
  // above every read of the bundle's own evidence, so a bundle for another
  // inscription is the wrong document rather than whichever later check its
  // hops happen to fail
  checkExpectedInscriptionId(id, opts.expectedInscriptionId, bundle.inscriptionId);
  if (!Array.isArray(bundle.hops) || bundle.hops.length === 0) {
    throw new Error('custody bundle has no hops');
  }

  // ---- hop 0: reveal, genesis satpoint ----
  const revealHop = bundle.hops[0];
  checkHopShape(revealHop, 'hop 0 (reveal)');
  const reveal = parseHopTx(revealHop.tx.hex, 'hop 0 (reveal)');
  if (reveal.txid !== id.txid) {
    throw new Error(`reveal tx hashes to ${reveal.txid}, inscription id says ${id.txid}`);
  }
  verifyAnchoredHop(revealHop, reveal, 'hop 0 (reveal)', opts);

  // how the envelope's index is proven: a witness section pins every input's
  // witness through the block's BIP-141 commitment, and a single-input reveal
  // has nothing to renumber. A multi-input reveal without a section cannot
  // prove the numbering at all (EnvelopeIndexUnprovenError)
  // presence, not truth: a bundle is untrusted JSON, so `"witness": 0` must be
  // read as a section and refused by the shape check, not quietly downgraded
  const revealWitness = (revealHop as { witness?: unknown }).witness;
  const indexProof: IndexProof =
    revealWitness !== undefined ? 'wtxid' : 'single-input';
  if (revealWitness !== undefined) {
    verifyWitnessAnchoring({
      witness: revealWitness as WitnessSectionJson,
      header: parseHeader(hexToBytes(revealHop.block.header)),
      txCount: revealHop.block.txCount,
      reveal,
      pos: revealHop.tx.pos,
    });
  }

  // the refusal comes BEFORE the lookup: on such a reveal the envelope count
  // itself is unproven, so "index N not present" would assert a count the
  // bundle cannot support, in a plain Error that reads as a forgery
  if (indexProof !== 'wtxid' && reveal.inputs.length !== 1) {
    throw new EnvelopeIndexUnprovenError(
      unprovenIndexMessage('hop 0 (reveal)', reveal, id.index),
    );
  }
  const allInscriptions = inscriptionsFromTx(reveal);
  const inscription: Inscription | undefined = allInscriptions.find((i) => i.index === id.index);
  if (!inscription) {
    throw new Error(`reveal tx contains ${allInscriptions.length} envelope(s); index ${id.index} not present`);
  }
  // the txid anchor above does not cover the witness the envelope came out of;
  // bind it before the pointer or the envelope input index is used for anything
  checkPrevTxCount(reveal, revealHop.prevTxs, 'hop 0 (reveal)');
  const binding = verifyEnvelopeBinding(reveal, inscription, revealHop.prevTxs, 'hop 0 (reveal)');
  const revealValues = provenInputValues(reveal, revealHop.prevTxs, inscription.input);
  const genesis = genesisSatpoint(reveal, inscription, revealValues, revealHop.block.height);

  // ---- later hops ----
  const path: Satpoint[] = [genesis];
  let current = genesis;
  let prevHeight = revealHop.block.height;
  let prevPos = revealHop.tx.pos;
  const seenTxids = new Set([reveal.txid]);

  for (let h = 1; h < bundle.hops.length; h++) {
    const hop = bundle.hops[h];
    const label = `hop ${h}`;
    checkHopShape(hop, label);
    // a bundle is untrusted JSON, so the guard tests presence and not truth:
    // `"witness": 0` carries no data, and it must still not slip a rule the
    // spec states without exception
    if ((hop as { witness?: unknown }).witness !== undefined) {
      throw new Error(`${label}: witness section is only accepted at the reveal`);
    }
    const tx = parseHopTx(hop.tx.hex, label);
    if (seenTxids.has(tx.txid)) throw new Error(`${label}: duplicate transaction ${tx.txid}`);
    seenTxids.add(tx.txid);
    if (isCoinbaseTx(tx)) {
      throw new CustodyUnsupportedError(
        `${label}: custody path passes through a coinbase; v1 does not track sats through fees`,
        hop.block.height,
      );
    }

    if (
      hop.block.height < prevHeight ||
      (hop.block.height === prevHeight && hop.tx.pos <= prevPos)
    ) {
      throw new Error(`${label}: does not come after hop ${h - 1} in chain order`);
    }

    verifyAnchoredHop(hop, tx, label, opts);

    const j = tx.inputs.findIndex((inp) => inp.prevTxid === current.txid && inp.vout === current.vout);
    if (j === -1) {
      throw new Error(`${label}: transaction does not spend tracked satpoint ${formatSatpoint(current)}`);
    }
    checkPrevTxCount(tx, hop.prevTxs, label);
    const values = provenInputValues(tx, hop.prevTxs, j);
    if (current.offset >= values[j]) {
      throw new Error(
        `${label}: tracked offset ${current.offset} outside spent output value ${values[j]}`,
      );
    }
    current = transferSatpoint(tx, values, current, hop.block.height);
    path.push(current);
    prevHeight = hop.block.height;
    prevPos = hop.tx.pos;
  }

  // ---- claimed final satpoint: recompute-and-check ----
  const claimed = parseSatpoint(bundle.finalSatpoint);
  if (
    claimed.txid !== current.txid ||
    claimed.vout !== current.vout ||
    claimed.offset !== current.offset
  ) {
    throw new Error(
      `bundle claims final satpoint ${bundle.finalSatpoint}, path folds to ${formatSatpoint(current)}`,
    );
  }

  return {
    inscriptionId: bundle.inscriptionId.toLowerCase(),
    satpoint: current,
    genesis,
    path,
    height: prevHeight,
    hops: bundle.hops.length,
    controlBlockDepth: binding.controlBlockDepth,
    singleLeafTree: binding.singleLeafTree,
    singleInputReveal: binding.singleInputReveal,
    indexProof,
  };
}
