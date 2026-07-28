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
 * The refusal to rethrow when every configured backend reported the same one,
 * so a caller still discriminates on the class it discriminates on today. The
 * message gains the fact that every backend agreed, and their names.
 *
 * Returns undefined when the failures were mixed or did not cover every
 * backend; the caller's own build-failure path handles that case with every
 * cause joined.
 */
export function sharedDomainRefusal(
  refusals: DomainRefusal[],
  backendCount: number,
): Error | undefined {
  if (refusals.length === 0 || refusals.length !== backendCount) return undefined;
  const first = refusals[0].error;
  if (!refusals.every((r) => r.error.constructor === first.constructor)) return undefined;
  const names = refusals.map((r) => r.baseUrl).join(', ');
  first.message =
    `${first.message} (every configured backend reported this, so it is not one ` +
    `server's word: ${names})`;
  return first;
}
