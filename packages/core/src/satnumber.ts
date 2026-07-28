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
import {
  CustodyUnsupportedError,
  isCoinbaseTx,
  provenInputValues,
  verifyAnchoredHop,
  verifyEnvelopeBinding,
  type CustodyHopJson,
  type CustodyVerifyOptions,
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

/** Absolute output-space position of (vout, offset) in a transaction. */
export function outputSpacePosition(tx: ParsedTx, vout: number, offset: bigint): bigint {
  const out = tx.outputs[vout];
  if (!out) throw new Error(`no output ${vout}`);
  if (offset < 0n || offset >= out.value) {
    throw new Error(`offset ${offset} outside output ${vout} value ${out.value}`);
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
    throw new Error(`position ${position} beyond the transaction's total input sats`);
  }
  throw new Error(
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
  /** the reveal's taptree provably contains only the observed tapscript */
  singleLeafTree: boolean;
  /** reveal tx has one input, pinning envelope indices given the shown script */
  singleInputReveal: boolean;
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
    throw new Error(`genealogy has ${bundle.funding.length} steps, verifier cap is ${maxSteps}`);
  }

  // ---- reveal: anchored, envelope located, start position derived ----
  const reveal = parseHexTxChecked(bundle.reveal.tx.hex, 'reveal');
  if (reveal.txid !== id.txid) {
    throw new Error(`reveal tx hashes to ${reveal.txid}, inscription id says ${id.txid}`);
  }
  verifyAnchoredHop(bundle.reveal, reveal, 'reveal', opts);
  const allInscriptions = inscriptionsFromTx(reveal);
  const inscription = allInscriptions.find((i) => i.index === id.index);
  if (!inscription) {
    throw new Error(`reveal tx contains ${allInscriptions.length} envelope(s); index ${id.index} not present`);
  }
  const k = inscription.input;
  // the reveal is anchored by txid, which does not cover the witness carrying
  // this envelope; bind it to the commit output before its pointer or its
  // input index is used to derive a position
  const binding = verifyEnvelopeBinding(reveal, inscription, bundle.reveal.prevTxs);
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
  const coinbase = parseHexTxChecked(bundle.coinbase.tx.hex, 'coinbase');
  if (coinbase.txid !== expectTxid) {
    throw new Error(`coinbase hashes to ${coinbase.txid}, chain expects ${expectTxid}`);
  }
  if (!isCoinbaseTx(coinbase)) throw new Error('terminal transaction is not a coinbase');
  if (bundle.coinbase.tx.pos !== 0) {
    throw new Error(`coinbase must be at position 0, bundle says ${bundle.coinbase.tx.pos}`);
  }
  verifyAnchoredHop(bundle.coinbase, coinbase, 'coinbase', opts);
  const height = bundle.coinbase.block.height;
  if (height >= BIP34_ENFORCED_FROM) {
    const embedded = bip34Height(coinbase);
    if (embedded === undefined) {
      throw new Error(`coinbase at height ${height} lacks a parseable BIP34 height`);
    }
    if (embedded !== height) {
      throw new Error(`BIP34 height ${embedded} contradicts claimed height ${height}`);
    }
  }

  const pos = outputSpacePosition(coinbase, expectVout, offset);
  const sat = coinbaseSatAt(coinbase, pos, height);

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
  };
}
