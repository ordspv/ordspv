import { bitsToTarget, MAINNET_CHAIN_PARAMS, type BlockHeader } from '@ordspv/core';
import type { EsploraBackend } from './backends.js';

/**
 * Header trust anchoring. verifyProofBundle already checks the header's own
 * PoW and internal consistency; what it cannot know is whether that header is
 * part of the canonical most-work chain. Options, composable:
 *
 * 1. Hard-coded checkpoints: heights whose hashes are compiled in. Cheap,
 *    covers historic content (most inscriptions), requires releases to
 *    refresh.
 * 2. Independent multi-source agreement: ask the configured esplora instances
 *    (ideally operated by unrelated parties) for the hash at the proof's
 *    height. The backend that BUILT the proof is excluded from this attesting
 *    set (its hash-at-height answer would be a self-vote), but it still
 *    counts as one independent source, since it served an internally
 *    verified proof. Anchoring is FAIL-CLOSED: a height covered by neither a
 *    checkpoint nor enough independent sources is rejected, never silently
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
  esploras?: EsploraBackend[];
  /**
   * How many independent sources must support the header at a non-checkpoint
   * height (default 2). The proof-building backend counts as one; each
   * agreeing backend OTHER than the builder counts as one more. Lowering
   * this to 1 disables independent anchoring — do that only when a covering
   * checkpoint set or headerSyncTrust provides the anchor instead.
   */
  minAgreement?: number;
  checkpoints?: ReadonlyMap<number, string>;
  /** require this many confirmations on top of the proof's block (0 = skip) */
  minConfirmations?: number;
  /**
   * baseUrl of the backend that produced the proof being anchored. Its
   * hash-at-height answer is excluded from the attesting set so it cannot
   * vote for its own header.
   */
  proofSource?: string;
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
  /** attesting sources queried (proof-building backend excluded) */
  sourcesQueried: number;
  /** attesting sources whose hash-at-height matched the header */
  sourcesAgreed: number;
  /**
   * distinct independent sources supporting the header: the proof source
   * (when known) plus each agreeing attester. 0 for checkpoint/sync anchors,
   * which pin the header without live sources.
   */
  independentSources: number;
  /** the header is pinned by a checkpoint, a synced chain, or enough independent sources */
  anchored: boolean;
  tipHeight?: number;
  /** set when the anchor was a locally validated header chain (headersync) */
  anchoredBySync?: boolean;
}

export class HeaderTrustError extends Error {}

/**
 * Returns an async checker suitable for calling after verifyProofBundle.
 * Throws HeaderTrustError when the header cannot be anchored.
 */
export function makeHeaderTrust(options: HeaderTrustOptions = {}) {
  const checkpoints = options.checkpoints ?? MAINNET_CHECKPOINTS;
  const esploras = options.esploras ?? [];
  const powLimitBits = options.powLimitBits === undefined ? MAINNET_CHAIN_PARAMS.powLimitBits : options.powLimitBits;

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
        anchored: true,
      };
    }

    // the proof-building backend cannot attest to its own header
    const attesters = esploras.filter((e) => e.baseUrl !== options.proofSource);
    const builderCredit = options.proofSource !== undefined ? 1 : 0;
    const required = options.minAgreement ?? 2;

    const results = await Promise.allSettled(
      attesters.map(async (e) => ({
        hash: (await e.getBlockHashAtHeight(height)).trim().toLowerCase(),
        tip: Number((await e.getTipHeight()).trim()),
      })),
    );
    const successes = results.filter(
      (r): r is PromiseFulfilledResult<{ hash: string; tip: number }> => r.status === 'fulfilled',
    );
    const agreed = successes.filter((r) => r.value.hash === header.hash);
    const independentSources = agreed.length + builderCredit;
    if (independentSources < required) {
      throw new HeaderTrustError(
        `height ${height} not independently anchored: ${independentSources} independent ` +
          `source(s) support header ${header.hash} (need ${required}; ${agreed.length}/${attesters.length} ` +
          `attesters agreed). Provide >=2 independent esplora sources, a covering checkpoint, ` +
          `or a headerSyncTrust anchor.`,
      );
    }
    const tips = successes.map((r) => r.value.tip).sort((a, b) => a - b);
    const tipHeight = tips.length ? tips[Math.floor(tips.length / 2)] : undefined;
    if (options.minConfirmations && tipHeight !== undefined) {
      const confs = tipHeight - height + 1;
      if (confs < options.minConfirmations) {
        throw new HeaderTrustError(`only ${confs} confirmations, need ${options.minConfirmations}`);
      }
    }
    return {
      checkpointHit: false,
      sourcesQueried: attesters.length,
      sourcesAgreed: agreed.length,
      independentSources,
      anchored: true,
      tipHeight,
    };
  };
}
