import type { BlockHeader } from '@ordspv/core';
import type { EsploraBackend } from './backends.js';

/**
 * Header trust anchoring. verifyProofBundle already checks the header's own
 * PoW and internal consistency; what it cannot know is whether that header is
 * part of the canonical most-work chain. Options, composable:
 *
 * 1. Hard-coded checkpoints: heights whose hashes are compiled in. Cheap,
 *    covers historic content (most inscriptions), requires releases to
 *    refresh.
 * 2. Independent multi-source agreement: ask N esplora instances (ideally
 *    operated by unrelated parties) for the hash at the proof's height and
 *    require M agreements including our header.
 * 3. (roadmap) Full header-chain sync from P2P/Electrum with checkpointed
 *    difficulty validation — removes the server honesty assumption entirely.
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
  /** how many independent sources must agree (default: all provided, min 1) */
  minAgreement?: number;
  checkpoints?: ReadonlyMap<number, string>;
  /** require this many confirmations on top of the proof's block (0 = skip) */
  minConfirmations?: number;
}

export interface HeaderTrustReport {
  checkpointHit: boolean;
  sourcesQueried: number;
  sourcesAgreed: number;
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

  return async function checkHeader(header: BlockHeader, height: number): Promise<HeaderTrustReport> {
    const checkpoint = checkpoints.get(height);
    if (checkpoint !== undefined) {
      if (checkpoint !== header.hash) {
        throw new HeaderTrustError(
          `header ${header.hash} at height ${height} contradicts checkpoint ${checkpoint}`,
        );
      }
      return { checkpointHit: true, sourcesQueried: 0, sourcesAgreed: 0 };
    }

    if (esploras.length === 0) {
      throw new HeaderTrustError(
        `no checkpoint for height ${height} and no header sources configured`,
      );
    }

    const results = await Promise.allSettled(
      esploras.map(async (e) => ({
        hash: (await e.getBlockHashAtHeight(height)).trim().toLowerCase(),
        tip: Number((await e.getTipHeight()).trim()),
      })),
    );
    const successes = results.filter(
      (r): r is PromiseFulfilledResult<{ hash: string; tip: number }> => r.status === 'fulfilled',
    );
    const agreed = successes.filter((r) => r.value.hash === header.hash);
    const minAgreement = options.minAgreement ?? Math.max(1, Math.min(2, esploras.length));
    if (agreed.length < minAgreement) {
      throw new HeaderTrustError(
        `only ${agreed.length}/${esploras.length} header sources agree on height ${height} ` +
          `(need ${minAgreement}); header ${header.hash}`,
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
      sourcesQueried: esploras.length,
      sourcesAgreed: agreed.length,
      tipHeight,
    };
  };
}
