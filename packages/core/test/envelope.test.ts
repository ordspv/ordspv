import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  inscriptionsFromTx,
  parseEnvelopesFromScript,
  parseInscriptionIdValue,
  splitPayload,
  interpretEnvelope,
  concatBytes,
  sha256,
  displayToInternal,
  type Inscription,
  type RawEnvelope,
} from '../src/index.js';
import {
  DUMMY_CONTROL_BLOCK,
  envelopeScript,
  ordEnvelope,
  revealTx,
  script,
  txWithWitnesses,
} from './helpers.js';

const interpret = (payload: Uint8Array[], flags: Partial<RawEnvelope> = {}) =>
  interpretEnvelope({ input: 0, offsetInInput: 0, index: 0, payload, pushnum: false, stutter: false, ...flags });

const te = new TextEncoder();

describe('envelope grammar (ord envelope.rs semantics)', () => {
  it('parses a plain text inscription', () => {
    const s = envelopeScript(
      { fields: [[1, 'text/plain;charset=utf-8']], body: ['Hello, world!'] },
      { checksigPrefix: true },
    );
    const tx = revealTx([{ script: s, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const [insc] = inscriptionsFromTx(tx);
    expect(insc.contentType).toBe('text/plain;charset=utf-8');
    expect(new TextDecoder().decode(insc.body)).toBe('Hello, world!');
    expect(insc.flags).toEqual({
      incompleteField: false,
      duplicateField: false,
      unrecognizedEvenField: false,
      pushnum: false,
      stutter: false,
    });
  });

  it('accepts pushnum opcodes as payload and flags them', () => {
    // tag via OP_1 (0x51): decodes to [1] = content_type
    const s = script(0x00, 0x63, 'ord', 0x51, 'text/plain', new Uint8Array(0), 'abc', 0x68);
    const envs = parseEnvelopesFromScript(s);
    expect(envs.length).toBe(1);
    expect(envs[0].pushnum).toBe(true);
    const insc = interpret(envs[0].payload, { pushnum: true });
    expect(insc.contentType).toBe('text/plain');
    expect(new TextDecoder().decode(insc.body)).toBe('abc');
    expect(insc.flags.pushnum).toBe(true);
  });

  it('discards envelopes containing disallowed opcodes', () => {
    const s = script(0x00, 0x63, 'ord', 0x76 /* OP_DUP */, 0x68);
    expect(parseEnvelopesFromScript(s).length).toBe(0);
  });

  it('discards envelopes missing OP_ENDIF', () => {
    const s = script(0x00, 0x63, 'ord', new Uint8Array([1]), 'text/plain');
    expect(parseEnvelopesFromScript(s).length).toBe(0);
  });

  it('treats an empty push in value position as a value, not the body separator', () => {
    // fields: (1, ""), then separator, then body "x"
    const payload = [new Uint8Array([1]), new Uint8Array(0), new Uint8Array(0), te.encode('x')];
    const { fields, bodyChunks, incompleteField } = splitPayload(payload);
    expect(fields.length).toBe(1);
    expect(fields[0][1].length).toBe(0);
    expect(bodyChunks?.length).toBe(1);
    expect(incompleteField).toBe(false);
    const insc = interpret(payload);
    expect(insc.contentType).toBe('');
    expect(new TextDecoder().decode(insc.body)).toBe('x');
  });

  it('flags incomplete fields (tag with no value)', () => {
    const payload = [new Uint8Array([1])];
    const insc = interpret(payload);
    expect(insc.flags.incompleteField).toBe(true);
    expect(insc.body).toBeUndefined();
  });

  it('concatenates chunked metadata and still flags duplicateField (ord parity)', () => {
    const payload = [
      new Uint8Array([5]),
      new Uint8Array([0xa1, 0x61]),
      new Uint8Array([5]),
      new Uint8Array([0x61, 0x61, 0x62]), // {"a":"b"} split across pushes
    ];
    const insc = interpret(payload);
    expect([...insc.metadata!]).toEqual([0xa1, 0x61, 0x61, 0x61, 0x62]);
    expect(insc.flags.duplicateField).toBe(true);
    expect(insc.flags.unrecognizedEvenField).toBe(false); // metadata (5) fully consumed
  });

  it('duplicate single-take even tag leaves a leftover -> unrecognized even -> unbound', () => {
    const payload = [
      new Uint8Array([2]),
      new Uint8Array([0x01]),
      new Uint8Array([2]),
      new Uint8Array([0x02]),
    ];
    const insc = interpret(payload);
    expect(insc.pointer).toBe(1n);
    expect(insc.flags.duplicateField).toBe(true);
    expect(insc.flags.unrecognizedEvenField).toBe(true);
    expect(insc.unboundByEvenField).toBe(true);
  });

  it('unknown even tag unbinds; unknown odd tag is ignored', () => {
    expect(interpret([new Uint8Array([22]), te.encode('x')]).unboundByEvenField).toBe(true);
    expect(interpret([new Uint8Array([21]), te.encode('x')]).unboundByEvenField).toBe(false);
  });

  it('collects repeated parents', () => {
    const txidA = sha256(te.encode('parentA'));
    const txidB = sha256(te.encode('parentB'));
    const payload = [
      new Uint8Array([3]),
      txidA,
      new Uint8Array([3]),
      concatBytes(txidB, new Uint8Array([1])),
    ];
    const insc = interpret(payload);
    expect(insc.parents.length).toBe(2);
    expect(insc.parents[1].endsWith('i1')).toBe(true);
    expect(insc.flags.duplicateField).toBe(true); // repeats always set it
    expect(insc.flags.unrecognizedEvenField).toBe(false); // parent (3) takes all
  });

  it('parses delegate and serves the id', () => {
    const txid = sha256(te.encode('delegate'));
    const insc = interpret([new Uint8Array([11]), txid]);
    expect(insc.delegate).toBe(`${Buffer.from(txid).reverse().toString('hex')}i0`);
  });

  it('rejects non-canonical inscription-id values (trailing zero index bytes)', () => {
    const txid = sha256(te.encode('x'));
    expect(parseInscriptionIdValue(concatBytes(txid, new Uint8Array([1, 0])))).toBeUndefined();
    expect(parseInscriptionIdValue(concatBytes(txid, new Uint8Array([0])))).toBeUndefined();
    expect(parseInscriptionIdValue(txid.slice(0, 31))).toBeUndefined();
    expect(parseInscriptionIdValue(concatBytes(txid, new Uint8Array([0, 1])))).toBe(
      `${Buffer.from(txid).reverse().toString('hex')}i256`,
    );
  });

  it('accepts the fixed-width 4-byte index encoding with trailing zeros (ord parity)', () => {
    // ord's InscriptionId::from_value rejects a trailing zero index byte only
    // when the index is NOT exactly 4 bytes; the fixed-width form is legal.
    const txid = sha256(te.encode('fixed-width'));
    const display = Buffer.from(txid).reverse().toString('hex');
    const fixed = (index: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, index, true);
      return concatBytes(txid, b);
    };
    expect(parseInscriptionIdValue(fixed(0))).toBe(`${display}i0`);
    expect(parseInscriptionIdValue(fixed(1))).toBe(`${display}i1`);
    expect(parseInscriptionIdValue(fixed(2))).toBe(`${display}i2`);
    expect(parseInscriptionIdValue(fixed(256))).toBe(`${display}i256`);
    // variable-width trailing zeros (1-3 index bytes) stay rejected
    expect(parseInscriptionIdValue(concatBytes(txid, new Uint8Array([0])))).toBeUndefined();
    expect(parseInscriptionIdValue(concatBytes(txid, new Uint8Array([1, 0])))).toBeUndefined();
    expect(parseInscriptionIdValue(concatBytes(txid, new Uint8Array([1, 0, 0])))).toBeUndefined();
    expect(parseInscriptionIdValue(concatBytes(txid, new Uint8Array([1, 2, 0])))).toBeUndefined();

    // the fixed-width form must round-trip through BOTH delegate and parent tags
    const viaDelegate = interpret([new Uint8Array([11]), fixed(1)]);
    expect(viaDelegate.delegate).toBe(`${display}i1`);
    const viaParent = interpret([new Uint8Array([3]), fixed(256)]);
    expect(viaParent.parents).toEqual([`${display}i256`]);
    // and through a full envelope parse from a reveal tx
    const s = envelopeScript({ fields: [[11, fixed(2)]] });
    const [insc] = inscriptionsFromTx(revealTx([{ script: s, controlBlock: DUMMY_CONTROL_BLOCK }]));
    expect(insc.delegate).toBe(`${display}i2`);
  });

  it('numbers multiple envelopes across scripts and inputs flatly', () => {
    const s1 = concatBytes(
      envelopeScript({ fields: [[1, 'text/plain']], body: ['first'] }),
      envelopeScript({ fields: [[1, 'text/plain']], body: ['second'] }),
    );
    const s2 = envelopeScript({ fields: [[1, 'text/plain']], body: ['third'] });
    const tx = revealTx([
      { script: s1, controlBlock: DUMMY_CONTROL_BLOCK },
      { script: s2, controlBlock: DUMMY_CONTROL_BLOCK },
    ]);
    const inscs = inscriptionsFromTx(tx);
    expect(inscs.map((i) => [i.index, i.input, new TextDecoder().decode(i.body)])).toEqual([
      [0, 0, 'first'],
      [1, 0, 'second'],
      [2, 1, 'third'],
    ]);
  });

  it('pointer decodes little-endian with zero-padding tolerance', () => {
    expect(interpret([new Uint8Array([2]), new Uint8Array([0x22, 0x02])]).pointer).toBe(546n);
    expect(
      interpret([new Uint8Array([2]), new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0])]).pointer,
    ).toBe(1n);
    expect(
      interpret([new Uint8Array([2]), new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 1])]).pointer,
    ).toBeUndefined();
  });

  it('parses properties (tag 17) as chunked', () => {
    const payload = [new Uint8Array([17]), new Uint8Array([0xa0])];
    const insc = interpret(payload);
    expect([...insc.properties!]).toEqual([0xa0]);
    expect(insc.unboundByEvenField).toBe(false); // 17 is odd
  });

  it('envelope with no fields and no body yields an empty inscription', () => {
    const s = script(0x00, 0x63, 'ord', 0x68);
    const tx = revealTx([{ script: s, controlBlock: DUMMY_CONTROL_BLOCK }]);
    const [insc] = inscriptionsFromTx(tx);
    expect(insc.contentType).toBeUndefined();
    expect(insc.body).toBeUndefined();
  });

  it('matches inscription id encoding against a known reversal', () => {
    const display = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799';
    const id = parseInscriptionIdValue(displayToInternal(display));
    expect(id).toBe(`${display}i0`);
  });
});

/**
 * Byte-level port of ord's envelope test corpus:
 * ordinals/ord @ 7effaaaf, src/inscriptions/envelope.rs `mod tests`.
 * One `it` per ord `#[test]`, same names, same script bytes (rust-bitcoin's
 * script::Builder emits minimal pushes, as our `script()` helper does), and
 * full-struct equality: every Inscription field is asserted against defaults
 * plus the listed overrides, mirroring ord's `assert_eq!` on ParsedEnvelope.
 */
describe('ord envelope.rs test corpus (@7effaaaf)', () => {
  const te = new TextEncoder();
  const EMPTY = new Uint8Array(0);
  /** single-byte tag push, as ord's Tag::bytes() */
  const t = (n: number) => Uint8Array.of(n);

  /** mirror of ord's test `parse(&[Witness...])`: one input per witness stack */
  const parse = (witnesses: Uint8Array[][]): Inscription[] =>
    inscriptionsFromTx(txWithWitnesses(witnesses));

  interface ExpectedInscription {
    /** ord's per-input offset; equals our global index in these single-lane cases */
    index?: number;
    input?: number;
    contentType?: string;
    /** omit = no body separator (ord body: None); '' / bytes = present */
    body?: Uint8Array | string;
    contentEncoding?: string;
    metaprotocol?: string;
    metadata?: Uint8Array;
    properties?: Uint8Array;
    propertyEncoding?: string;
    pointer?: bigint;
    parents?: string[];
    delegate?: string;
    rune?: Uint8Array;
    flags?: Partial<Inscription['flags']>;
  }

  const expectBytes = (actual: Uint8Array | undefined, expected: Uint8Array | undefined) => {
    if (expected === undefined) expect(actual).toBeUndefined();
    else expect(actual === undefined ? undefined : bytesToHex(actual)).toBe(bytesToHex(expected));
  };

  /** assert_eq!(parse(...), vec![...]): every field is checked, defaults included */
  function expectParsed(actual: Inscription[], expected: ExpectedInscription[]): void {
    expect(actual.length).toBe(expected.length);
    actual.forEach((insc, i) => {
      const exp = expected[i];
      expect(insc.index).toBe(exp.index ?? i);
      expect(insc.input).toBe(exp.input ?? 0);
      expect(insc.contentType).toBe(exp.contentType);
      expectBytes(insc.body, typeof exp.body === 'string' ? te.encode(exp.body) : exp.body);
      expect(insc.contentEncoding).toBe(exp.contentEncoding);
      expect(insc.metaprotocol).toBe(exp.metaprotocol);
      expectBytes(insc.metadata, exp.metadata);
      expectBytes(insc.properties, exp.properties);
      expect(insc.propertyEncoding).toBe(exp.propertyEncoding);
      expect(insc.pointer).toBe(exp.pointer);
      expect(insc.parents).toEqual(exp.parents ?? []);
      expect(insc.delegate).toBe(exp.delegate);
      expectBytes(insc.rune, exp.rune);
      expect(insc.flags).toEqual({
        incompleteField: false,
        duplicateField: false,
        unrecognizedEvenField: false,
        pushnum: false,
        stutter: false,
        ...exp.flags,
      });
      expect(insc.unboundByEvenField).toBe(insc.flags.unrecognizedEvenField);
    });
  }

  it('empty', () => {
    expectParsed(parse([[]]), []);
  });

  it('ignore_key_path_spends', () => {
    expectParsed(parse([[script(0x00, 0x63, 'ord', 0x68)]]), []);
  });

  it('ignore_key_path_spends_with_annex', () => {
    expectParsed(parse([[script(0x00, 0x63, 'ord', 0x68), Uint8Array.of(0x50)]]), []);
  });

  it('parse_from_tapscript', () => {
    expectParsed(parse([[script(0x00, 0x63, 'ord', 0x68), EMPTY]]), [{}]);
  });

  it('ignore_unparsable_scripts', () => {
    // a trailing truncated push poisons the WHOLE tapscript, valid envelope included
    const s = concatBytes(script(0x00, 0x63, 'ord', 0x68), Uint8Array.of(0x01));
    expectParsed(parse([[s, EMPTY]]), []);
  });

  it('no_inscription', () => {
    expectParsed(parse([[EMPTY /* empty script */, EMPTY]]), []);
  });

  it('duplicate_field', () => {
    expectParsed(parse([ordEnvelope('ord', t(255), EMPTY, t(255), EMPTY)]), [
      { flags: { duplicateField: true } },
    ]);
  });

  it('with_content_type', () => {
    expectParsed(parse([ordEnvelope('ord', t(1), 'text/plain;charset=utf-8', EMPTY, 'ord')]), [
      { contentType: 'text/plain;charset=utf-8', body: 'ord' },
    ]);
  });

  it('with_content_encoding', () => {
    expectParsed(
      parse([ordEnvelope('ord', t(1), 'text/plain;charset=utf-8', t(9), 'br', EMPTY, 'ord')]),
      [{ contentType: 'text/plain;charset=utf-8', contentEncoding: 'br', body: 'ord' }],
    );
  });

  it('with_unknown_tag', () => {
    expectParsed(
      parse([ordEnvelope('ord', t(1), 'text/plain;charset=utf-8', t(255), 'bar', EMPTY, 'ord')]),
      [{ contentType: 'text/plain;charset=utf-8', body: 'ord' }],
    );
  });

  it('no_body', () => {
    expectParsed(parse([ordEnvelope('ord', t(1), 'text/plain;charset=utf-8')]), [
      { contentType: 'text/plain;charset=utf-8' },
    ]);
  });

  it('no_content_type', () => {
    expectParsed(parse([ordEnvelope('ord', EMPTY, 'foo')]), [{ body: 'foo' }]);
  });

  it('valid_body_in_multiple_pushes', () => {
    expectParsed(
      parse([ordEnvelope('ord', t(1), 'text/plain;charset=utf-8', EMPTY, 'foo', 'bar')]),
      [{ contentType: 'text/plain;charset=utf-8', body: 'foobar' }],
    );
  });

  it('valid_body_in_zero_pushes', () => {
    // separator with zero chunks: body is PRESENT and empty, not absent
    expectParsed(parse([ordEnvelope('ord', t(1), 'text/plain;charset=utf-8', EMPTY)]), [
      { contentType: 'text/plain;charset=utf-8', body: '' },
    ]);
  });

  it('valid_body_in_multiple_empty_pushes', () => {
    expectParsed(
      parse([
        ordEnvelope('ord', t(1), 'text/plain;charset=utf-8', EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY),
      ]),
      [{ contentType: 'text/plain;charset=utf-8', body: '' }],
    );
  });

  it('valid_ignore_trailing', () => {
    expectParsed(
      parse([
        [script(0x00, 0x63, 'ord', t(1), 'text/plain;charset=utf-8', EMPTY, 'ord', 0x68, 0xac), EMPTY],
      ]),
      [{ contentType: 'text/plain;charset=utf-8', body: 'ord' }],
    );
  });

  it('valid_ignore_preceding', () => {
    expectParsed(
      parse([
        [script(0xac, 0x00, 0x63, 'ord', t(1), 'text/plain;charset=utf-8', EMPTY, 'ord', 0x68), EMPTY],
      ]),
      [{ contentType: 'text/plain;charset=utf-8', body: 'ord' }],
    );
  });

  it('multiple_inscriptions_in_a_single_witness', () => {
    const s = concatBytes(
      script(0x00, 0x63, 'ord', t(1), 'text/plain;charset=utf-8', EMPTY, 'foo', 0x68),
      script(0x00, 0x63, 'ord', t(1), 'text/plain;charset=utf-8', EMPTY, 'bar', 0x68),
    );
    expectParsed(parse([[s, EMPTY]]), [
      { contentType: 'text/plain;charset=utf-8', body: 'foo' },
      { index: 1, contentType: 'text/plain;charset=utf-8', body: 'bar' },
    ]);
  });

  it('invalid_utf8_does_not_render_inscription_invalid', () => {
    expectParsed(
      parse([ordEnvelope('ord', t(1), 'text/plain;charset=utf-8', EMPTY, Uint8Array.of(0b10000000))]),
      [{ contentType: 'text/plain;charset=utf-8', body: Uint8Array.of(0b10000000) }],
    );
  });

  it('no_endif', () => {
    expectParsed(parse([[script(0x00, 0x63, 'ord'), EMPTY]]), []);
  });

  it('no_op_false', () => {
    expectParsed(parse([[script(0x63, 'ord', 0x68), EMPTY]]), []);
  });

  it('empty_envelope', () => {
    expectParsed(parse([ordEnvelope()]), []);
  });

  it('wrong_protocol_identifier', () => {
    expectParsed(parse([ordEnvelope('foo')]), []);
  });

  it('extract_from_transaction', () => {
    expectParsed(parse([ordEnvelope('ord', t(1), 'text/plain;charset=utf-8', EMPTY, 'ord')]), [
      { contentType: 'text/plain;charset=utf-8', body: 'ord' },
    ]);
  });

  it('extract_from_second_input', () => {
    const body = new Uint8Array(1040).fill(1);
    // Inscription::to_witness chunks bodies at MAX_SCRIPT_ELEMENT_SIZE (520)
    const w = ordEnvelope('ord', t(1), 'foo', EMPTY, body.slice(0, 520), body.slice(520));
    expectParsed(parse([[], w]), [{ input: 1, contentType: 'foo', body }]);
  });

  it('extract_from_second_envelope', () => {
    const body = new Uint8Array(100).fill(1);
    const s = concatBytes(
      script(0x00, 0x63, 'ord', t(1), 'foo', EMPTY, body, 0x68),
      script(0x00, 0x63, 'ord', t(1), 'bar', EMPTY, body, 0x68),
    );
    expectParsed(parse([[s, EMPTY]]), [
      { contentType: 'foo', body },
      { index: 1, contentType: 'bar', body },
    ]);
  });

  it('inscribe_png', () => {
    const body = new Uint8Array(100).fill(1);
    expectParsed(parse([ordEnvelope('ord', t(1), 'image/png', EMPTY, body)]), [
      { contentType: 'image/png', body },
    ]);
  });

  it('chunked_data_is_parsable', () => {
    const body = new Uint8Array(1040).fill(1);
    const w = ordEnvelope('ord', t(1), 'foo', EMPTY, body.slice(0, 520), body.slice(520));
    expectParsed(parse([w]), [{ contentType: 'foo', body }]);
  });

  it('round_trip_with_no_fields', () => {
    expectParsed(parse([ordEnvelope('ord')]), [{}]);
  });

  it('unknown_odd_fields_are_ignored', () => {
    expectParsed(parse([ordEnvelope('ord', t(255), Uint8Array.of(0))]), [{}]);
  });

  it('unknown_even_fields', () => {
    expectParsed(parse([ordEnvelope('ord', t(22), Uint8Array.of(0))]), [
      { flags: { unrecognizedEvenField: true } },
    ]);
  });

  it('pointer_field_is_recognized', () => {
    expectParsed(parse([ordEnvelope('ord', t(2), Uint8Array.of(1))]), [{ pointer: 1n }]);
  });

  it('duplicate_pointer_field_makes_inscription_unbound', () => {
    expectParsed(parse([ordEnvelope('ord', t(2), Uint8Array.of(1), t(2), Uint8Array.of(0))]), [
      { pointer: 1n, flags: { duplicateField: true, unrecognizedEvenField: true } },
    ]);
  });

  it('tag_66_makes_inscriptions_unbound', () => {
    expectParsed(parse([ordEnvelope('ord', t(66), Uint8Array.of(1))]), [
      { flags: { unrecognizedEvenField: true } },
    ]);
  });

  it('incomplete_field', () => {
    expectParsed(parse([ordEnvelope('ord', t(99))]), [{ flags: { incompleteField: true } }]);
  });

  it('metadata_is_parsed_correctly', () => {
    expectParsed(parse([ordEnvelope('ord', t(5), EMPTY)]), [{ metadata: EMPTY }]);
  });

  it('metadata_is_parsed_correctly_from_chunks', () => {
    expectParsed(parse([ordEnvelope('ord', t(5), Uint8Array.of(0), t(5), Uint8Array.of(1))]), [
      { metadata: Uint8Array.of(0, 1), flags: { duplicateField: true } },
    ]);
  });

  it('properties_are_parsed_correctly', () => {
    expectParsed(parse([ordEnvelope('ord', t(17), Uint8Array.of(1, 2, 3))]), [
      { properties: Uint8Array.of(1, 2, 3) },
    ]);
  });

  it('properties_are_parsed_correctly_from_chunks', () => {
    expectParsed(parse([ordEnvelope('ord', t(17), Uint8Array.of(0), t(17), Uint8Array.of(1))]), [
      { properties: Uint8Array.of(0, 1), flags: { duplicateField: true } },
    ]);
  });

  it('pushnum_opcodes_are_parsed_correctly', () => {
    const PUSHNUMS: [number, number][] = [
      [0x4f, 0x81], // OP_PUSHNUM_NEG1
      ...Array.from({ length: 16 }, (_, k) => [0x51 + k, k + 1] as [number, number]),
    ];
    for (const [opcode, value] of PUSHNUMS) {
      expectParsed(parse([[script(0x00, 0x63, 'ord', 0x00, opcode, 0x68), EMPTY]]), [
        { body: Uint8Array.of(value), flags: { pushnum: true } },
      ]);
    }
  });

  it('stuttering', () => {
    // OP_FALSE OP_FALSE OP_IF "ord" OP_ENDIF
    expectParsed(parse([[script(0x00, 0x00, 0x63, 'ord', 0x68), EMPTY]]), [
      { flags: { stutter: true } },
    ]);
    // OP_FALSE OP_IF OP_FALSE OP_IF "ord" OP_ENDIF
    expectParsed(parse([[script(0x00, 0x63, 0x00, 0x63, 'ord', 0x68), EMPTY]]), [
      { flags: { stutter: true } },
    ]);
    // OP_FALSE OP_IF OP_FALSE OP_IF OP_FALSE OP_IF "ord" OP_ENDIF
    expectParsed(parse([[script(0x00, 0x63, 0x00, 0x63, 0x00, 0x63, 'ord', 0x68), EMPTY]]), [
      { flags: { stutter: true } },
    ]);
    // OP_FALSE OP_FALSE OP_AND OP_FALSE OP_IF "ord" OP_ENDIF: the failed
    // attempt at the second OP_FALSE stops at OP_AND (not an empty push),
    // ASSIGNING stuttered=false; the envelope is not marked
    expectParsed(parse([[script(0x00, 0x00, 0x84, 0x00, 0x63, 'ord', 0x68), EMPTY]]), [
      { flags: { stutter: false } },
    ]);
  });
});

/**
 * Consume-semantics parity locks derived from ord's implementation
 * (RawEnvelope::from_tapscript / from_instructions @ 7effaaaf) rather than its
 * test corpus. These are the behaviors the corpus does not pin down, where a
 * rescanning parser would diverge from ord.
 */
describe('ord from_tapscript consume semantics (beyond the corpus)', () => {
  it('does not re-scan instructions consumed by a failed envelope attempt', () => {
    // OP_FALSE OP_IF "ord" OP_FALSE OP_IF "ord" OP_ENDIF OP_DUP: the first
    // attempt consumes the inner OP_FALSE as payload and dies on the inner
    // OP_IF; ord never revisits the consumed empty push, so NO envelope
    // exists here (a rescanning parser would find one).
    const s = script(0x00, 0x63, 'ord', 0x00, 0x63, 'ord', 0x68, 0x76);
    expect(parseEnvelopesFromScript(s).length).toBe(0);
  });

  it('resumes at the instruction that failed an accept probe (peek, not consume)', () => {
    // the "x" push fails the "ord" accept probe unconsumed; the scan
    // re-examines it (not an empty push) and the next envelope parses clean
    const s = script(0x00, 0x63, 'x', 0x00, 0x63, 'ord', 0x68);
    const envs = parseEnvelopesFromScript(s);
    expect(envs.length).toBe(1);
    expect(envs[0].stutter).toBe(false);
  });

  it('payload-stage failure reports stutter=false even when the next instruction is an empty push', () => {
    // OP_FALSE OP_IF "ord" OP_DUP then a valid envelope: ord's payload loop
    // returns (false, None) unconditionally, so the following envelope is
    // NOT marked stuttered despite starting right after a failure
    const s = script(0x00, 0x63, 'ord', 0x76, 0x00, 0x63, 'ord', 0x68);
    const envs = parseEnvelopesFromScript(s);
    expect(envs.length).toBe(1);
    expect(envs[0].stutter).toBe(false);
  });

  it('stutter persists across an intervening successful envelope', () => {
    // ord assigns `stuttered` only in from_tapscript's failure branch; a
    // successful envelope does not clear it, so BOTH envelopes report
    // stutter=true here
    const s = script(0x00, 0x00, 0x63, 'ord', 0x68, 0x00, 0x63, 'ord', 0x68);
    const envs = parseEnvelopesFromScript(s);
    expect(envs.map((e) => e.stutter)).toEqual([true, true]);
  });

  it('a script error discards the whole tapscript but not other inputs', () => {
    const good = script(0x00, 0x63, 'ord', Uint8Array.of(1), 'text/plain', new Uint8Array(0), 'ok', 0x68);
    const bad = concatBytes(good, Uint8Array.of(0x4c)); // OP_PUSHDATA1 with no length byte
    const inscs = inscriptionsFromTx(
      txWithWitnesses([
        [bad, new Uint8Array(0)],
        [good, new Uint8Array(0)],
      ]),
    );
    expect(inscs.length).toBe(1);
    expect(inscs[0].input).toBe(1);
    expect(inscs[0].index).toBe(0);
    expect(new TextDecoder().decode(inscs[0].body)).toBe('ok');
  });
});
