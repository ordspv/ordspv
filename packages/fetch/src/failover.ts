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
 * One backend whose attempt produced no usable answer, with what ended it.
 *
 * This is everything outside the recognized refusal classes: a transport
 * failure, a backend that served bytes hashing to the wrong txid, a walk that
 * ran out of path. Some of those backends answered and some never responded at
 * all, and the accounting cannot tell them apart, so what is said about them is
 * the thing both cases share.
 */
export type NoAnswer = DomainRefusal;

/**
 * A refusal a build loop rethrows on its backends' behalf.
 *
 * `unanimous` says how far it reaches. True means at least two configured
 * backends were configured and every one of them led an attempt that ended in
 * this refusal, which is as close to the chain's own answer as a builder gets.
 * False means some configured backend never stood behind it, which covers a
 * single configured backend agreeing with itself, an attempt that produced no
 * usable answer, and an attempt that was never led. A caller MUST NOT read a
 * non-unanimous refusal as proof about the chain.
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
 * far the refusal reaches, and the names on all three sides of that.
 *
 * Every configured backend lands in exactly one of three groups. It led an
 * attempt that ended in a refusal, or it led an attempt that produced no usable
 * answer, or it never led one at all because an earlier attempt ended the loop.
 * A refusal from one backend while another succeeded proves nothing, since the
 * one that succeeded is the answer, and this is not called in that case. When
 * no backend succeeded, the refusal is the most informative thing the build
 * has, and reporting it while saying what it rests on is honest.
 *
 * `unanimous` needs at least two configured backends. One backend agreeing with
 * itself is one server's word however the loop ran, and a caller reading a
 * `CustodyUnsupportedError` as a proven statement about the chain on that
 * strength is the reading SPEC-CUSTODY forbids.
 *
 * Returns undefined when nothing was refused, when the refusals were of
 * different classes, or when the three groups do not account for every
 * configured backend; the caller's own build-failure path handles those with
 * every cause joined.
 */
export function sharedDomainRefusal(
  refusals: DomainRefusal[],
  backendCount: number,
  noAnswer: NoAnswer[] = [],
  neverLed: string[] = [],
): SharedRefusalError | undefined {
  if (refusals.length === 0) return undefined;
  if (refusals.length + noAnswer.length + neverLed.length !== backendCount) return undefined;
  const first = refusals[0].error;
  if (!refusals.every((r) => r.error.constructor === first.constructor)) return undefined;
  if (Object.prototype.hasOwnProperty.call(first, 'unanimous')) {
    // the mutation below is not idempotent, so a second call on the same
    // instance would append a second parenthetical and could flip the marker.
    // Nothing in this package does that, and a caller that does has a bug
    throw new Error('sharedDomainRefusal called twice on the same error instance');
  }
  const names = refusals.map((r) => r.baseUrl).join(', ');
  const withCause = (rs: DomainRefusal[]): string =>
    rs.map((r) => `${r.baseUrl}: ${r.error.message}`).join('; ');
  // what the loop establishes is one attempt per backend that led one, each led
  // by that backend and each ending one of two ways. On the sat side the
  // attempt runs through a pool, so the deciding bytes may have come from
  // another member, and claiming every backend reported the condition would
  // overstate it
  const unanimous = backendCount >= 2 && noAnswer.length === 0 && neverLed.length === 0;
  if (unanimous) {
    first.message =
      `${first.message} (each configured backend led an attempt that ended this way, ` +
      `so it is not one server's word: ${names})`;
  } else if (backendCount === 1) {
    first.message =
      `${first.message} (the single configured backend reported it: ${names}; ` +
      `one server's word is what this rests on, and a second configured backend is ` +
      `what would make it more)`;
  } else {
    const rest = [
      noAnswer.length ? `${noAnswer.length} produced no usable answer: ${withCause(noAnswer)}` : '',
      neverLed.length ? `${neverLed.length} never led an attempt: ${neverLed.join(', ')}` : '',
    ].filter((s) => s !== '');
    first.message =
      `${first.message} (${refusals.length} of ${backendCount} configured backends led an ` +
      `attempt that ended this way: ${names}; ${rest.join('; ')})`;
  }
  const shared = first as SharedRefusalError;
  shared.unanimous = unanimous;
  return shared;
}
