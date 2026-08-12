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
 * Bind a bundle's own claim to what the caller asked for, for every verifier
 * that reads a bundle. A bundle of any kind names the inscription it proves,
 * and each verifier's remaining checks read that claim rather than testing it,
 * so a verification that is given no expectation establishes that the document
 * is internally consistent and establishes nothing about whose inscription it
 * is. Callers pass what they asked for through `expectedInscriptionId`, and
 * each verifier calls this before any of the bundle's evidence is read, so a
 * bundle for another inscription is refused as the wrong document rather than
 * reported through whichever later check its contents happen to fail.
 *
 * `id` is the parsed form of `claimed`, so the comparison survives case
 * folding on either side. Leaving `expected` undefined is a no-op.
 */
export function checkExpectedInscriptionId(
  id: InscriptionId,
  expected: string | undefined,
  claimed: string,
): void {
  if (expected === undefined) return;
  let wanted: InscriptionId;
  try {
    wanted = parseInscriptionId(expected);
  } catch (e) {
    // the caller's own argument, so it names itself rather than reading as a
    // defect in the document under verification
    throw new Error(`expectedInscriptionId: ${(e as Error).message}`);
  }
  if (wanted.txid !== id.txid || wanted.index !== id.index) {
    throw new Error(
      `bundle proves ${claimed.toLowerCase()}, caller asked for ${formatInscriptionId(wanted.txid, wanted.index)}`,
    );
  }
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
