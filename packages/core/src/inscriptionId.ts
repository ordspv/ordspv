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

/** widest envelope index an inscription id may carry */
const MAX_INDEX = 0xffffffff;

/**
 * Why a normalized string is not an inscription id, or `undefined` when it is
 * one. `'shape'` fails the grammar; `'range'` has the grammar and an index the
 * id format cannot carry.
 *
 * Every caller in this repository decides validity here, so the predicate and
 * the parser cannot answer differently. They did once: the predicate applied
 * `ID_RE` alone while the parser also bounded the index, so an id one past
 * `MAX_INDEX` passed the gate and threw in the work behind it.
 */
type IdRejection = 'shape' | 'range';

function rejectionFor(normalized: string): IdRejection | undefined {
  if (!ID_RE.test(normalized)) return 'shape';
  const index = Number(normalized.slice(65));
  if (!Number.isSafeInteger(index) || index > MAX_INDEX) return 'range';
  return undefined;
}

function messageFor(rejection: IdRejection, normalized: string, original: string): string {
  if (rejection === 'shape') return `invalid inscription id: ${original}`;
  return `inscription index out of range: ${Number(normalized.slice(65))}`;
}

/**
 * Parse an inscription ID: `<txid>i<index>`, txid in display order.
 * Uppercase hex is normalized to lowercase before validation so IDs surviving
 * URI authority case-folding still parse.
 */
export function parseInscriptionId(id: string): InscriptionId {
  const normalized = id.toLowerCase();
  const rejection = rejectionFor(normalized);
  if (rejection) throw new Error(messageFor(rejection, normalized, id));
  const txid = normalized.slice(0, 64);
  const index = Number(normalized.slice(65));
  return { txid, txidLE: displayToInternal(txid), index };
}

export function formatInscriptionId(txid: string, index: number): string {
  return `${txid.toLowerCase()}i${index}`;
}

/**
 * True for exactly the strings `parseInscriptionId` accepts. A caller gating on
 * this predicate and then parsing cannot be handed a parse failure.
 */
export function isInscriptionId(s: string): boolean {
  return rejectionFor(s.toLowerCase()) === undefined;
}

/**
 * The reason `s` is not an inscription id, in the words `parseInscriptionId`
 * would throw, or `undefined` when it is one. A server gating a request on the
 * id can put this in its 400 body instead of naming the input alone.
 */
export function inscriptionIdError(s: string): string | undefined {
  const normalized = s.toLowerCase();
  const rejection = rejectionFor(normalized);
  return rejection === undefined ? undefined : messageFor(rejection, normalized, s);
}

/**
 * True when `s` has the grammar of an inscription id, whatever index it names.
 * This is a scheme detector for callers deciding which syntax they are looking
 * at, and never a validity gate: `isInscriptionId` is the gate. An out-of-range
 * index has the shape, so a caller that detects with this and then parses
 * reports the range as the reason rather than reporting the wrong syntax.
 */
export function hasInscriptionIdShape(s: string): boolean {
  return ID_RE.test(s.toLowerCase());
}
