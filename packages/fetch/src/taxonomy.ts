/**
 * The refusal taxonomy's class-level facts, in one table.
 *
 * Every refusal in this codebase answers two questions. The first is whether
 * the refusal was derived from data the reveal txid commits, and that answer
 * alone decides build-time terminality: a refusal derived from uncommitted
 * witness data is one server's claim and the build rotates to another
 * backend, while a refusal derived from committed data is the same on every
 * backend and rotating only wastes a walk. The second is what the refusal
 * asserts about the chain, which decides how the CLI reports it; that answer
 * is presentation and lives with the CLI (`packages/cli/src/taxonomy.ts`),
 * keyed on the same union exported here, so a class added to this table
 * without a CLI row fails to compile there.
 *
 * The split is deliberate. The build loops in this package need the first
 * answer and cannot import it from the CLI without a cycle, and the second
 * answer's sentences name CLI flags and CLI output contexts, which do not
 * belong in a library's API. `SatStepLimitError` moved from this package into
 * core for the same import-direction reason, and this module follows that
 * precedent.
 *
 * Because `REFUSAL_CLASS_FACTS` is a `Record` keyed on `RefusalClassName`,
 * adding a name to the union without a row is a compile error. The reverse
 * direction, an error class exported from core or from this package that
 * appears in no table at all, is caught by a test that walks both packages'
 * exports (`packages/cli/test/taxonomy.test.ts`).
 */

import {
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  SatStepLimitError,
} from '@ordspv/core';

/**
 * No backend could serve the raw block the reveal's witness section is built
 * from. This is an availability failure and retrying elsewhere or later may
 * well succeed, which is exactly what `EnvelopeIndexUnprovenError` does not
 * mean: that class is the verifier's refusal of a reveal whose numbering
 * cannot be proven at all. The message names every backend tried and its
 * cause, including a backend that exposes no raw-block method.
 *
 * Defined here rather than in `custodybuilder.ts` so the facts table below
 * can hold its constructor without importing from a module that imports this
 * one back.
 */
export class WitnessSectionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WitnessSectionUnavailableError';
  }
}

/**
 * The code strings `CustodyError` and `SatIdentityError` carry. They are one
 * named union so the CLI's code-to-category table can be keyed on it and fail
 * to compile when a code is added without a row.
 */
export type WrapperCode = 'BUILD_FAILED' | 'VERIFY_FAILED' | 'HEADER_TRUST';

/**
 * The refusal classes the CLI maps to an exit code. `SatPositionError` is
 * deliberately not here: raised by a verifier it means the bundle's own bound
 * pointer does not land in the output sat space, which is a forgery and
 * reports invalid through the generic path, and the build loops rotate on it
 * by name beside the predicate below.
 */
export type RefusalClassName =
  | 'CustodyUnsupportedError'
  | 'EnvelopeIndexUnprovenError'
  | 'CoinbaseHeightUnprovenError'
  | 'SatStepLimitError'
  | 'WitnessSectionUnavailableError';

export interface RefusalClassFacts {
  /** the class itself, so consumers test with instanceof against the table */
  ctor: abstract new (...args: never[]) => Error;
  /**
   * True when the refusal is derived from data the reveal txid commits, which
   * makes it the same on every backend and therefore terminal at build time.
   * False means the deciding bytes were one server's word and a build loop
   * records the refusal as that backend's cause and rotates.
   */
  committedAtBuild: boolean;
}

export const REFUSAL_CLASS_FACTS: Record<RefusalClassName, RefusalClassFacts> = {
  // the v1-domain judgement is read out of the served reveal witness, which
  // the txid does not commit to
  CustodyUnsupportedError: { ctor: CustodyUnsupportedError, committedAtBuild: false },
  // the reveal's input count is inside the txid, so leading with another
  // backend cannot change the answer; no builder raises the class today and
  // the loops' terminal arms for it stay beside them with their comments
  EnvelopeIndexUnprovenError: { ctor: EnvelopeIndexUnprovenError, committedAtBuild: true },
  // the claimed height is the serving backend's word until anchored; no
  // builder raises the class today, so the rotate this row implies has no
  // live build-time example
  CoinbaseHeightUnprovenError: { ctor: CoinbaseHeightUnprovenError, committedAtBuild: false },
  // the depth that reaches the cap follows from a start position read out of
  // an unbound reveal witness
  SatStepLimitError: { ctor: SatStepLimitError, committedAtBuild: false },
  // the block hash and the in-block position come from the leading backend's
  // own status and merkle proof
  WitnessSectionUnavailableError: {
    ctor: WitnessSectionUnavailableError,
    committedAtBuild: false,
  },
};

/**
 * Whether a build-time failure is recorded as the leading backend's domain
 * refusal, after which the loop advances to the next backend. True exactly
 * for the classes whose row says the deciding data was not committed by the
 * reveal txid. Everything else keeps each loop's own behavior at that site:
 * the terminal rethrow for `EnvelopeIndexUnprovenError`, the by-name rotate
 * for `SatPositionError`, and the no-usable-answer accounting for the rest.
 */
export function isRecordableBuildRefusal(e: unknown): boolean {
  for (const facts of Object.values(REFUSAL_CLASS_FACTS)) {
    if (!facts.committedAtBuild && e instanceof facts.ctor) return true;
  }
  return false;
}
