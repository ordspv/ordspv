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
 * A class's category is keyed by output context, because the same class can
 * assert different things depending on which phase raised it. A verifier reads
 * a bundle that has already bound its witness, so what it refuses is a
 * property of the document. A build loop reads a served reveal witness that
 * nothing has bound, so what it refuses may be one server's word. Only
 * `SatPositionError` differs between the two today, and keying the field by
 * context rather than special-casing that class keeps the missing-row compile
 * error the tables exist for.
 *
 * Within the live context, a build-time refusal short of every configured
 * backend carries `unanimous: false` (`SharedRefusalError` in `@ordspv/fetch`)
 * and reports `nonUnanimousCategory` instead.
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
  CustodyHopLimitError,
  HeaderTrustError,
  HopConsistencyError,
  OrdResolveError,
  PoolExhaustedError,
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

/**
 * The classes the reporter maps. Every class whose build-time facts the loops
 * read is here through `RefusalClassName`, so a class added to that union
 * without a row fails to compile. `SatPositionError` is added on top: it
 * carries no build-time facts row, since both loops rotate on it by name
 * rather than through the predicate, and it still needs a category and a
 * remedy in both contexts.
 */
export type ReportedRefusalName = RefusalClassName | 'SatPositionError';

export interface RefusalRow {
  /** the class itself, so the reporter tests with instanceof against the table */
  ctor: ErrorClass;
  /** what the class asserts in each output context when the refusal is proven */
  category: Record<RefusalContext, RefusalCategory>;
  /**
   * What it asserts when a build reports it short of every configured backend.
   * It applies in the live context alone, because the `unanimous` marker is
   * written by `sharedDomainRefusal` in the build loops and a refusal a
   * verifier raised never carries one.
   */
  nonUnanimousCategory: 'UNPROVEN' | 'OUT OF SCOPE';
  /**
   * The remedy sentence per output context. It names the flag that changes
   * the outcome wherever one exists; neither coinbase-height context has
   * one, since no anchor can be supplied to an offline verification today
   * and the live refusal is raised before any anchoring runs.
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
  `built from; retrying later may serve it, --esplora names other backends, and ` +
  `--timeout-ms N raises the per-request deadline.`;

export const REFUSAL_TABLE: Record<ReportedRefusalName, RefusalRow> = {
  CustodyUnsupportedError: {
    ctor: CustodyUnsupportedError,
    category: { verify: 'OUT OF SCOPE', live: 'OUT OF SCOPE' },
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
    category: { verify: 'UNPROVEN', live: 'UNPROVEN' },
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
  // one CLI path reaches this class: a live sat build whose fee-tail refusal
  // sits on a terminal coinbase below the BIP34 boundary raises it from the
  // build loop, because the subsidy boundary that refusal turns on is decided
  // by a served height nothing in the bundle binds. The verification arm
  // still needs a library caller supplying its own trustHeader hook, since
  // every command configures header trust that yields 'hash-at-height', and
  // the row is what makes that caller's report correct
  CoinbaseHeightUnprovenError: {
    ctor: CoinbaseHeightUnprovenError,
    category: { verify: 'UNPROVEN', live: 'UNPROVEN' },
    nonUnanimousCategory: 'UNPROVEN',
    note: {
      verify:
        `Check the coinbase block hash at that height against your own chain view; ` +
        `library callers can supply that attestation through the trustHeader hook.`,
      live:
        `Below the BIP34 boundary only an attestation of the block hash at that height ` +
        `binds the claimed height to the block, and no flag supplies one: this refusal ` +
        `is raised while the bundle is being built, before any anchoring runs. ` +
        `A library caller can supply the attestation through the trustHeader hook.`,
    },
  },
  SatStepLimitError: {
    ctor: SatStepLimitError,
    category: { verify: 'UNPROVEN', live: 'UNPROVEN' },
    nonUnanimousCategory: 'UNPROVEN',
    note: {
      verify: `The bundle is deeper than the verifier's cap; --max-steps N raises it.`,
      live: `The ancestry is deeper than the walk's cap; --max-steps N raises it.`,
    },
  },
  // build-only: the custody verifier reads no cap, so no verify path raises
  // the class, and the verify sentence states the build-time fact the way
  // WitnessSectionUnavailableError's does
  CustodyHopLimitError: {
    ctor: CustodyHopLimitError,
    category: { verify: 'UNPROVEN', live: 'UNPROVEN' },
    nonUnanimousCategory: 'UNPROVEN',
    note: {
      verify: `The walk that built the bundle stopped at its hop cap; the custody verifier reads no cap of its own.`,
      live: `The custody path is longer than the walk's cap; --max-hops N raises it.`,
    },
  },
  WitnessSectionUnavailableError: {
    ctor: WitnessSectionUnavailableError,
    category: { verify: 'UNPROVEN', live: 'UNPROVEN' },
    nonUnanimousCategory: 'UNPROVEN',
    note: { verify: WITNESS_SECTION_NOTE, live: WITNESS_SECTION_NOTE },
  },
  SatPositionError: {
    ctor: SatPositionError,
    // the phase decides what the class means. A verifier reads a pointer the
    // bundle's own witness section or single input already bound, so a
    // position outside the output sat space is a document contradicting
    // itself. A build loop reads the pointer and the envelope input out of a
    // served reveal witness, and the root txid check proves only that the
    // reveal hex hashes to the id's txid, which commits to no witness byte.
    // Only a wtxid anchor binds those, and the build has none at the point
    // this is raised, so live it is unproven and stays unproven however many
    // backends read the same unbound witness
    category: { verify: 'INVALID', live: 'UNPROVEN' },
    nonUnanimousCategory: 'UNPROVEN',
    note: {
      verify:
        `The bundle's own bound pointer does not land in the output sat space, so the ` +
        `document contradicts itself.`,
      live:
        `The position comes from a pointer and an envelope input read out of a reveal ` +
        `witness the inscription id's txid does not commit to; another backend may serve ` +
        `a reveal that binds them, and --esplora names others.`,
    },
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
  // a refusal is a usable answer, and both loops reach this code with a set of
  // refusals whose classes differ, so the sentence has to be true of that case
  // as well as of a total outage. The error's own message carries every cause
  // and the human channel prints it ahead of this note
  BUILD_FAILED: {
    category: 'INCOMPLETE',
    note:
      `No configured backend produced an answer this build could stand on; ` +
      `the causes above name what each one did, and --esplora names others.`,
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
      `one member's failure inside the lead-derived span, a deciding request that ` +
      `failed or a served value that could not be built from, recorded as that ` +
      `member's cause so the build leads the next attempt with another member`,
  },
  {
    ctor: CustodyBuildError,
    reason: `one backend's build failure, recorded as that backend's cause under BUILD_FAILED`,
  },
  {
    ctor: HopConsistencyError,
    reason:
      `one attempt's answers about a hop disagreeing with each other, which says nothing ` +
      `about the chain; both loops record it as that backend producing no usable answer ` +
      `and rotate, so it never reaches this reporter as a refusal`,
  },
  {
    ctor: PoolExhaustedError,
    reason:
      `every member of one attempt's pool failed one request. The class is raised inside ` +
      `the genealogy build loop, which is the only place a pool is constructed, and that ` +
      `loop catches it to end the build and report the causes under BUILD_FAILED, so no ` +
      `path carries it here`,
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
    reason:
      `anchoring machinery failure. Live it reaches callers wrapped under the ` +
      `HEADER_TRUST code; offline verify surfaces a checkpoint contradiction ` +
      `through the command's own invalid path at exit 1, since a header that ` +
      `contradicts a compiled-in checkpoint is a document defect`,
  },
];
