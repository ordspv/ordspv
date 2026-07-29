/**
 * The one table every command and both output channels read to report a
 * refusal.
 *
 * The class-level facts, which classes exist and whether a build rotates on
 * them, live in `@ordspv/fetch` (`taxonomy.ts` there), because the build
 * loops need them and this package sits above that one. What lives here is
 * presentation: what each class asserts about the chain, which decides the
 * exit code, plus the prefix category and the remedy sentence each output
 * context prints. Both tables are `Record`s keyed on unions exported from
 * `@ordspv/fetch`, so a class or a wrapper code added there without a row
 * here fails to compile, which is the point of the table.
 *
 * A class's category holds when the refusal is proven: raised by a verifier,
 * or reached by every configured backend of a build with at least two. A
 * build-time refusal short of that strength carries `unanimous: false`
 * (`SharedRefusalError` in `@ordspv/fetch`) and reports
 * `nonUnanimousCategory` instead, which differs from `category` only for
 * `CustodyUnsupportedError`: out of scope is a claim about the chain, and on
 * the word of the backends that answered the build cannot make it, so the
 * refusal drops to unproven.
 */

import {
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  GalleryEncodingError,
  SatPositionError,
  SatStepLimitError,
} from '@ordspv/core';
import {
  CustodyBuildError,
  CustodyError,
  HeaderTrustError,
  OrdResolveError,
  ResponseCapExceededError,
  RevealSourceError,
  SatBuildError,
  SatIdentityError,
  WitnessSectionUnavailableError,
  type RefusalClassName,
  type WrapperCode,
} from '@ordspv/fetch';

/**
 * Which command is reporting. The class-to-code mapping is the same on both,
 * so a refusal keeps its exit code whether the caller read a bundle back or
 * resolved the same inscription live. Only the prefix and the remedy vary,
 * because reading a file and walking a chain are answered differently.
 */
export type RefusalContext = 'verify' | 'live';

/**
 * What a failure asserts, which is what its exit code reports. UNPROVEN and
 * OUT OF SCOPE belong to refusal classes; INCOMPLETE and INVALID belong to
 * the wrapper codes, a build that never verified anything and a document
 * that failed verification.
 */
export type RefusalCategory = 'UNPROVEN' | 'OUT OF SCOPE' | 'INCOMPLETE' | 'INVALID';

/**
 * The exit code belongs to the category and the category to the class, so
 * a code and a prefix that disagree are not expressible. 2 is usage and is
 * raised directly at the argument parser, never through this table.
 */
export const CATEGORY_EXIT_CODES: Record<RefusalCategory, number> = {
  UNPROVEN: 3,
  'OUT OF SCOPE': 4,
  INCOMPLETE: 5,
  INVALID: 1,
};

type ErrorClass = abstract new (...args: never[]) => Error;

export interface RefusalRow {
  /** the class itself, so the reporter tests with instanceof against the table */
  ctor: ErrorClass;
  /** what the class asserts when the refusal is proven */
  category: 'UNPROVEN' | 'OUT OF SCOPE';
  /** what it asserts when a build reports it short of every configured backend */
  nonUnanimousCategory: 'UNPROVEN' | 'OUT OF SCOPE';
  /**
   * The remedy sentence per output context. It names the flag that changes
   * the outcome wherever one exists; the offline verify context for the
   * coinbase height has none, since no anchor can be supplied to an offline
   * verification today.
   */
  note: Record<RefusalContext, string>;
  /**
   * Replaces `note` when the refusal is non-unanimous, for the one class
   * whose proven sentence asserts a chain fact the weaker build cannot.
   */
  nonUnanimousNote?: string;
}

const WITNESS_SECTION_NOTE =
  `No backend that answered served the raw block the reveal's witness section is ` +
  `built from; retrying later may serve it, and --esplora names other backends.`;

export const REFUSAL_TABLE: Record<RefusalClassName, RefusalRow> = {
  CustodyUnsupportedError: {
    ctor: CustodyUnsupportedError,
    category: 'OUT OF SCOPE',
    // out of scope says the path really does leave what v1 proves, which is
    // a statement about the chain; on the strength of the backends that
    // answered it is a claim the build cannot make
    nonUnanimousCategory: 'UNPROVEN',
    note: {
      verify: `The bundle is well formed and the path leaves what v1 proves.`,
      live: `The path is well formed and leaves what v1 proves.`,
    },
    nonUnanimousNote:
      `The path is well formed and leaves what v1 proves, which is more than this ` +
      `build can establish about the chain.`,
  },
  EnvelopeIndexUnprovenError: {
    ctor: EnvelopeIndexUnprovenError,
    category: 'UNPROVEN',
    nonUnanimousCategory: 'UNPROVEN',
    note: {
      verify:
        `The reveal's envelope numbering needs a witness section; rebuilding with ` +
        `--witness-section always against a backend that serves raw blocks supplies one.`,
      live:
        `The reveal's envelope numbering needs a witness section; --witness-section always ` +
        `against a backend that serves raw blocks supplies one.`,
    },
  },
  CoinbaseHeightUnprovenError: {
    ctor: CoinbaseHeightUnprovenError,
    category: 'UNPROVEN',
    nonUnanimousCategory: 'UNPROVEN',
    note: {
      verify:
        `Check the coinbase block hash at that height against your own chain view; ` +
        `library callers can supply that attestation through the trustHeader hook.`,
      live:
        `Below the BIP34 boundary the claimed height rests on an attestation of the ` +
        `block hash at that height, and no configured anchor source gave one; ` +
        `--anchor-source names others.`,
    },
  },
  SatStepLimitError: {
    ctor: SatStepLimitError,
    category: 'UNPROVEN',
    nonUnanimousCategory: 'UNPROVEN',
    note: {
      verify: `The bundle is deeper than the verifier's cap; --max-steps N raises it.`,
      live: `The ancestry is deeper than the walk's cap; --max-steps N raises it.`,
    },
  },
  WitnessSectionUnavailableError: {
    ctor: WitnessSectionUnavailableError,
    category: 'UNPROVEN',
    nonUnanimousCategory: 'UNPROVEN',
    note: { verify: WITNESS_SECTION_NOTE, live: WITNESS_SECTION_NOTE },
  },
};

/**
 * How a wrapper's code string reports. INVALID means the reporter stands
 * aside and the command's own invalid path formats the failure at exit 1,
 * which is why that arm carries no note; the discriminated shape makes a
 * reportable category with a missing note inexpressible.
 */
export type WrapperRow =
  | { category: 'INVALID' }
  | { category: 'UNPROVEN' | 'INCOMPLETE'; note: string };

export const WRAPPER_TABLE: Record<WrapperCode, WrapperRow> = {
  BUILD_FAILED: {
    category: 'INCOMPLETE',
    note:
      `No configured backend produced a usable answer, so nothing was verified; ` +
      `--esplora names others.`,
  },
  HEADER_TRUST: {
    category: 'UNPROVEN',
    note:
      `The headers could not be anchored to the agreement this build required; ` +
      `--anchor-source names others.`,
  },
  VERIFY_FAILED: { category: 'INVALID' },
};

/** The two wrapper classes whose `code` string the table above is keyed on. */
export const WRAPPER_ERRORS: readonly ErrorClass[] = [CustodyError, SatIdentityError];

/**
 * Error classes deliberately absent from the tables. The coverage test walks
 * every error class exported from `@ordspv/core` and `@ordspv/fetch` and
 * requires each to appear in a table or here, so a class added upstream that
 * never reaches the CLI is a test failure rather than a silent gap.
 */
export const EXCLUDED_ERRORS: readonly { ctor: ErrorClass; reason: string }[] = [
  {
    ctor: SatPositionError,
    reason:
      `raised by a verifier it means the bundle's own bound pointer does not land in ` +
      `the output sat space, a forgery, reported invalid at exit 1; the build loops ` +
      `rotate on it by name, beside the taxonomy predicate`,
  },
  {
    ctor: GalleryEncodingError,
    reason: `a gallery document that violates its own encoding is a defective document, invalid`,
  },
  {
    ctor: SatBuildError,
    reason: `one backend's build failure, recorded as that backend's cause under BUILD_FAILED`,
  },
  {
    ctor: RevealSourceError,
    reason:
      `one member's transport failure on a deciding reveal request, recorded as that ` +
      `member's cause so the build leads the next attempt with another member`,
  },
  {
    ctor: CustodyBuildError,
    reason: `one backend's build failure, recorded as that backend's cause under BUILD_FAILED`,
  },
  {
    ctor: ResponseCapExceededError,
    reason: `a transport cap on one response, surfaced as the failed request's cause`,
  },
  {
    ctor: OrdResolveError,
    reason: `the resolve command's content failure, reported by its own error path at exit 1`,
  },
  {
    ctor: HeaderTrustError,
    reason: `anchoring machinery failure, reaches callers wrapped under the HEADER_TRUST code`,
  },
];
