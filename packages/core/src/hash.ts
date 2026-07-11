import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from './bytes.js';

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/** Bitcoin double-SHA256. */
export function sha256d(data: Uint8Array): Uint8Array {
  return nobleSha256(nobleSha256(data));
}

/** BIP-340/341 tagged hash: sha256(sha256(tag) || sha256(tag) || ...msgs) */
export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const tagHash = nobleSha256(new TextEncoder().encode(tag));
  return nobleSha256(concatBytes(tagHash, tagHash, ...msgs));
}
