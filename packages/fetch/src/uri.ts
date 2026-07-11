import { isInscriptionId, parseInscriptionId, type InscriptionId } from '@ordspv/core';

/**
 * ord URI parsing.
 *
 * Canonical form (per the upstream draft in the ord handbook,
 * docs.ordinals.com/inscriptions/uris.html):
 *
 *     ord:<txid>i<index>            — case-insensitive, lowercase preferred
 *
 * The bare form's referent is the inscription's ORIGINAL (undelegated)
 * content, matching `/r/undelegated-content/<id>`.
 *
 * Extensions defined by this project (SPEC-URI.md):
 *
 *     ord://<id>                    — tolerated alias; `//` is stripped
 *     ord:<id>/content              — content with delegation applied (as /content/<id>)
 *     ord:<id>/metadata             — CBOR metadata (tag 5)
 *     ...#integrity=sha256-<hex>    — expected sha256 of the (undelegated,
 *                                     still content-encoded) body bytes
 */

export type OrdPath = 'undelegated' | 'content' | 'metadata';

export interface ParsedOrdUri {
  id: InscriptionId;
  /** the inscription id as a normalized lowercase string */
  idString: string;
  path: OrdPath;
  integrity?: { algorithm: 'sha256'; digestHex: string };
  /** canonical serialization of this URI */
  canonical: string;
}

const B64_RE = /^[A-Za-z0-9+/_-]{43}=?$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

function decodeIntegrity(fragment: string): { algorithm: 'sha256'; digestHex: string } {
  const eq = fragment.indexOf('=');
  const value = fragment.slice(eq + 1);
  if (!value.startsWith('sha256-')) throw new Error(`unsupported integrity algorithm in "${fragment}"`);
  const digest = value.slice('sha256-'.length);
  if (HEX64_RE.test(digest)) return { algorithm: 'sha256', digestHex: digest.toLowerCase() };
  if (B64_RE.test(digest)) {
    // base64 / base64url (SRI style)
    const b64 = digest.replace(/-/g, '+').replace(/_/g, '/');
    const bin = typeof atob === 'function' ? atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')) : Buffer.from(b64, 'base64').toString('binary');
    if (bin.length !== 32) throw new Error('integrity digest must be 32 bytes');
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return { algorithm: 'sha256', digestHex: hex };
  }
  throw new Error('integrity digest must be 64 hex chars or base64 of 32 bytes');
}

/** Parse and normalize an ord URI (or a bare inscription id). */
export function parseOrdUri(input: string): ParsedOrdUri {
  let rest = input.trim();

  // fragment
  let integrity: ParsedOrdUri['integrity'];
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    const fragment = decodeURIComponent(rest.slice(hash + 1));
    rest = rest.slice(0, hash);
    if (fragment.startsWith('integrity=')) integrity = decodeIntegrity(fragment);
    else if (fragment.length > 0) throw new Error(`unknown ord URI fragment "${fragment}"`);
  }

  // scheme (bare inscription ids are accepted for ergonomics)
  const lower = rest.toLowerCase();
  if (lower.startsWith('ord://')) rest = rest.slice(6);
  else if (lower.startsWith('ord:')) rest = rest.slice(4);
  else if (!isInscriptionId(rest.split('/')[0] ?? '')) {
    throw new Error(`not an ord URI: ${input}`);
  }

  // path
  const segments = rest.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error('ord URI missing inscription id');
  const id = parseInscriptionId(segments[0]);
  let path: OrdPath = 'undelegated';
  if (segments.length === 2) {
    if (segments[1] === 'content') path = 'content';
    else if (segments[1] === 'metadata') path = 'metadata';
    else throw new Error(`unknown ord URI path "/${segments[1]}"`);
  } else if (segments.length > 2) {
    throw new Error(`ord URI has too many path segments: ${input}`);
  }

  const idString = `${id.txid}i${id.index}`;
  const canonical =
    `ord:${idString}` +
    (path === 'undelegated' ? '' : `/${path}`) +
    (integrity ? `#integrity=sha256-${integrity.digestHex}` : '');

  return { id, idString, path, integrity, canonical };
}

/** True when the string looks like any accepted ord URI form. */
export function isOrdUri(input: string): boolean {
  try {
    parseOrdUri(input);
    return true;
  } catch {
    return false;
  }
}
