/**
 * What the CLI prints beside a result, and how it classifies a refusal.
 *
 * The sentences themselves live in `@ordspv/core` (notes.ts) so every surface
 * says the same thing in the same words. What lives here is which of them a
 * given result carries, and which refusals are something other than a forgery.
 * Both `verify` and `resolve` call these, so the two commands cannot drift.
 */

import {
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  L2_EXECUTED_LEAF_RESIDUAL,
  L2_NUMBERING_RESIDUAL,
} from '@ordspv/core';

/**
 * The residual sentences a content-path result carries. Below L3 the binding
 * proves commitment and not execution, and a multi-input reveal additionally
 * leaves the envelope numbering unproven, which is the one thing a gateway can
 * rewrite with no help from the inscriber.
 */
export function contentResiduals(
  level: string,
  l2?: { singleInputReveal: boolean },
): string[] {
  if (level === 'L3') return [];
  const out = [L2_EXECUTED_LEAF_RESIDUAL];
  if (l2 && !l2.singleInputReveal) out.push(L2_NUMBERING_RESIDUAL);
  return out;
}

/** How `ord-resolve verify` reports a refusal that is not a forgery. */
export interface RefusalReport {
  /** the whole line, prefix included, as `fail()` takes it */
  message: string;
  /** process exit code */
  code: number;
}

/**
 * Classify what an offline verification threw.
 *
 * Three refusals are not claims that the bundle is forged. An unanchored
 * sub-BIP34 coinbase height and an unprovable envelope numbering are both
 * bundles that may be perfectly honest and cannot prove one fact offline, and
 * a path outside v1's sat domain is a well-formed bundle whose ancestry this
 * version does not follow. Each gets its own prefix and its own exit code, so
 * a script can tell them apart from a forgery without reading the message.
 *
 * Returns undefined for everything else, which the caller reports as invalid.
 */
export function refusalReport(e: unknown): RefusalReport | undefined {
  const message = (e as Error).message;
  if (e instanceof CoinbaseHeightUnprovenError) {
    return {
      message:
        `bundle UNPROVEN offline: ${message}. ` +
        `Anchor the coinbase block hash at that height against your own chain view ` +
        `and re-run verification with that anchor supplied.`,
      code: 3,
    };
  }
  if (e instanceof EnvelopeIndexUnprovenError) {
    return {
      message:
        `bundle UNPROVEN offline: ${message}. ` +
        `The reveal's envelope numbering needs a witness section; rebuilding with ` +
        `--witness-section always against a backend that serves raw blocks supplies one.`,
      code: 3,
    };
  }
  if (e instanceof CustodyUnsupportedError) {
    return {
      message:
        `bundle OUT OF SCOPE: ${message}. ` +
        `The bundle is well formed and the path leaves what v1 proves.`,
      code: 4,
    };
  }
  return undefined;
}
