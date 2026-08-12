import { describe, expect, it } from 'vitest';
import { concatBytes, decodeCbor, decodeCborJson } from '../src/index.js';

/**
 * The decoder builds its maps from attacker-supplied bytes, so a `__proto__`
 * key must land as a data property rather than reaching the
 * `Object.prototype.__proto__` setter. There are two allocation sites and they
 * only work together: `decodeCbor`'s map case and `decodeCborJson`'s walk. A
 * null prototype on the first one alone turns the key into a real own property
 * and hands it straight to the second one's plain literal, which is where the
 * setter fires. The walk test below passes on a tree with neither fix and on a
 * tree with both, and fails on a tree with only the first.
 */

// ---------------------------------------------------------------------------
// minimal CBOR encoder, test-local: uint, tstr, map with text keys
// ---------------------------------------------------------------------------

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n <= 0xff) return new Uint8Array([(major << 5) | 24, n]);
  return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
}

const cbUint = (n: number) => head(0, n);
const cbTrue = () => new Uint8Array([0xf5]);
const cbText = (s: string) => {
  const b = new TextEncoder().encode(s);
  return concatBytes(head(3, b.length), b);
};
const cbTextMap = (pairs: [string, Uint8Array][]) =>
  concatBytes(head(5, pairs.length), ...pairs.flatMap(([k, v]) => [cbText(k), v]));

/** the decoded value as a map, for tests that have already asserted the shape */
function asMap(v: unknown): Record<string, unknown> {
  expect(typeof v).toBe('object');
  expect(v).not.toBeNull();
  return v as Record<string, unknown>;
}

const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);
const protoReplaced = (v: object) => {
  const proto = Object.getPrototypeOf(v);
  return proto !== Object.prototype && proto !== null;
};

describe('CBOR decoding of a __proto__ key', () => {
  // 0x69 declares the nine bytes "__proto__" and 0x68 the eight bytes
  // "polluted". A length one byte long in either header eats the following
  // item and the decoder runs off the end, which is what a hand-written
  // fixture gets wrong
  const KEY = cbText('__proto__');
  const VALUE = cbTextMap([['polluted', cbTrue()]]);

  it('encodes the fixture headers the byte counts require', () => {
    expect(KEY[0]).toBe(0x69);
    expect(VALUE[1]).toBe(0x68);
  });

  it('a ten-byte length over the nine-byte key runs off the end', () => {
    // major type 3 info 10 declares one byte more than the key carries, so the
    // value's first byte is consumed as the tenth character and nothing is
    // left to decode
    const truncated = new Uint8Array([0xa1, 0x6a, ...new TextEncoder().encode('__proto__'), 0x01]);
    expect(() => decodeCbor(truncated)).toThrow(/unexpected end/);
  });

  it('keeps a map value as an own data property and replaces no prototype', () => {
    const decoded = asMap(decodeCbor(cbTextMap([['__proto__', VALUE], ['real', cbText('data')]])));
    expect(own(decoded, '__proto__')).toBe(true);
    expect(protoReplaced(decoded)).toBe(false);
    expect(asMap(decoded['__proto__']).polluted).toBe(true);
    // the key is the attacker's own, so it says nothing about any other object
    expect((decoded as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(decoded.real).toBe('data');
  });

  it('keeps a primitive value, which the setter used to discard in silence', () => {
    // the setter ignores a non-object assignment outright, so this key used to
    // vanish with no prototype replaced and no error raised
    const decoded = asMap(decodeCbor(cbTextMap([['__proto__', cbUint(1)]])));
    expect(own(decoded, '__proto__')).toBe(true);
    expect(decoded['__proto__']).toBe(1);
    expect(protoReplaced(decoded)).toBe(false);
  });

  it('keeps it through an indefinite-length map too', () => {
    const indefinite = concatBytes(
      new Uint8Array([0xbf]),
      KEY,
      VALUE,
      new Uint8Array([0xff]),
    );
    const decoded = asMap(decodeCbor(indefinite));
    expect(own(decoded, '__proto__')).toBe(true);
    expect(protoReplaced(decoded)).toBe(false);
  });

  it('keeps it when the map is nested inside another map', () => {
    const decoded = asMap(decodeCbor(cbTextMap([['outer', cbTextMap([['__proto__', VALUE]])]])));
    const inner = asMap(decoded.outer);
    expect(own(inner, '__proto__')).toBe(true);
    expect(protoReplaced(inner)).toBe(false);
  });

  it('decodeCborJson output replaces no prototype', () => {
    // The regression guard. This one holds on a tree with neither allocation
    // fixed, because the setter consumed the key before the walk could
    // enumerate it, and breaks on a tree where only the decodeCbor allocation
    // is fixed, because the walk's own literal then takes the assignment. It
    // is the only assertion here with that shape, so it is the only one that
    // catches the half-applied remedy. Every other assertion in this file
    // states behaviour the fix introduces and fails before it.
    const walked = asMap(decodeCborJson(cbTextMap([['__proto__', VALUE], ['real', cbText('data')]])));
    expect(protoReplaced(walked)).toBe(false);
    expect((walked as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(walked.real).toBe('data');
  });

  it('decodeCborJson preserves the key as data and stays JSON-serializable', () => {
    const walked = asMap(decodeCborJson(cbTextMap([['__proto__', VALUE], ['real', cbText('data')]])));
    expect(own(walked, '__proto__')).toBe(true);
    expect(asMap(walked['__proto__']).polluted).toBe(true);
    // the walk's contract is a JSON-serializable result, which a null
    // prototype does not disturb
    expect(JSON.stringify(walked)).toBe('{"__proto__":{"polluted":true},"real":"data"}');
  });

  it('decodeCborJson leaves no pollution behind a nested map or an array', () => {
    const nested = cbTextMap([
      ['outer', cbTextMap([['__proto__', VALUE]])],
      ['list', concatBytes(head(4, 1), cbTextMap([['__proto__', VALUE]]))],
    ]);
    const walked = asMap(decodeCborJson(nested));
    const inner = asMap(walked.outer);
    expect(protoReplaced(inner)).toBe(false);
    expect((inner as { polluted?: unknown }).polluted).toBeUndefined();
    const [first] = walked.list as unknown[];
    expect(protoReplaced(asMap(first))).toBe(false);
    expect((asMap(first) as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('CBOR decoding, unchanged behaviour around the map allocation', () => {
  it('still stringifies non-text keys and still rejects trailing bytes', () => {
    const decoded = asMap(decodeCbor(concatBytes(head(5, 2), cbUint(0), cbText('a'), cbUint(7), cbText('b'))));
    expect(decoded['0']).toBe('a');
    expect(decoded['7']).toBe('b');
    expect(() => decodeCbor(concatBytes(cbUint(1), cbUint(1)))).toThrow(/trailing bytes/);
  });

  it('still converts byte strings and bigints on the JSON walk', () => {
    const bytes = concatBytes(head(2, 2), new Uint8Array([0xde, 0xad]));
    const big = new Uint8Array([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const walked = asMap(decodeCborJson(cbTextMap([['b', bytes], ['n', big]])));
    expect(walked.b).toBe('0xdead');
    expect(walked.n).toBe('18446744073709551615');
  });
});
