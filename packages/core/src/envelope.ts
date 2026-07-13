import { bytesToHex, concatBytes, internalToDisplay } from './bytes.js';
import { formatInscriptionId } from './inscriptionId.js';
import { OP_ENDIF, OP_IF, OP_1NEGATE, OP_1, OP_16, parseScript, type ScriptOp } from './script.js';
import { extractTapscript } from './taproot.js';
import type { ParsedTx } from './tx.js';

/**
 * Ordinals inscription envelope parsing, mirroring ord's envelope.rs
 * (verified against ordinals/ord master @ 7effaaaf, 2026-06-25):
 *
 *   <empty push> OP_IF <push "ord"> <payload pushes...> OP_ENDIF
 *
 * Payload rules:
 * - Data pushes (any encoding) are payload items. OP_PUSHNUM_NEG1/OP_PUSHNUM_1..16
 *   are ACCEPTED, decoded to [0x81] / [1]..[16], and set the `pushnum` flag.
 * - Any other opcode, or script end before OP_ENDIF, discards the envelope,
 *   and everything the failed attempt consumed stays consumed (see
 *   parseEnvelopesFromScript for the scan/stutter rules).
 * - Fields are (tag, value) pairs consumed from the payload; the body starts at
 *   the first EVEN-INDEXED empty push (an empty push in value position is a
 *   legal empty value). Body = concatenation of every payload item after the
 *   separator. An odd field count sets `incompleteField`.
 * - `duplicateField` = any tag byte-string appearing more than once (computed
 *   over the raw field list, so chunked metadata also sets it, matching ord).
 * - Interpretation ("take") semantics: parent (3) keeps all values;
 *   metadata (5) and properties (17) concatenate all values; every other
 *   recognized tag takes its FIRST value only. After taking, any leftover
 *   field key whose first byte is even sets `unrecognizedEvenField`
 *   (=> unbound in ord).
 *
 * Envelope index (the `iN` of inscription IDs) counts every successfully
 * parsed envelope, cursed or not, in witness order across all inputs.
 *
 * Tag table (ord tag.rs): 1 content_type, 2 pointer, 3 parent, 5 metadata,
 * 7 metaprotocol, 9 content_encoding, 11 delegate, 13 rune, 15 note (no-op),
 * 17 properties, 19 property_encoding, 66 unbound, 255 nop.
 */

export const TAG_CONTENT_TYPE = 1;
export const TAG_POINTER = 2;
export const TAG_PARENT = 3;
export const TAG_METADATA = 5;
export const TAG_METAPROTOCOL = 7;
export const TAG_CONTENT_ENCODING = 9;
export const TAG_DELEGATE = 11;
export const TAG_RUNE = 13;
export const TAG_NOTE = 15;
export const TAG_PROPERTIES = 17;
export const TAG_PROPERTY_ENCODING = 19;
export const TAG_UNBOUND = 66;
export const TAG_NOP = 255;

export interface RawEnvelope {
  /** input index this envelope came from */
  input: number;
  /** envelope's ordinal within its input's tapscript */
  offsetInInput: number;
  /** global envelope index across the tx (the `iN` of the inscription ID) */
  index: number;
  /** payload pushes in order (pushnums decoded to their byte forms) */
  payload: Uint8Array[];
  /** true if any payload item came from a pushnum opcode */
  pushnum: boolean;
  /** true if a failed envelope attempt immediately preceded this one at an empty push */
  stutter: boolean;
}

export interface EnvelopeFields {
  /** (tag, value) pairs in payload order */
  fields: [Uint8Array, Uint8Array][];
  /** body chunk list; undefined when no body separator was present */
  bodyChunks?: Uint8Array[];
  incompleteField: boolean;
  duplicateField: boolean;
}

export interface Inscription {
  /** global envelope index in the reveal tx */
  index: number;
  input: number;
  contentType?: string;
  contentTypeBytes?: Uint8Array;
  /** concatenated body bytes; undefined when no body separator was present */
  body?: Uint8Array;
  contentEncoding?: string;
  metaprotocol?: string;
  /** raw CBOR bytes (chunks concatenated, undecoded) */
  metadata?: Uint8Array;
  /** raw properties bytes (tag 17, chunks concatenated) */
  properties?: Uint8Array;
  propertyEncoding?: string;
  pointer?: bigint;
  parents: string[];
  delegate?: string;
  rune?: Uint8Array;
  flags: {
    incompleteField: boolean;
    duplicateField: boolean;
    unrecognizedEvenField: boolean;
    pushnum: boolean;
    stutter: boolean;
  };
  /** ord unbound condition from envelope data alone (unrecognized even field) */
  unboundByEvenField: boolean;
}

const ORD_MARKER = new Uint8Array([0x6f, 0x72, 0x64]); // "ord"

function isEmptyPush(op: ScriptOp): boolean {
  return op.data !== undefined && op.data.length === 0;
}

function isOrdMarker(op: ScriptOp): boolean {
  return (
    op.data !== undefined &&
    op.data.length === 3 &&
    op.data[0] === ORD_MARKER[0] &&
    op.data[1] === ORD_MARKER[1] &&
    op.data[2] === ORD_MARKER[2]
  );
}

/** Decode an op inside an envelope to payload bytes, or undefined if not allowed. */
function payloadBytes(op: ScriptOp): { bytes: Uint8Array; pushnum: boolean } | undefined {
  if (op.data !== undefined) return { bytes: op.data, pushnum: false };
  if (op.opcode === OP_1NEGATE) return { bytes: new Uint8Array([0x81]), pushnum: true };
  if (op.opcode >= OP_1 && op.opcode <= OP_16) {
    return { bytes: new Uint8Array([op.opcode - OP_1 + 1]), pushnum: true };
  }
  return undefined;
}

/** Instruction::Op(opcode) equality; a data push never equals an opcode. */
function isOp(op: ScriptOp | undefined, opcode: number): boolean {
  return op !== undefined && op.data === undefined && op.opcode === opcode;
}

interface Attempt {
  /** cursor position after the attempt; consumed instructions are never re-scanned */
  cursor: number;
  /** ord's returned stutter value (meaningful only when no envelope was produced) */
  stutter: boolean;
  envelope?: Omit<RawEnvelope, 'input' | 'index' | 'offsetInInput'>;
}

/**
 * Port of ord's RawEnvelope::from_instructions (envelope.rs @ 7effaaaf).
 * Called with the cursor just past an empty push. The two `accept` probes
 * (OP_IF, then the "ord" marker) peek without consuming, so on mismatch the
 * probed instruction is left for the outer scan to re-examine, and stutter
 * reports whether that instruction is an empty push. Once inside the payload
 * loop every instruction is consumed, and failures (disallowed opcode, script
 * end before OP_ENDIF) return stutter=false.
 */
function fromInstructions(ops: ScriptOp[], cursor: number, stutter: boolean): Attempt {
  if (!isOp(ops[cursor], OP_IF)) {
    return { cursor, stutter: ops[cursor] !== undefined && isEmptyPush(ops[cursor]) };
  }
  cursor++;
  if (ops[cursor] === undefined || !isOrdMarker(ops[cursor])) {
    return { cursor, stutter: ops[cursor] !== undefined && isEmptyPush(ops[cursor]) };
  }
  cursor++;
  const payload: Uint8Array[] = [];
  let pushnum = false;
  for (;;) {
    const op = ops[cursor];
    if (op === undefined) return { cursor, stutter: false }; // script end before OP_ENDIF
    cursor++;
    if (isOp(op, OP_ENDIF)) {
      return { cursor, stutter: false, envelope: { payload, pushnum, stutter } };
    }
    const decoded = payloadBytes(op);
    if (!decoded) return { cursor, stutter: false }; // disallowed opcode
    payload.push(decoded.bytes);
    pushnum ||= decoded.pushnum;
  }
}

/**
 * Parse all envelopes out of one tapscript: an instruction-for-instruction
 * port of ord's RawEnvelope::from_tapscript (envelope.rs @ 7effaaaf):
 *
 * - A single forward cursor plays the role of ord's shared Instructions
 *   iterator. A failed attempt never rewinds: instructions it consumed
 *   (including empty pushes inside a failed payload) are skipped by the outer
 *   scan, not re-considered as envelope starts.
 * - `stuttered` is ASSIGNED (not or-ed) after every failed attempt (a later
 *   failure at a non-empty-push instruction clears it) and is NOT reset when
 *   an envelope succeeds; ord only writes it in the failure branch.
 * - Any script parse error (truncated push) discards the entire tapscript,
 *   envelopes already parsed included (ord: from_tapscript returns Err, and
 *   from_transaction drops the input's envelopes).
 */
export function parseEnvelopesFromScript(
  script: Uint8Array,
): Omit<RawEnvelope, 'input' | 'index' | 'offsetInInput'>[] {
  let ops: ScriptOp[];
  try {
    ops = parseScript(script);
  } catch {
    return [];
  }
  const envelopes: Omit<RawEnvelope, 'input' | 'index' | 'offsetInInput'>[] = [];
  let stuttered = false;
  let cursor = 0;
  while (cursor < ops.length) {
    const instruction = ops[cursor++];
    if (!isEmptyPush(instruction)) continue;
    const attempt = fromInstructions(ops, cursor, stuttered);
    cursor = attempt.cursor;
    if (attempt.envelope) {
      envelopes.push(attempt.envelope);
    } else {
      stuttered = attempt.stutter;
    }
  }
  return envelopes;
}

/** Parse every envelope in a reveal transaction, in inscription-ID order. */
export function parseEnvelopesFromTx(tx: ParsedTx): RawEnvelope[] {
  const out: RawEnvelope[] = [];
  let index = 0;
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const tapscript = extractTapscript(tx.inputs[vin].witness);
    if (!tapscript) continue;
    let offsetInInput = 0;
    for (const env of parseEnvelopesFromScript(tapscript.script)) {
      out.push({ ...env, input: vin, offsetInInput: offsetInInput++, index: index++ });
    }
  }
  return out;
}

/** Split an envelope payload into fields and body chunks per ord rules. */
export function splitPayload(payload: Uint8Array[]): EnvelopeFields {
  const fields: [Uint8Array, Uint8Array][] = [];
  let bodyChunks: Uint8Array[] | undefined;
  let incompleteField = false;
  for (let i = 0; i < payload.length; i += 2) {
    const tag = payload[i];
    if (tag.length === 0) {
      // even-indexed empty push: body separator
      bodyChunks = payload.slice(i + 1);
      break;
    }
    const value = payload[i + 1];
    if (value === undefined) {
      incompleteField = true;
      break;
    }
    fields.push([tag, value]);
  }
  const seen = new Set<string>();
  let duplicateField = false;
  for (const [tag] of fields) {
    const key = bytesToHex(tag);
    if (seen.has(key)) duplicateField = true;
    seen.add(key);
  }
  return { fields, bodyChunks, incompleteField, duplicateField };
}

/**
 * Decode an inscription-ID field value: 32-byte txid (internal order) plus up
 * to 4 little-endian index bytes. Mirrors ord's InscriptionId::from_value
 * (inscription.rs @ 7effaaaf): a trailing zero index byte is rejected ONLY for
 * variable-width encodings (1-3 index bytes); the fixed-width 4-byte form is
 * accepted with trailing zeros (so 32+4 bytes with a 0x00 high byte is valid).
 */
export function parseInscriptionIdValue(value: Uint8Array): string | undefined {
  if (value.length < 32 || value.length > 36) return undefined;
  const indexLen = value.length - 32;
  if (indexLen !== 0 && indexLen !== 4 && value[value.length - 1] === 0) return undefined;
  const txidLE = value.slice(0, 32);
  let index = 0;
  for (let i = value.length - 1; i >= 32; i--) {
    index = index * 256 + value[i];
  }
  return formatInscriptionId(internalToDisplay(txidLE), index);
}

function decodeLeU64Trimmed(value: Uint8Array): bigint | undefined {
  // ord pointers: LE u64; bytes beyond offset 8 must be zero, else invalid
  for (let i = 8; i < value.length; i++) {
    if (value[i] !== 0) return undefined;
  }
  let v = 0n;
  const len = Math.min(value.length, 8);
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(value[i]);
  return v;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** Interpret a raw envelope into an Inscription per ord "take" semantics. */
export function interpretEnvelope(env: RawEnvelope): Inscription {
  const { fields, bodyChunks, incompleteField, duplicateField } = splitPayload(env.payload);

  // group values by exact tag byte-string, preserving order
  const byKey = new Map<string, { tag: Uint8Array; values: Uint8Array[] }>();
  for (const [tag, value] of fields) {
    const key = bytesToHex(tag);
    const entry = byKey.get(key) ?? { tag, values: [] };
    entry.values.push(value);
    byKey.set(key, entry);
  }

  const keyOf = (tag: number) => bytesToHex(new Uint8Array([tag]));

  /** take first value, leaving the rest (leftovers stay in the map) */
  const takeFirst = (tag: number): Uint8Array | undefined => {
    const entry = byKey.get(keyOf(tag));
    if (!entry || entry.values.length === 0) return undefined;
    const [first, ...rest] = entry.values;
    if (rest.length === 0) byKey.delete(keyOf(tag));
    else byKey.set(keyOf(tag), { tag: entry.tag, values: rest });
    return first;
  };
  /** take and concatenate all values */
  const takeChunked = (tag: number): Uint8Array | undefined => {
    const entry = byKey.get(keyOf(tag));
    if (!entry) return undefined;
    byKey.delete(keyOf(tag));
    return concatBytes(...entry.values);
  };
  /** take all values as an array */
  const takeArray = (tag: number): Uint8Array[] => {
    const entry = byKey.get(keyOf(tag));
    if (!entry) return [];
    byKey.delete(keyOf(tag));
    return entry.values;
  };

  const contentTypeBytes = takeFirst(TAG_CONTENT_TYPE);
  const pointerRaw = takeFirst(TAG_POINTER);
  const parentValues = takeArray(TAG_PARENT);
  const metadata = takeChunked(TAG_METADATA);
  const metaprotocolRaw = takeFirst(TAG_METAPROTOCOL);
  const contentEncodingRaw = takeFirst(TAG_CONTENT_ENCODING);
  const delegateRaw = takeFirst(TAG_DELEGATE);
  const rune = takeFirst(TAG_RUNE);
  const properties = takeChunked(TAG_PROPERTIES);
  const propertyEncodingRaw = takeFirst(TAG_PROPERTY_ENCODING);

  // leftover keys (unrecognized tags + surplus values of single-take tags):
  // first byte even => unrecognized even field => unbound
  let unrecognizedEvenField = false;
  for (const { tag } of byKey.values()) {
    if (tag.length > 0 && (tag[0] & 1) === 0) unrecognizedEvenField = true;
  }

  const parents: string[] = [];
  for (const value of parentValues) {
    const id = parseInscriptionIdValue(value);
    if (id) parents.push(id);
  }

  const pointer = pointerRaw ? decodeLeU64Trimmed(pointerRaw) : undefined;

  return {
    index: env.index,
    input: env.input,
    contentType: contentTypeBytes ? utf8.decode(contentTypeBytes) : undefined,
    contentTypeBytes,
    body: bodyChunks ? concatBytes(...bodyChunks) : undefined,
    contentEncoding: contentEncodingRaw ? utf8.decode(contentEncodingRaw) : undefined,
    metaprotocol: metaprotocolRaw ? utf8.decode(metaprotocolRaw) : undefined,
    metadata,
    properties,
    propertyEncoding: propertyEncodingRaw ? utf8.decode(propertyEncodingRaw) : undefined,
    pointer,
    parents,
    delegate: delegateRaw ? parseInscriptionIdValue(delegateRaw) : undefined,
    rune,
    flags: {
      incompleteField,
      duplicateField,
      unrecognizedEvenField,
      pushnum: env.pushnum,
      stutter: env.stutter,
    },
    unboundByEvenField: unrecognizedEvenField,
  };
}

/** Convenience: all inscriptions in a reveal tx, indexed as ord would ID them. */
export function inscriptionsFromTx(tx: ParsedTx): Inscription[] {
  return parseEnvelopesFromTx(tx).map(interpretEnvelope);
}
