/**
 * Build-loop bookkeeping for domain refusals.
 *
 * A builder reads the envelope out of the served reveal witness, and the txid
 * does not commit to that witness. Every domain decision the builder makes from
 * it is therefore one backend's word: an unrecognized even field, a zero-value
 * envelope input, a fee-tail ancestry, and the walk depth that a start position
 * implies are all things a hostile backend can produce out of bytes nothing has
 * bound. The same goes for the block hash and the position a backend's own
 * status and merkle proof name, which is what decides whether the reveal's
 * witness section can be built at all. So a builder MUST NOT treat a refusal
 * as terminal while another backend is configured unless the refusal was
 * derived from data the reveal txid commits, and the wrappers record the rest
 * as that backend's cause and move on.
 *
 * Once a verifier raises the same class the fact is proven and the refusal is
 * terminal, because the bundle it refused had already bound its witness.
 */

/**
 * One build attempt, reported before it runs.
 *
 * Rotation is expensive: the ceiling is one full walk per configured backend,
 * and a deep genealogy is thousands of requests and tens of minutes. A caller
 * watching a terminal cannot tell that from a hang, so the wrappers say which
 * backend they moved to and what ended the attempt before it.
 */
export interface AttemptInfo {
  /** base URL of the backend leading this attempt */
  baseUrl: string;
  /** zero-based index of this attempt */
  attempt: number;
  /** attempts this build may make, one per configured backend */
  total: number;
  /** what ended the previous attempt; undefined on the first */
  cause?: Error;
}

/** Progress hook for the build loops; the library default is undefined. */
export type OnAttempt = (info: AttemptInfo) => void;

/** One backend's build-time domain refusal, recorded instead of thrown. */
export interface DomainRefusal {
  /** base URL of the backend whose bytes produced the refusal */
  baseUrl: string;
  error: Error;
}

/**
 * A refusal a build loop rethrows on its backends' behalf.
 *
 * `unanimous` says how far it reaches. True means every configured backend led
 * an attempt that ended in this refusal, which is as close to the chain's own
 * answer as a builder gets. False means the backends that could not be reached
 * were never heard from, so the refusal is the word of the ones that answered.
 * A caller MUST NOT read a non-unanimous refusal as proof about the chain.
 *
 * A refusal a verifier raises carries no marker at all, and callers treat that
 * as unanimous: the bundle it refused had already bound its witness.
 */
export interface SharedRefusalError extends Error {
  unanimous: boolean;
}

/**
 * The refusal to rethrow when no backend produced a bundle, so a caller still
 * discriminates on the class it discriminates on today. The message gains how
 * far the refusal reaches, and the names on both sides of that.
 *
 * `unreachable` holds the base URL of every attempt that ended some other way,
 * which is a transport failure the loop already has in its cause list. A
 * refusal from one backend while another succeeded proves nothing, since the
 * one that succeeded is the answer, and this is not called in that case. When
 * no backend succeeded, the refusal is the most informative thing the build
 * has, and reporting it while saying what it rests on is honest.
 *
 * Returns undefined when nothing was refused, when the refusals were of
 * different classes, or when the attempts did not account for every configured
 * backend; the caller's own build-failure path handles those with every cause
 * joined.
 */
export function sharedDomainRefusal(
  refusals: DomainRefusal[],
  backendCount: number,
  unreachable: string[] = [],
): SharedRefusalError | undefined {
  if (refusals.length === 0) return undefined;
  if (refusals.length + unreachable.length !== backendCount) return undefined;
  const first = refusals[0].error;
  if (!refusals.every((r) => r.error.constructor === first.constructor)) return undefined;
  const names = refusals.map((r) => r.baseUrl).join(', ');
  const unanimous = unreachable.length === 0;
  // what the loop establishes is one attempt per configured backend, each led
  // by that backend and each ending one of these two ways. On the sat side the
  // attempt runs through a pool, so the deciding bytes may have come from
  // another member, and claiming every backend reported the condition would
  // overstate it
  first.message = unanimous
    ? `${first.message} (each configured backend led an attempt that ended this way, ` +
      `so it is not one server's word: ${names})`
    : `${first.message} (${refusals.length} of ${backendCount} configured backends led an ` +
      `attempt that ended this way: ${names}; the rest could not be reached: ` +
      `${unreachable.join(', ')})`;
  const shared = first as SharedRefusalError;
  shared.unanimous = unanimous;
  return shared;
}
