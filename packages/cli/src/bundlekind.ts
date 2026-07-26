/**
 * Which of the three bundle shapes a parsed JSON file holds.
 *
 * `version` is 1 in all three, so it discriminates nothing. Each shape does
 * carry top-level keys the others do not, and that is what this reads. A file
 * matching none of them is named as such, with the keys it actually has,
 * instead of dying inside a verifier on a missing property.
 */

export type BundleKind = 'proof' | 'custody' | 'genealogy';

export class UnknownBundleError extends Error {}

function has(value: Record<string, unknown>, key: string): boolean {
  return value[key] !== undefined;
}

export function classifyBundle(parsed: unknown): BundleKind {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnknownBundleError(
      `not a bundle object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed}); ` +
        `expected a proof bundle, a custody bundle, or a sat genealogy bundle`,
    );
  }
  const o = parsed as Record<string, unknown>;
  if (has(o, 'claimedSat') && has(o, 'funding') && has(o, 'coinbase')) return 'genealogy';
  if (has(o, 'hops') && has(o, 'finalSatpoint')) return 'custody';
  if (has(o, 'level') && has(o, 'block')) return 'proof';
  const keys = Object.keys(o);
  throw new UnknownBundleError(
    `unrecognized bundle shape. Expected one of: a proof bundle (level, block), ` +
      `a custody bundle (hops, finalSatpoint), or a sat genealogy bundle ` +
      `(claimedSat, funding, coinbase). Top-level keys found: ` +
      `${keys.length ? keys.join(', ') : '(none)'}`,
  );
}
