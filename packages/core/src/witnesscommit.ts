import { bytesEqual, concatBytes } from './bytes.js';
import { sha256d } from './hash.js';
import { computeMerkleRoot } from './merkle.js';
import { isCoinbase, type ParsedTx } from './tx.js';

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
