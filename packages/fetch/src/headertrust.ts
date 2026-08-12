import {
  bitsToTarget,
  MAINNET_CHAIN_PARAMS,
  type BlockHeader,
  type HeaderAttestation,
} from '@ordspv/core';
import { normalizeBaseUrl, type EsploraBackend } from './backends.js';

/**
 * Header trust anchoring. verifyProofBundle already checks the header's own
 * PoW and internal consistency; what it cannot know is whether that header is
 * part of the canonical most-work chain. Options, composable:
 *
 * 1. Hard-coded checkpoints: heights whose hashes are compiled in. Cheap,
 *    covers historic content (most inscriptions), requires releases to
 *    refresh.
 * 2. Independent multi-source agreement: ask the configured attesting
 *    instances (ideally operated by unrelated parties) for the hash at the
 *    proof's height. Every backend that served bytes for the bundle is
 *    excluded from this attesting set and contributes no count of its own: a
 *    server vouching for the header it just served is a self-vote, whichever
 *    endpoint carries it. The count is therefore the number of agreeing
 *    outside attesters. Anchoring is FAIL-CLOSED: a height covered by neither
 *    a checkpoint nor enough independent sources is rejected, never silently
 *    accepted.
 * 3. Header-chain sync from Electrum with local difficulty validation
 *    (`@ordspv/fetch/headersync`), which removes the server honesty
 *    assumption entirely (the `trustHeader` resolver option).
 *
 * Defense in depth: headers whose compact target is easier than the network
 * proof-of-work limit are rejected outright (default mainnet 0x1d00ffff,
 * matching the default mainnet checkpoints). Non-mainnet users override or
 * disable via `powLimitBits`.
 */

/** Well-known mainnet checkpoints (height -> display-order block hash). */
export const MAINNET_CHECKPOINTS: ReadonlyMap<number, string> = new Map([
  [0, '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'],
  // block containing inscription 0
  [767430, '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5'],
  // ord "Jubilee" activation block
  [824544, '00000000000000000001b7f8d0289c6e15e5a6c9a59894b955afcf7dd8f9b1fe'],
]);

export interface HeaderTrustOptions {
  /**
   * Attesting backends: the endpoints asked for the hash at the proof's
   * height. Callers pass their anchor sources here (see
   * `DEFAULT_ANCHOR_SOURCES`), which need only `/block-height/<n>` and are a
   * different membership question from the backends that serve proofs.
   */
  esploras?: EsploraBackend[];
  /**
   * How many agreeing attesters must support the header at a non-checkpoint
   * height (default 2). Backends that served the bundle are excluded from the
   * vote and add nothing to the count. Lowering this to 1 leaves a single
   * outside source able to anchor a header; do that only when a covering
   * checkpoint set or headerSyncTrust provides the anchor instead. Values
   * below 1 are rejected at construction: a threshold of 0 anchors a header
   * on nobody's word, which is the same as not anchoring at all.
   */
  minAgreement?: number;
  checkpoints?: ReadonlyMap<number, string>;
  /**
   * Require this many confirmations on top of the proof's block (0 = skip).
   * A whole number of blocks, validated at construction for the reason
   * `minAgreement` is: the reach is `Number(process.env.X)`, `NaN` is falsy,
   * and a falsy depth skipped the phase entirely, so a caller that asked for
   * a floor got no tip query at all and no field in the report to say so.
   */
  minConfirmations?: number;
  /**
   * baseUrl of the backend that produced the proof being anchored. Its
   * hash-at-height answer is excluded from the attesting set so it cannot
   * vote for its own header.
   */
  proofSource?: string;
  /**
   * Every baseUrl that served bytes for the bundle, for builds spread across a
   * pool. All of them are excluded from the attesting set, as `proofSource` is
   * for a single-backend build; the two options are additive.
   */
  proofSources?: Iterable<string>;
  /**
   * Compact-bits proof-of-work floor: reject any header whose target is
   * easier than this limit. Defaults to the mainnet powLimit (0x1d00ffff),
   * matching the default mainnet checkpoints; pass the network's own limit
   * (or null to disable) for non-mainnet chains.
   */
  powLimitBits?: number | null;
}

export interface HeaderTrustReport {
  checkpointHit: boolean;
  /** attesting sources queried (backends that served the bundle excluded) */
  sourcesQueried: number;
  /** attesting sources whose hash-at-height matched the header */
  sourcesAgreed: number;
  /**
   * independent sources supporting the header: the agreeing attesters, none
   * of which served the bundle. 0 for checkpoint/sync anchors, which pin the
   * header without live sources.
   */
  independentSources: number;
  /**
   * a serving backend was named, so its vote was excluded. Kept as a fact of
   * its own rather than folded into `independentSources`.
   */
  builderIsSource: boolean;
  /** the header is pinned by a checkpoint, a synced chain, or enough independent sources */
  anchored: boolean;
  /**
   * What the anchor asserted, in the core `trustHeader` hook's vocabulary.
   * `'hash-at-height'` means this block hash was compared against a view of
   * the chain AT this height and agreed, which is what binds a sub-BIP34
   * coinbase height (see `CoinbaseHeightUnprovenError`). A caller adapting
   * this async anchor into the core hook returns this value from it.
   */
  attests: HeaderAttestation;
  tipHeight?: number;
  /**
   * Attesters asked for a tip height. Absent when no confirmation depth was
   * enforced, which is a different fact from a depth enforced against zero
   * answers and is why these are absent rather than 0 on the arms that never
   * reach the phase.
   */
  tipsQueried?: number;
  /** attesters that answered a tip height this check could read as a height */
  tipsAnswered?: number;
  /** set when the anchor was a locally validated header chain (headersync) */
  anchoredBySync?: boolean;
}

export class HeaderTrustError extends Error {}

/**
 * A tip height an attester actually stated, or undefined for an answer that is
 * no height. `Number` reads '' as 0, which presented an empty response as
 * height zero and blamed confirmation depth for a malformed answer, and reads
 * anything else unparseable as NaN. NaN then travels: the sort comparator
 * returns NaN, `Array.prototype.sort` leaves the pair it cannot order where it
 * found it, and whether the garbage landed on the midpoint depended on which
 * attester answered first. Both answers are dropped here instead.
 */
function tipHeightFrom(text: string): number | undefined {
  if (!/^[0-9]+$/.test(text)) return undefined;
  const height = Number(text);
  return Number.isSafeInteger(height) ? height : undefined;
}

/**
 * Adapt a checkpoint set into the synchronous core `trustHeader` hook, for
 * verifiers that run offline. The check fires only when the claimed height is
 * a checkpoint height: a mismatch is refused, a match asserts
 * 'hash-at-height' exactly as `makeHeaderTrust`'s checkpoint arm does, and
 * every other height passes with no assertion, so the hook stays
 * rejection-only where no checkpoint speaks. `ord-resolve verify` passes this
 * hook on all three bundle kinds; heights the checkpoint set does not cover
 * still rest on the reader's own chain view.
 */
export function checkpointTrustHeader(
  checkpoints: ReadonlyMap<number, string> = MAINNET_CHECKPOINTS,
): (header: BlockHeader, height: number) => HeaderAttestation {
  return (header, height) => {
    const checkpoint = checkpoints.get(height);
    if (checkpoint === undefined) return undefined;
    if (checkpoint !== header.hash) {
      throw new HeaderTrustError(
        `header ${header.hash} at height ${height} contradicts checkpoint ${checkpoint}`,
      );
    }
    return 'hash-at-height';
  };
}

/**
 * Returns an async checker suitable for calling after verifyProofBundle.
 * Throws HeaderTrustError when the header cannot be anchored.
 */
export function makeHeaderTrust(options: HeaderTrustOptions = {}) {
  // an integer, because the threshold is counted against. `NaN < 1` is false,
  // so a bare lower bound let NaN through, `required` became NaN, every
  // comparison against it was false, and the anchor reported hash-at-height
  // with no attester agreeing at all. A caller reaches that through
  // Number(process.env.X)
  if (
    options.minAgreement !== undefined &&
    (!Number.isInteger(options.minAgreement) || options.minAgreement < 1)
  ) {
    throw new HeaderTrustError(
      `minAgreement ${options.minAgreement} is not a whole number of agreeing sources; ` +
        `pass an integer of 1 or more, and pair 1 with checkpoints or a synced chain`,
    );
  }
  // the same guard for the same reach. A depth is a count of blocks, so a
  // fractional one is compared against and printed, and a negative one passes
  // every comparison it is put to
  if (
    options.minConfirmations !== undefined &&
    (!Number.isInteger(options.minConfirmations) || options.minConfirmations < 0)
  ) {
    throw new HeaderTrustError(
      `minConfirmations ${options.minConfirmations} is not a whole number of blocks; ` +
        `pass an integer of 0 or more, where 0 enforces no depth`,
    );
  }
  const checkpoints = options.checkpoints ?? MAINNET_CHECKPOINTS;
  const esploras = options.esploras ?? [];
  const minConfirmations = options.minConfirmations ?? 0;
  const powLimitBits = options.powLimitBits === undefined ? MAINNET_CHAIN_PARAMS.powLimitBits : options.powLimitBits;
  // compared in canonical form: a case variant of a serving endpoint is the
  // same server, and must not pass as an outside attester
  const serving = new Set<string>([...(options.proofSources ?? [])].map(normalizeBaseUrl));
  if (options.proofSource !== undefined) serving.add(normalizeBaseUrl(options.proofSource));
  const builderIsSource = serving.size > 0;

  return async function checkHeader(header: BlockHeader, height: number): Promise<HeaderTrustReport> {
    if (powLimitBits !== null && bitsToTarget(header.bits) > bitsToTarget(powLimitBits)) {
      throw new HeaderTrustError(
        `header ${header.hash} target (bits 0x${header.bits.toString(16)}) is easier than the ` +
          `proof-of-work limit 0x${powLimitBits.toString(16)}; set powLimitBits for non-mainnet chains`,
      );
    }

    const checkpoint = checkpoints.get(height);
    if (checkpoint !== undefined) {
      if (checkpoint !== header.hash) {
        throw new HeaderTrustError(
          `header ${header.hash} at height ${height} contradicts checkpoint ${checkpoint}`,
        );
      }
      return {
        checkpointHit: true,
        sourcesQueried: 0,
        sourcesAgreed: 0,
        independentSources: 0,
        builderIsSource,
        anchored: true,
        // a checkpoint is a compiled-in hash AT a height, so matching it
        // asserts exactly hash-at-height
        attests: 'hash-at-height',
      };
    }

    // a backend that served the bundle cannot attest to its own header, and
    // one endpoint listed twice is still one endpoint however it is spelled
    const seen = new Set<string>();
    const attesters = esploras.filter((e) => {
      const base = normalizeBaseUrl(e.baseUrl);
      if (serving.has(base) || seen.has(base)) return false;
      seen.add(base);
      return true;
    });
    const required = options.minAgreement ?? 2;

    // Phase (a): hash-at-height only. Agreement must not depend on any other
    // endpoint of the same attester — a flaky tip lookup would otherwise
    // discard a perfectly good agreeing vote.
    const hashResults = await Promise.allSettled(
      attesters.map(async (e) => (await e.getBlockHashAtHeight(height)).trim().toLowerCase()),
    );
    const agreed = hashResults.filter(
      (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value === header.hash,
    );
    const independentSources = agreed.length;
    if (independentSources < required) {
      throw new HeaderTrustError(
        `height ${height} not independently anchored: ${independentSources} independent ` +
          `source(s) support header ${header.hash} (need ${required}; ${agreed.length}/${attesters.length} ` +
          `attesters agreed` +
          (builderIsSource ? `, ${serving.size} serving backend(s) excluded from the vote` : '') +
          `). Pass --anchor-source with at least ${required} endpoints that did not serve ` +
          `the bundle, a covering checkpoint, or a headerSyncTrust anchor.`,
      );
    }
    // Phase (b): tip heights, queried only when a confirmation depth is
    // actually enforced.
    let tipHeight: number | undefined;
    let tipsQueried: number | undefined;
    let tipsAnswered: number | undefined;
    if (minConfirmations > 0) {
      const tipResults = await Promise.allSettled(
        attesters.map(async (e) => (await e.getTipHeight()).trim()),
      );
      const tips = tipResults
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map((r) => tipHeightFrom(r.value))
        .filter((h): h is number => h !== undefined)
        .sort((a, b) => a - b);
      tipsQueried = attesters.length;
      tipsAnswered = tips.length;
      // a depth the caller asked for is enforced or refused, never skipped.
      // Every tip query failing used to leave tipHeight undefined and return
      // anchored, so the floor went unenforced and the report said nothing
      if (tips.length === 0) {
        throw new HeaderTrustError(
          `confirmation depth ${minConfirmations} was requested and no attester stated a usable tip height ` +
            `(${tipsQueried} queried, 0 answered). Pass --anchor-source with endpoints that serve ` +
            `/blocks/tip/height, or drop the depth requirement.`,
        );
      }
      tipHeight = tips[Math.floor(tips.length / 2)];
      const confs = tipHeight - height + 1;
      if (confs < minConfirmations) {
        throw new HeaderTrustError(`only ${confs} confirmations, need ${minConfirmations}`);
      }
    }
    return {
      checkpointHit: false,
      sourcesQueried: attesters.length,
      sourcesAgreed: agreed.length,
      independentSources,
      builderIsSource,
      anchored: true,
      tipHeight,
      tipsQueried,
      tipsAnswered,
      // every agreeing attester answered /block-height/<n> with this hash, so
      // the agreement is a hash-at-height attestation
      attests: 'hash-at-height',
    };
  };
}
