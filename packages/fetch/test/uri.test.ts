import { describe, expect, it } from 'vitest';
import { parseOrdUri, isOrdUri } from '../src/index.js';

const ID = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';

describe('ord URI parsing', () => {
  it('parses the canonical upstream form ord:<id>', () => {
    const p = parseOrdUri(`ord:${ID}`);
    expect(p.idString).toBe(ID);
    expect(p.path).toBe('undelegated');
    expect(p.canonical).toBe(`ord:${ID}`);
  });

  it('tolerates the ord:// alias and normalizes it away', () => {
    const p = parseOrdUri(`ord://${ID}`);
    expect(p.canonical).toBe(`ord:${ID}`);
  });

  it('is case-insensitive (QR alphanumeric mode compatibility)', () => {
    const p = parseOrdUri(`ORD:${ID.toUpperCase().replace('I0', 'i0'.toUpperCase())}`);
    expect(p.idString).toBe(ID);
  });

  it('accepts bare inscription ids', () => {
    expect(parseOrdUri(ID).canonical).toBe(`ord:${ID}`);
  });

  it('parses /content and /metadata paths', () => {
    expect(parseOrdUri(`ord:${ID}/content`).path).toBe('content');
    expect(parseOrdUri(`ord:${ID}/metadata`).path).toBe('metadata');
  });

  it('parses hex integrity fragments', () => {
    const digest = 'a'.repeat(64);
    const p = parseOrdUri(`ord:${ID}#integrity=sha256-${digest}`);
    expect(p.integrity).toEqual({ algorithm: 'sha256', digestHex: digest });
    expect(p.canonical).toBe(`ord:${ID}#integrity=sha256-${digest}`);
  });

  it('parses base64url integrity fragments (SRI style)', () => {
    const digestHex = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('hex');
    const b64url = Buffer.from(digestHex, 'hex').toString('base64url');
    const p = parseOrdUri(`ord:${ID}#integrity=sha256-${b64url}`);
    expect(p.integrity?.digestHex).toBe(digestHex);
  });

  it('rejects malformed inputs', () => {
    expect(() => parseOrdUri('ord:nothex')).toThrow();
    expect(() => parseOrdUri(`ord:${ID}/unknown`)).toThrow(/unknown ord URI path/);
    expect(() => parseOrdUri(`ord:${ID}#integrity=md5-abc`)).toThrow(/unsupported integrity/);
    expect(() => parseOrdUri(`ord:${ID.replace('i0', 'i01')}`)).toThrow();
    expect(() => parseOrdUri('ipfs://bafy')).toThrow(/not an ord URI/);
    expect(isOrdUri('https://example.com')).toBe(false);
    expect(isOrdUri(`ord:${ID}/content`)).toBe(true);
  });

  it('rejects out-of-range indices', () => {
    expect(() => parseOrdUri(`ord:${'a'.repeat(64)}i4294967296`)).toThrow(/out of range/);
  });
});
