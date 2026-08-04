/**
 * The sentences a user-facing surface prints beside a verification result.
 *
 * They live here so the CLI, the extension viewer, and any other consumer say
 * the same thing about the same residual. Each one states a limit of what was
 * proven, in the words the specs use, so a reader is told what to do about it
 * rather than left to infer it from a boolean.
 */

/**
 * What every `indexProof` other than `'wtxid'` leaves open, and what L2 leaves
 * open on the content path. SPEC-CUSTODY and SPEC-VERIFICATION carry the same
 * statement: control block depth is about commitment, and execution is a
 * separate question only the block's witness commitment settles.
 */
export const L2_EXECUTED_LEAF_RESIDUAL =
  "the binding proves the commit output's author committed the observed " +
  'tapscript, and only a wtxid anchor proves the presented witness is the one ' +
  'the chain executed';

/**
 * What a multi-input reveal leaves open below L3. An envelope's index is a
 * running count over the envelopes of every earlier input, those witnesses sit
 * outside the txid, and a gateway can renumber them with no help from the
 * inscriber.
 */
export const L2_NUMBERING_RESIDUAL =
  'the reveal spends several inputs, so the envelope numbering is not proven ' +
  'at L2 and needs an L3 witness commitment';

/**
 * What an offline verification of a custody or genealogy bundle leaves to the
 * reader. Every header in the bundle carries proof of work and nothing more, so
 * the result holds against whatever chain the reader takes as real. A hop
 * header's hash is a value any caller can check against any chain view at no
 * marginal cost, which is why saying so is a complete remedy here and why the
 * unprovable heights the verifier refuses outright are a different case: those
 * appear in no header, so no amount of chain view settles them.
 */
export const BUNDLE_HEADERS_UNANCHORED =
  'beyond the compiled-in checkpoints, no header in this bundle was anchored, so ' +
  'this result holds only against your own chain view; anchor each block hash at ' +
  'the height printed beside it';

/**
 * What a printed block height is worth on an offline verification. The header
 * is proof-of-work checked and its hash is what a caller anchors; the height
 * beside it is the serving backend's claim until that anchor pins the pair.
 */
export const HEIGHT_IS_A_CLAIM =
  "block heights are the serving backend's claim until you anchor the hash at " +
  'that height';
