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
  SatStepLimitError,
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

/** How a command reports a refusal that is not a forgery. */
export interface RefusalReport {
  /** the whole line, prefix included, as `fail()` takes it */
  message: string;
  /** process exit code */
  code: number;
  /** the error class's own name, which is what the JSON channel discriminates on */
  name: string;
  /** the remedy sentence on its own, for the JSON channel */
  note: string;
}

/**
 * Which command is reporting. The class-to-code mapping is the same on both,
 * so a refusal keeps its exit code whether the caller read a bundle back or
 * resolved the same inscription live. Only the prefix and the remedy vary,
 * because reading a file and walking a chain are answered differently.
 */
export type RefusalContext = 'verify' | 'live';

/**
 * Classify what a verification or a live build threw.
 *
 * Four refusals are not claims that the bundle is forged. An unanchored
 * sub-BIP34 coinbase height and an unprovable envelope numbering are both
 * bundles that may be perfectly honest and cannot prove one fact offline, a
 * path outside v1's sat domain is a well-formed bundle whose ancestry this
 * version does not follow, and a step cap is a refusal to read work that was
 * never bounded. Each gets its own prefix and its own exit code, so a script
 * can tell them apart from a forgery without reading the message.
 *
 * Returns undefined for everything else, which the caller reports as invalid.
 */
export function refusalReport(
  e: unknown,
  context: RefusalContext,
  command = '',
): RefusalReport | undefined {
  const message = (e as Error).message;
  const live = context === 'live';
  const unproven = live ? `${command} UNPROVEN: ` : 'bundle UNPROVEN offline: ';
  const outOfScope = live ? `${command} OUT OF SCOPE: ` : 'bundle OUT OF SCOPE: ';
  const report = (prefix: string, note: string, code: number): RefusalReport => ({
    message: `${prefix}${message}. ${note}`,
    code,
    name: (e as Error).name,
    note,
  });
  if (e instanceof CoinbaseHeightUnprovenError) {
    return report(
      unproven,
      live
        ? `Below the BIP34 boundary the claimed height rests on an attestation of the ` +
            `block hash at that height, and no configured anchor source gave one; ` +
            `--anchor-source names others.`
        : `Anchor the coinbase block hash at that height against your own chain view ` +
            `and re-run verification with that anchor supplied.`,
      3,
    );
  }
  if (e instanceof EnvelopeIndexUnprovenError) {
    return report(
      unproven,
      live
        ? `The reveal's envelope numbering needs a witness section; --witness-section always ` +
            `against a backend that serves raw blocks supplies one.`
        : `The reveal's envelope numbering needs a witness section; rebuilding with ` +
            `--witness-section always against a backend that serves raw blocks supplies one.`,
      3,
    );
  }
  if (e instanceof SatStepLimitError) {
    return report(
      unproven,
      live
        ? `The ancestry is deeper than the walk's cap; --max-steps N raises it.`
        : `The bundle is deeper than the verifier's cap; --max-steps N raises it.`,
      3,
    );
  }
  if (e instanceof CustodyUnsupportedError) {
    return report(
      outOfScope,
      live
        ? `The path is well formed and leaves what v1 proves.`
        : `The bundle is well formed and the path leaves what v1 proves.`,
      4,
    );
  }
  return undefined;
}

/**
 * The one-line JSON a `--json` caller reads on a refusal, so the machine
 * channel discriminates on the same facts the human channel prints. A failure
 * with no mapping carries the same shape, so a caller parses one thing.
 */
export function refusalJson(e: unknown, report: RefusalReport | undefined): string {
  return JSON.stringify({
    ok: false,
    error: report ? report.name : 'Error',
    message: (e as Error).message,
    note: report?.note,
  });
}
