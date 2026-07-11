import { describe, expect, it } from 'vitest';
import {
  inscriptionsFromTx,
  parseEnvelopesFromScript,
  parseInscriptionIdValue,
  splitPayload,
  interpretEnvelope,
  concatBytes,
  sha256,
  displayToInternal,
  type RawEnvelope,
} from '../src/index.js';
import { DUMMY_CONTROL_BLOCK, envelopeScript, revealTx, script } from './helpers.js';

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
