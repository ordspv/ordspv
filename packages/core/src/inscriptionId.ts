import { displayToInternal } from './bytes.js';

export interface InscriptionId {
  /** display-order txid hex, lowercase */
  txid: string;
  /** internal byte order */
  txidLE: Uint8Array;
  /** envelope index within the reveal transaction */
  index: number;
}

const ID_RE = /^[0-9a-f]{64}i(0|[1-9][0-9]*)$/;

/**
 * Parse an inscription ID: `<txid>i<index>`, txid in display order.
 * Uppercase hex is normalized to lowercase before validation so IDs surviving
 * URI authority case-folding still parse.
 */
export function parseInscriptionId(id: string): InscriptionId {
  const normalized = id.toLowerCase();
  if (!ID_RE.test(normalized)) throw new Error(`invalid inscription id: ${id}`);
  const txid = normalized.slice(0, 64);
  const index = Number(normalized.slice(65));
  if (!Number.isSafeInteger(index) || index > 0xffffffff) {
    throw new Error(`inscription index out of range: ${index}`);
  }
  return { txid, txidLE: displayToInternal(txid), index };
}

export function formatInscriptionId(txid: string, index: number): string {
  return `${txid.toLowerCase()}i${index}`;
}

export function isInscriptionId(s: string): boolean {
  return ID_RE.test(s.toLowerCase());
}
