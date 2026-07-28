import { bytesEqual, concatBytes, displayToInternal, hexToBytes } from './bytes.js';
import { sha256d } from './hash.js';
import { computeMerkleRoot, treeHeight, verifyMerkleBranch } from './merkle.js';
import { isCoinbase, parseTx, type ParsedTx } from './tx.js';
import type { BlockHeader } from './header.js';

/**
 * BIP-141 witness commitment: a coinbase output whose scriptPubKey begins
 * `OP_RETURN 0x24 0xaa21a9ed` carries
 *   SHA256d( witness_merkle_root || witness_reserved_value )
 * where the witness merkle tree is built over wtxids with the coinbase's
 * wtxid replaced by 32 zero bytes, and witness_reserved_value is the
 * coinbase input's sole witness item (32 bytes).
 */

const COMMITMENT_HEADER = new Uint8Array([0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed]);

export const ZERO32 = new Uint8Array(32);

/**
 * Extract the witness commitment from a coinbase tx. Per BIP-141, if more
 * than one output matches, the one with the highest index is the commitment.
 */
export function findWitnessCommitment(coinbase: ParsedTx): Uint8Array | undefined {
  if (!isCoinbase(coinbase)) throw new Error('not a coinbase transaction');
  for (let i = coinbase.outputs.length - 1; i >= 0; i--) {
    const spk = coinbase.outputs[i].scriptPubKey;
    if (spk.length >= 38 && bytesEqual(spk.slice(0, 6), COMMITMENT_HEADER)) {
      return spk.slice(6, 38);
    }
  }
  return undefined;
}

/** The coinbase input's witness reserved value (must be a single 32-byte item). */
export function witnessReservedValue(coinbase: ParsedTx): Uint8Array {
  const witness = coinbase.inputs[0]?.witness ?? [];
  if (witness.length !== 1 || witness[0].length !== 32) {
    throw new Error('coinbase witness must be exactly one 32-byte reserved value');
  }
  return witness[0];
}

/** Commitment bytes for a given witness merkle root + reserved value. */
export function computeWitnessCommitment(witnessRoot: Uint8Array, reserved: Uint8Array): Uint8Array {
  return sha256d(concatBytes(witnessRoot, reserved));
}

/**
 * Compute the witness merkle root from the full ordered wtxid list
 * (internal byte order), substituting zeros for the coinbase at index 0.
 */
export function computeWitnessRootFromWtxids(wtxidsLE: Uint8Array[]): Uint8Array {
  if (wtxidsLE.length === 0) throw new Error('empty wtxid list');
  const leaves = wtxidsLE.slice();
  leaves[0] = ZERO32;
  return computeMerkleRoot(leaves);
}

/**
 * Full check: does this coinbase commit to this witness merkle root?
 */
export function verifyWitnessCommitment(coinbase: ParsedTx, witnessRoot: Uint8Array): void {
  const commitment = findWitnessCommitment(coinbase);
  if (!commitment) throw new Error('coinbase has no witness commitment output');
  const reserved = witnessReservedValue(coinbase);
  const expected = computeWitnessCommitment(witnessRoot, reserved);
  if (!bytesEqual(commitment, expected)) {
    throw new Error('witness commitment mismatch');
  }
}

/**
 * The reveal-anchoring witness section shared by proof bundles (L3) and, at
 * the reveal hop, custody and genealogy bundles.
 */
export interface WitnessSectionJson {
  coinbaseHex: string;
  /** coinbase txid-tree branch (position 0), display-order hex */
  coinbaseTxidBranch: string[];
  /** wtxid-tree branch for the reveal at its position, display-order hex */
  wtxidBranch: string[];
}

const HEX32 = /^[0-9a-fA-F]{64}$/;

/**
 * Shape-check a witness section before anything indexes or maps its fields.
 * A bundle is untrusted JSON, so a missing or wrongly typed field would
 * otherwise surface as a TypeError from deep inside the fold, which reads to
 * a caller as an internal fault rather than a bad bundle.
 */
function checkWitnessSectionShape(witness: WitnessSectionJson): void {
  const w = witness as unknown as Record<string, unknown>;
  if (typeof w.coinbaseHex !== 'string' || !/^[0-9a-fA-F]+$/.test(w.coinbaseHex.trim())) {
    throw new Error('witness section: coinbaseHex must be a non-empty hex string');
  }
  for (const field of ['coinbaseTxidBranch', 'wtxidBranch'] as const) {
    const branch = w[field];
    if (!Array.isArray(branch)) {
      throw new Error(`witness section: ${field} must be an array of 32-byte hex strings`);
    }
    for (let i = 0; i < branch.length; i++) {
      if (typeof branch[i] !== 'string' || !HEX32.test(branch[i] as string)) {
        throw new Error(`witness section: ${field}[${i}] must be a 32-byte hex string`);
      }
    }
  }
}

/**
 * Anchor a reveal's whole witness into the block's BIP-141 witness
 * commitment. The header is the caller's already-anchored header for the
 * block the reveal is proven into, and the reveal MUST already be
 * txid-proven into it at `pos`. On success, the reveal's exact serialization
 * including every input's witness is the one committed in the block, which
 * pins envelope bytes, per-input envelope counts, and therefore envelope
 * numbering all at once.
 *
 * These are the L3 checks verifyProofBundle has always run, in the same
 * order with the same error messages; this is their shared home so custody
 * and genealogy verification run the same consensus logic.
 */
export function verifyWitnessAnchoring(args: {
  witness: WitnessSectionJson;
  header: BlockHeader;
  txCount: number;
  reveal: ParsedTx;
  pos: number;
}): void {
  const { witness, header, txCount, reveal, pos } = args;
  checkWitnessSectionShape(witness);
  const expectedHeight = treeHeight(txCount);

  // ---- coinbase inclusion (txid tree, position 0) ----
  let coinbase: ParsedTx;
  try {
    coinbase = parseTx(hexToBytes(witness.coinbaseHex.trim()));
  } catch (e) {
    throw new Error(`coinbase: cannot parse transaction: ${(e as Error).message}`);
  }
  if (coinbase.strippedRaw.length === 64) {
    throw new Error('coinbase: 64-byte transactions are rejected (leaf/node ambiguity)');
  }
  if (!isCoinbase(coinbase)) throw new Error('claimed coinbase is not a coinbase transaction');
  const cbBranch = witness.coinbaseTxidBranch.map(displayToInternal);
  if (cbBranch.length !== expectedHeight) {
    throw new Error(`coinbase branch depth ${cbBranch.length} != tree height ${expectedHeight}`);
  }
  const { root: cbRoot } = verifyMerkleBranch(coinbase.txidLE, cbBranch, 0, txCount);
  if (!bytesEqual(cbRoot, header.merkleRootLE)) {
    throw new Error('coinbase txid merkle proof does not match header merkle root');
  }

  // ---- witness commitment ----
  const commitment = findWitnessCommitment(coinbase);
  if (!commitment) throw new Error('coinbase has no BIP-141 witness commitment output');
  const reserved = witnessReservedValue(coinbase);
  const wtxidBranch = witness.wtxidBranch.map(displayToInternal);
  if (wtxidBranch.length !== expectedHeight) {
    throw new Error(`wtxid branch depth ${wtxidBranch.length} != tree height ${expectedHeight}`);
  }
  if (pos === 1 && !bytesEqual(wtxidBranch[0], ZERO32)) {
    throw new Error('wtxid branch sibling at position 1 must be the zeroed coinbase leaf');
  }
  if (pos === 0) throw new Error('reveal tx cannot be the coinbase');
  const { root: witnessRoot } = verifyMerkleBranch(reveal.wtxidLE, wtxidBranch, pos, txCount);
  const expectedCommitment = computeWitnessCommitment(witnessRoot, reserved);
  if (!bytesEqual(expectedCommitment, commitment)) {
    throw new Error('witness commitment mismatch: reveal witness is not the one committed in this block');
  }
}
