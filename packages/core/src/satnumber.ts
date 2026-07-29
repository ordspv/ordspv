/**
 * Sat identity: verify WHICH sat an inscription lives on, from chain data
 * alone. This is the custody proof run backward.
 *
 * Every transaction input names its funding transaction by txid, so the
 * ancestry of a sat is a hash chain: no pathfinder is needed at all, only
 * document retrieval. Middle transactions need no inclusion proofs; their
 * bytes are pinned by the txid the next transaction's input names. Only the
 * two endpoints anchor to the chain: the reveal (as in custody hop 0) and the
 * terminal coinbase, because the coinbase's height is what numbers the sat.
 *
 * Sat numbers come from the ordinal theory BIP: a block's coinbase has an
 * implicit input of subsidy sats (numbered by a closed form over height)
 * followed by the block's fee sats. Underpaid subsidies do not shift later
 * numbers; ordinals depend on how many sats COULD have been mined. A position
 * inside the subsidy range therefore yields the sat number directly; a
 * position in the fee tail means the sat was once paid as a fee, which
 * requires whole-block accounting to follow, so v1 refuses loudly
 * (CustodyUnsupportedError), symmetric with forward custody.
 */

import { ParsedTx, parseTx } from './tx.js';
import { inscriptionsFromTx } from './envelope.js';
import { parseInscriptionId } from './inscriptionId.js';
import { hexToBytes } from './bytes.js';
import { parseHeader } from './header.js';
import { verifyWitnessAnchoring, type WitnessSectionJson } from './witnesscommit.js';
import {
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  isCoinbaseTx,
  provenInputValues,
  unprovenIndexMessage,
  verifyAnchoredHop,
  verifyEnvelopeBinding,
  type CustodyHopJson,
  type CustodyVerifyOptions,
  type IndexProof,
  type Satpoint,
} from './custody.js';

// ---------------------------------------------------------------------------
// Closed forms from the ordinal theory BIP
// ---------------------------------------------------------------------------

export const EPOCH_BLOCKS = 210_000;
export const CYCLE_BLOCKS = 1_260_000; // six halvings
export const DIFFCHANGE_BLOCKS = 2_016;
const INITIAL_SUBSIDY = 5_000_000_000n;
const FINAL_EPOCH = 33; // subsidy is zero from epoch 33 on

/** Block subsidy in sats: 50e8 >> floor(height / 210000). */
export function subsidySats(height: number): bigint {
  if (!Number.isInteger(height) || height < 0) throw new Error(`invalid height ${height}`);
  const epoch = Math.floor(height / EPOCH_BLOCKS);
  if (epoch >= FINAL_EPOCH) return 0n;
  return INITIAL_SUBSIDY >> BigInt(epoch);
}

/** First sat number of a block's subsidy (cumulative theoretical subsidy). */
export function firstSatOfBlock(height: number): bigint {
  if (!Number.isInteger(height) || height < 0) throw new Error(`invalid height ${height}`);
  let start = 0n;
  for (let epoch = 0; epoch < FINAL_EPOCH; epoch++) {
    const epochStart = epoch * EPOCH_BLOCKS;
    if (height <= epochStart) break;
    const blocks = Math.min(height - epochStart, EPOCH_BLOCKS);
    start += BigInt(blocks) * (INITIAL_SUBSIDY >> BigInt(epoch));
  }
  return start;
}

export const TOTAL_SATS = firstSatOfBlock(FINAL_EPOCH * EPOCH_BLOCKS); // 2099999997690000
export const LAST_SAT = TOTAL_SATS - 1n;

/** Invert firstSatOfBlock: the block that mined a sat, and its offset there. */
export function satToHeight(sat: bigint): { height: number; offset: bigint } {
  if (sat < 0n || sat >= TOTAL_SATS) throw new Error(`sat ${sat} out of range`);
  let cum = 0n;
  for (let epoch = 0; epoch < FINAL_EPOCH; epoch++) {
    const subsidy = INITIAL_SUBSIDY >> BigInt(epoch);
    const epochSats = BigInt(EPOCH_BLOCKS) * subsidy;
    if (sat < cum + epochSats) {
      const into = sat - cum;
      const height = epoch * EPOCH_BLOCKS + Number(into / subsidy);
      return { height, offset: into % subsidy };
    }
    cum += epochSats;
  }
  throw new Error('unreachable');
}

export type SatRarity = 'mythic' | 'legendary' | 'epic' | 'rare' | 'uncommon' | 'common';

/** Rarity per ordinal theory's periodic events. */
export function satRarity(sat: bigint): SatRarity {
  if (sat === 0n) return 'mythic';
  const { height, offset } = satToHeight(sat);
  if (offset !== 0n) return 'common';
  if (height % CYCLE_BLOCKS === 0) return 'legendary';
  if (height % EPOCH_BLOCKS === 0) return 'epic';
  if (height % DIFFCHANGE_BLOCKS === 0) return 'rare';
  return 'uncommon';
}

/**
 * Ordinal name: bijective base-26 over (LAST_SAT - sat + 1), so the last sat
 * is "a" and sat 0 is "nvtdijuwxlp".
 */
export function satName(sat: bigint): string {
  if (sat < 0n || sat >= TOTAL_SATS) throw new Error(`sat ${sat} out of range`);
  let x = LAST_SAT - sat + 1n;
  let name = '';
  while (x > 0n) {
    x -= 1n;
    name = String.fromCharCode(97 + Number(x % 26n)) + name;
    x /= 26n;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Backward arithmetic
// ---------------------------------------------------------------------------

/**
 * A traced position does not land in the sat space it was resolved against.
 *
 * Which phase raised it decides what it means. A verifier raises it about a
 * bundle whose witness is already bound, so the bundle's own pointer does not
 * land in the transaction's sat space and the document is invalid. A builder
 * raises it about a position derived from a pointer and an envelope input read
 * out of a served reveal witness, which the txid does not commit to, so it is
 * one backend's word and the wrappers record it and lead the next attempt with
 * another backend.
 */
export class SatPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SatPositionError';
  }
}

/** Absolute output-space position of (vout, offset) in a transaction. */
export function outputSpacePosition(tx: ParsedTx, vout: number, offset: bigint): bigint {
  const out = tx.outputs[vout];
  if (!out) throw new SatPositionError(`no output ${vout}`);
  if (offset < 0n || offset >= out.value) {
    throw new SatPositionError(`offset ${offset} outside output ${vout} value ${out.value}`);
  }
  let position = offset;
  for (let i = 0; i < vout; i++) position += tx.outputs[i].value;
  return position;
}

/**
 * One backward hop: which input fed the given absolute position, and where
 * that sat sat inside the input's funding output. Because outputs are a
 * prefix slice of the concatenated input stream, output-space and
 * input-space positions are identical.
 *
 * inputValues are the proven values of inputs 0..n (from provenInputValues);
 * if the provided values do not reach the position, the error names the
 * inputs still needed.
 */
export function containingInput(
  tx: ParsedTx,
  inputValues: bigint[],
  position: bigint,
): { input: number; offsetInFunding: bigint } {
  let remaining = position;
  for (let i = 0; i < inputValues.length; i++) {
    if (remaining < inputValues[i]) return { input: i, offsetInFunding: remaining };
    remaining -= inputValues[i];
  }
  if (inputValues.length >= tx.inputs.length) {
    throw new SatPositionError(`position ${position} beyond the transaction's total input sats`);
  }
  throw new SatPositionError(
    `position ${position} not reached by prev txs for inputs 0..${inputValues.length - 1}; more are needed`,
  );
}

/**
 * Terminal rule at the coinbase: the implicit input stream is subsidy sats
 * first (closed-form numbered), then the block's fee sats. Underpaid
 * subsidies change nothing. Fee positions are beyond v1.
 */
export function coinbaseSatAt(coinbase: ParsedTx, position: bigint, height: number): bigint {
  if (!isCoinbaseTx(coinbase)) throw new Error('terminal transaction is not a coinbase');
  const subsidy = subsidySats(height);
  if (position < subsidy) return firstSatOfBlock(height) + position;
  throw new CustodyUnsupportedError(
    `sat was mined as fee sats in block ${height}; tracing through fees needs whole-block accounting (beyond v1)`,
    height,
  );
}

/**
 * BIP34 height from a coinbase scriptSig (first push, little-endian).
 * Returns undefined when the script does not start with a plausible push.
 */
export function bip34Height(coinbase: ParsedTx): number | undefined {
  const s = coinbase.inputs[0]?.scriptSig;
  if (!s || s.length < 2) return undefined;
  const len = s[0];
  if (len < 1 || len > 8 || s.length < 1 + len) return undefined;
  let height = 0;
  for (let i = len; i >= 1; i--) height = height * 256 + s[i];
  return Number.isSafeInteger(height) ? height : undefined;
}

/** Enforce the BIP34 cross-check only comfortably past activation. */
export const BIP34_ENFORCED_FROM = 230_000;

/**
 * The terminal coinbase's claimed height could not be proven. The height is
 * what numbers the sat, so a server that picks it picks the sat number, the
 * name and the rarity. From BIP34_ENFORCED_FROM on, the coinbase's own
 * scriptSig carries the height and the bundle's claim is checked against it.
 * Below that boundary no such push is required, and the only thing binding
 * the pair is an attestation of the block hash at that height, which the
 * caller's `trustHeader` hook makes by returning `'hash-at-height'`. The
 * presence of a hook proves nothing on its own, since a hook that returns
 * quietly may have checked nothing. A bundle refused this way
 * may be perfectly honest; it simply cannot prove its height offline, which
 * is a different fact from being forged (plain Error) or leaving v1's sat
 * domain (CustodyUnsupportedError).
 */
export class CoinbaseHeightUnprovenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoinbaseHeightUnprovenError';
  }
}

/**
 * A genealogy is deeper than the step cap that was allowed for it. The cap is
 * what bounds the work an untrusted document can demand, so hitting it is a
 * refusal to read and not a judgement about the document. A bundle refused
 * this way may be perfectly honest and merely have a deep ancestry, which is a
 * different fact from being forged (plain Error) or leaving v1's sat domain
 * (CustodyUnsupportedError). The caller raises the cap to read it.
 *
 * The class lives here because both the builder's walk and the verifier's read
 * refuse on the same ground, and a caller that discriminates on the class has
 * to see one class from both. `@ordspv/fetch` re-exports it for the builder.
 */
export class SatStepLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SatStepLimitError';
  }
}

// ---------------------------------------------------------------------------
// Genealogy bundles
// ---------------------------------------------------------------------------

export interface GenealogyStepJson {
  /** raw hex; must hash to the txid named by the successor's containing input */
  tx: { hex: string };
  /** prev txs aligned to inputs 0..i (i = this tx's containing input) */
  prevTxs: string[];
}

export interface SatGenealogyBundleJson {
  version: 1;
  inscriptionId: string;
  /** the reveal, anchored exactly like custody hop 0 */
  reveal: CustodyHopJson;
  /** ancestor chain, nearest funder first; empty when the reveal spends a coinbase */
  funding: GenealogyStepJson[];
  /** the terminal coinbase, anchored; tx.pos MUST be 0 */
  coinbase: CustodyHopJson;
  /** decimal sat number claim; recomputed and checked */
  claimedSat: string;
}

export interface VerifiedSatIdentity {
  inscriptionId: string;
  sat: bigint;
  name: string;
  rarity: SatRarity;
  /** block that mined the sat */
  coinbaseHeight: number;
  /** funding transactions walked between reveal and coinbase */
  depth: number;
  /** where the sat entered the reveal (input space projected to outputs may differ) */
  revealPosition: bigint;
  /** control block merkle path depth of the envelope's taproot commitment */
  controlBlockDepth: number;
  /** the reveal's taptree provably committed only the observed tapscript */
  singleLeafTree: boolean;
  /** reveal tx has one input, so no other input can contribute an envelope */
  singleInputReveal: boolean;
  /** how the envelope's index was proven */
  indexProof: IndexProof;
}

export interface GenealogyVerifyOptions extends CustodyVerifyOptions {
  /** verifier-side step bound (DoS guard for hostile bundles); default 10000 */
  maxSteps?: number;
}

function parseHexTxChecked(hex: string, label: string): ParsedTx {
  let tx: ParsedTx;
  try {
    tx = parseTx(hexToBytes(hex.trim()));
  } catch (e) {
    throw new Error(`${label}: cannot parse transaction: ${(e as Error).message}`);
  }
  if (tx.strippedRaw.length === 64) {
    throw new Error(`${label}: 64-byte transactions are rejected (leaf/node ambiguity)`);
  }
  return tx;
}

/**
 * Verify a sat genealogy bundle. Throws with a precise reason on failure;
 * CustodyUnsupportedError marks true-but-beyond-v1 ancestries (fee sats).
 */
export function verifySatGenealogy(
  bundle: SatGenealogyBundleJson,
  opts: GenealogyVerifyOptions = {},
): VerifiedSatIdentity {
  if (bundle.version !== 1) {
    throw new Error(`unsupported genealogy bundle version ${(bundle as { version: unknown }).version}`);
  }
  const maxSteps = opts.maxSteps ?? 10_000;
  const id = parseInscriptionId(bundle.inscriptionId);
  if (!Array.isArray(bundle.funding)) throw new Error('genealogy bundle missing funding array');
  if (bundle.funding.length > maxSteps) {
    // a refusal to read, not a claim that the bundle is forged: a genuinely
    // deep ancestry built with a raised builder cap arrives here well formed
    throw new SatStepLimitError(
      `genealogy has ${bundle.funding.length} steps, verifier cap is ${maxSteps}`,
    );
  }

  // ---- reveal: anchored, envelope located, start position derived ----
  const reveal = parseHexTxChecked(bundle.reveal.tx.hex, 'reveal');
  if (reveal.txid !== id.txid) {
    throw new Error(`reveal tx hashes to ${reveal.txid}, inscription id says ${id.txid}`);
  }
  verifyAnchoredHop(bundle.reveal, reveal, 'reveal', opts);

  // how the envelope's index is proven: a witness section pins every input's
  // witness through the block's BIP-141 commitment, and a single-input reveal
  // has nothing to renumber. A multi-input reveal without a section cannot
  // prove the numbering at all (EnvelopeIndexUnprovenError)
  // presence, not truth: a bundle is untrusted JSON, so `"witness": 0` must be
  // read as a section and refused by the shape check, not quietly downgraded
  const revealWitness = (bundle.reveal as { witness?: unknown }).witness;
  const indexProof: IndexProof =
    revealWitness !== undefined ? 'wtxid' : 'single-input';
  if (revealWitness !== undefined) {
    verifyWitnessAnchoring({
      witness: revealWitness as WitnessSectionJson,
      header: parseHeader(hexToBytes(bundle.reveal.block.header)),
      txCount: bundle.reveal.block.txCount,
      reveal,
      pos: bundle.reveal.tx.pos,
    });
  }

  // the refusal comes BEFORE the lookup: on such a reveal the envelope count
  // itself is unproven, so "index N not present" would assert a count the
  // bundle cannot support, in a plain Error that reads as a forgery
  if (indexProof !== 'wtxid' && reveal.inputs.length !== 1) {
    throw new EnvelopeIndexUnprovenError(unprovenIndexMessage('reveal', reveal, id.index));
  }
  const allInscriptions = inscriptionsFromTx(reveal);
  const inscription = allInscriptions.find((i) => i.index === id.index);
  if (!inscription) {
    throw new Error(`reveal tx contains ${allInscriptions.length} envelope(s); index ${id.index} not present`);
  }
  const k = inscription.input;
  // the reveal is anchored by txid, which does not cover the witness carrying
  // this envelope; bind it to the commit output before its pointer or its
  // input index is used to derive a position
  const binding = verifyEnvelopeBinding(reveal, inscription, bundle.reveal.prevTxs, 'reveal');
  // prevTxs must cover at least inputs 0..k so the envelope input's value is
  // proven; a pointer can push the start position into a LATER input, so any
  // additional prev txs the bundle supplies are used too
  const revealUpTo = Math.min(bundle.reveal.prevTxs.length, reveal.inputs.length) - 1;
  if (revealUpTo < k) {
    throw new Error(
      `reveal needs prev txs for inputs 0..${k}, got ${bundle.reveal.prevTxs.length}`,
    );
  }
  const revealValues = provenInputValues(reveal, bundle.reveal.prevTxs, revealUpTo);
  if (inscription.unboundByEvenField || revealValues[k] === 0n) {
    throw new CustodyUnsupportedError(
      'inscription is unbound at reveal (zero-value envelope input or unrecognized even field); it has no sat identity to trace',
      bundle.reveal.block.height,
    );
  }

  // input-space start: default is the first sat of the envelope's input; a
  // valid pointer indexes output space, which equals input space (outputs
  // are a prefix slice of the concatenated inputs)
  let totalOut = 0n;
  for (const o of reveal.outputs) totalOut += o.value;
  let position: bigint;
  if (inscription.pointer !== undefined && inscription.pointer < totalOut) {
    position = inscription.pointer;
  } else {
    position = 0n;
    for (let i = 0; i < k; i++) position += revealValues[i];
  }
  const revealPosition = position;

  // find the reveal input that carried the sat in
  let currentTx = reveal;
  let currentValues = revealValues;
  let step = containingInput(currentTx, currentValues, position);
  let expectTxid = currentTx.inputs[step.input].prevTxid;
  let expectVout = currentTx.inputs[step.input].vout;
  let offset = step.offsetInFunding;

  // ---- walk the funding chain ----
  const seen = new Set<string>([reveal.txid]);
  for (let i = 0; i < bundle.funding.length; i++) {
    const label = `funding[${i}]`;
    // GenealogyStepJson declares no witness field, but a bundle is untrusted
    // JSON and the spec's rule binds every element, not just the coinbase
    if ((bundle.funding[i] as { witness?: unknown }).witness !== undefined) {
      throw new Error(`${label}: witness section is only accepted at the reveal`);
    }
    const tx = parseHexTxChecked(bundle.funding[i].tx.hex, label);
    if (tx.txid !== expectTxid) {
      throw new Error(`${label}: hashes to ${tx.txid}, chain expects ${expectTxid}`);
    }
    if (seen.has(tx.txid)) throw new Error(`${label}: duplicate transaction in genealogy`);
    seen.add(tx.txid);
    if (isCoinbaseTx(tx)) {
      throw new Error(
        `${label}: coinbase must be the terminal element, not a funding step`,
      );
    }
    const pos = outputSpacePosition(tx, expectVout, offset);
    const upTo = Math.min(bundle.funding[i].prevTxs.length, tx.inputs.length) - 1;
    if (upTo < 0) throw new Error(`${label}: no prev txs provided`);
    const values = provenInputValues(tx, bundle.funding[i].prevTxs, upTo);
    step = containingInput(tx, values, pos);
    expectTxid = tx.inputs[step.input].prevTxid;
    expectVout = tx.inputs[step.input].vout;
    offset = step.offsetInFunding;
  }

  // ---- terminal coinbase ----
  // presence, not truth: `"witness": 0` carries no data and must still be
  // refused, the way the funding-step guard above refuses it
  if ((bundle.coinbase as { witness?: unknown }).witness !== undefined) {
    throw new Error('coinbase: witness section is only accepted at the reveal');
  }
  const coinbase = parseHexTxChecked(bundle.coinbase.tx.hex, 'coinbase');
  if (coinbase.txid !== expectTxid) {
    throw new Error(`coinbase hashes to ${coinbase.txid}, chain expects ${expectTxid}`);
  }
  if (!isCoinbaseTx(coinbase)) throw new Error('terminal transaction is not a coinbase');
  if (bundle.coinbase.tx.pos !== 0) {
    throw new Error(`coinbase must be at position 0, bundle says ${bundle.coinbase.tx.pos}`);
  }
  const coinbaseAttestation = verifyAnchoredHop(bundle.coinbase, coinbase, 'coinbase', opts);
  const height = bundle.coinbase.block.height;
  if (height >= BIP34_ENFORCED_FROM) {
    const embedded = bip34Height(coinbase);
    if (embedded === undefined) {
      throw new Error(`coinbase at height ${height} lacks a parseable BIP34 height`);
    }
    if (embedded !== height) {
      throw new Error(`BIP34 height ${embedded} contradicts claimed height ${height}`);
    }
  } else if (coinbaseAttestation !== 'hash-at-height') {
    // verifyAnchoredHop ran the hook on this header already. Only a hook that
    // returned the attestation marker checked the hash against the chain at
    // this height, and that check is the whole binding. A missing hook and a
    // hook that returned nothing leave the claimed height as the server's word
    // alone, and it decides the sat number, the name and the rarity
    throw new CoinbaseHeightUnprovenError(
      `coinbase claims height ${height}, below the BIP34 boundary ${BIP34_ENFORCED_FROM}, ` +
        `so the coinbase carries no height push to check the claim against; supply a ` +
        `trustHeader hook that returns 'hash-at-height' for this header, which asserts ` +
        `the block hash is the chain's hash at that height, since the height is what ` +
        `numbers the sat`,
    );
  }

  const pos = outputSpacePosition(coinbase, expectVout, offset);
  const sat = coinbaseSatAt(coinbase, pos, height);

  // BigInt() accepts the empty string as zero and hex forms; the claim
  // parses strictly even though recompute-and-check makes the leniency
  // harmless
  if (typeof bundle.claimedSat !== 'string' || !/^[0-9]+$/.test(bundle.claimedSat)) {
    throw new Error(`bundle claims sat ${bundle.claimedSat}, genealogy folds to ${sat}`);
  }
  const claimed = BigInt(bundle.claimedSat);
  if (claimed !== sat) {
    throw new Error(`bundle claims sat ${bundle.claimedSat}, genealogy folds to ${sat}`);
  }

  return {
    inscriptionId: bundle.inscriptionId.toLowerCase(),
    sat,
    name: satName(sat),
    rarity: satRarity(sat),
    coinbaseHeight: height,
    depth: bundle.funding.length,
    revealPosition,
    controlBlockDepth: binding.controlBlockDepth,
    singleLeafTree: binding.singleLeafTree,
    singleInputReveal: binding.singleInputReveal,
    indexProof,
  };
}
