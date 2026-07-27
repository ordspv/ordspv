import { describe, expect, it } from 'vitest';
import {
  concatBytes,
  displayToInternal,
  galleryItems,
  GalleryEncodingError,
  interpretEnvelope,
  inscriptionGallery,
  parseGallery,
  parseEnvelopesFromScript,
  type Inscription,
} from '../src/index.js';
import { envelopeScript } from './helpers.js';

/** parse a tapscript and interpret its single envelope */
function inscriptionFromScript(script: Uint8Array): Inscription {
  const envelopes = parseEnvelopesFromScript(script);
  expect(envelopes).toHaveLength(1);
  return interpretEnvelope({ ...envelopes[0], input: 0, offsetInInput: 0, index: 0 });
}

// ---------------------------------------------------------------------------
// minimal CBOR encoder, test-local: uint, bstr, tstr, array, map
// ---------------------------------------------------------------------------

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n <= 0xff) return new Uint8Array([(major << 5) | 24, n]);
  if (n <= 0xffff) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  return new Uint8Array([
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

const cbUint = (n: number) => head(0, n);
const cbBytes = (b: Uint8Array) => concatBytes(head(2, b.length), b);
const cbText = (s: string) => {
  const b = new TextEncoder().encode(s);
  return concatBytes(head(3, b.length), b);
};
const cbArray = (items: Uint8Array[]) => concatBytes(head(4, items.length), ...items);
const cbMap = (pairs: [number, Uint8Array][]) =>
  concatBytes(head(5, pairs.length), ...pairs.flatMap(([k, v]) => [cbUint(k), v]));

// ---------------------------------------------------------------------------
// id fixtures
// ---------------------------------------------------------------------------

const TXID_A = 'a'.repeat(64);
const TXID_B = '00'.repeat(31) + 'ff';
const TXID_C = 'c1'.repeat(32);

/** serialized id: internal (LE) txid + trailing-zero-trimmed LE index */
function serializedId(txidDisplay: string, index: number): Uint8Array {
  const txidLE = displayToInternal(txidDisplay);
  const idx = [index & 0xff, (index >>> 8) & 0xff, (index >>> 16) & 0xff, (index >>> 24) & 0xff];
  while (idx.length > 0 && idx[idx.length - 1] === 0) idx.pop();
  return concatBytes(txidLE, new Uint8Array(idx));
}

const inlineItem = (txid: string, index = 0) => cbMap([[0, cbBytes(serializedId(txid, index))]]);
const packedItem = (index?: number) => (index === undefined ? cbMap([]) : cbMap([[2, cbUint(index)]]));
const packedBlob = (...txids: string[]) => cbBytes(concatBytes(...txids.map(displayToInternal)));

/** a properties-only Inscription shape */
const withProperties = (properties?: Uint8Array, propertyEncoding?: string) =>
  ({ properties, propertyEncoding }) as Pick<Inscription, 'properties' | 'propertyEncoding'>;

// ---------------------------------------------------------------------------

describe('gallery: inline encoding', () => {
  it('reads serialized ids from Item key 0', () => {
    const props = cbMap([[0, cbArray([inlineItem(TXID_A), inlineItem(TXID_B, 3)])]]);
    expect(parseGallery(props)).toEqual({
      isGallery: true,
      items: [`${TXID_A}i0`, `${TXID_B}i3`],
      skipped: 0,
    });
  });

  it('accepts both the 32-byte and 36-byte serializations of index 0', () => {
    const bare = concatBytes(displayToInternal(TXID_A)); // 32 bytes, index omitted
    const padded = concatBytes(displayToInternal(TXID_B), new Uint8Array(4)); // 36 bytes, index 0
    const props = cbMap([
      [0, cbArray([cbMap([[0, cbBytes(bare)]]), cbMap([[0, cbBytes(padded)]])])],
    ]);
    expect(parseGallery(props).items).toEqual([`${TXID_A}i0`, `${TXID_B}i0`]);
  });

  it('preserves declared order and allows duplicate members', () => {
    const props = cbMap([
      [0, cbArray([inlineItem(TXID_C, 1), inlineItem(TXID_A), inlineItem(TXID_C, 1)])],
    ]);
    expect(parseGallery(props).items).toEqual([`${TXID_C}i1`, `${TXID_A}i0`, `${TXID_C}i1`]);
  });

  it('ignores per-item attributes it does not understand', () => {
    const item = cbMap([
      [0, cbBytes(serializedId(TXID_A, 0))],
      [1, cbMap([[0, cbText('a title')]])],
    ]);
    expect(parseGallery(cbMap([[0, cbArray([item])]])).items).toEqual([`${TXID_A}i0`]);
  });
});

describe('gallery: packed encoding', () => {
  it('takes the txid at the item position and the index from Item key 2', () => {
    const props = cbMap([
      [0, cbArray([packedItem(), packedItem(7)])],
      [2, packedBlob(TXID_A, TXID_B)],
    ]);
    expect(parseGallery(props)).toEqual({
      isGallery: true,
      items: [`${TXID_A}i0`, `${TXID_B}i7`],
      skipped: 0,
    });
  });

  it('defaults an omitted index to 0', () => {
    const props = cbMap([
      [0, cbArray([packedItem(), packedItem()])],
      [2, packedBlob(TXID_B, TXID_C)],
    ]);
    expect(parseGallery(props).items).toEqual([`${TXID_B}i0`, `${TXID_C}i0`]);
  });

  it('agrees byte for byte with the inline encoding of the same gallery', () => {
    const ids = [
      [TXID_A, 0],
      [TXID_B, 2],
      [TXID_C, 0],
    ] as const;
    const inline = cbMap([[0, cbArray(ids.map(([t, i]) => inlineItem(t, i)))]]);
    const packed = cbMap([
      [0, cbArray(ids.map(([, i]) => packedItem(i)))],
      [2, packedBlob(...ids.map(([t]) => t))],
    ]);
    expect(parseGallery(packed).items).toEqual(parseGallery(inline).items);
  });

  it('skips items whose position runs past the packed blob', () => {
    const props = cbMap([
      [0, cbArray([packedItem(), packedItem(), packedItem()])],
      [2, packedBlob(TXID_A, TXID_B)],
    ]);
    expect(parseGallery(props)).toEqual({
      isGallery: true,
      items: [`${TXID_A}i0`, `${TXID_B}i0`],
      skipped: 1,
    });
  });

  it('lets an inline item supply its own id even when a packed blob is present', () => {
    // mixing is not sanctioned; positions must still line up, so the item at
    // position 1 reads txid slice 1, not "the next unused slice"
    const props = cbMap([
      [0, cbArray([inlineItem(TXID_C, 4), packedItem(1)])],
      [2, packedBlob(TXID_A, TXID_B)],
    ]);
    expect(parseGallery(props).items).toEqual([`${TXID_C}i4`, `${TXID_B}i1`]);
  });
});

describe('gallery: malformed input is skipped, not fatal', () => {
  it('reports non-galleries for absent, empty, and non-CBOR properties', () => {
    expect(parseGallery(new Uint8Array())).toEqual({ isGallery: false, items: [], skipped: 0 });
    expect(parseGallery(new Uint8Array([0xff, 0xff, 0xff]))).toEqual({
      isGallery: false,
      items: [],
      skipped: 0,
    });
    expect(inscriptionGallery(withProperties(undefined)).isGallery).toBe(false);
  });

  it('reports a non-gallery when properties carry no Items array', () => {
    expect(parseGallery(cbMap([[1, cbMap([[0, cbText('just attributes')]])]])).isGallery).toBe(
      false,
    );
    // Items present but not an array
    expect(parseGallery(cbMap([[0, cbText('nope')]])).isGallery).toBe(false);
    // properties that are not a map at all
    expect(parseGallery(cbArray([cbUint(1)])).isGallery).toBe(false);
  });

  it('is a gallery with no members when every entry is malformed', () => {
    const props = cbMap([
      [
        0,
        cbArray([
          cbUint(1), // not a map
          cbMap([[0, cbBytes(new Uint8Array(20))]]), // id too short
          cbMap([[0, cbBytes(new Uint8Array(40))]]), // id too long
          cbMap([[0, cbBytes(concatBytes(displayToInternal(TXID_A), new Uint8Array([1, 0])))]]), // non-canonical index
          cbMap([[9, cbUint(0)]]), // no id, no packed blob
        ]),
      ],
    ]);
    expect(parseGallery(props)).toEqual({ isGallery: true, items: [], skipped: 5 });
  });

  it('rejects a packed index beyond u32 rather than truncating it', () => {
    const props = cbMap([
      [0, cbArray([cbMap([[2, cbUint(0xffffffff)]]), cbMap([[2, head(0, 0xffffffff)]])])],
      [2, packedBlob(TXID_A, TXID_B)],
    ]);
    const big = concatBytes(
      head(5, 1),
      cbUint(2),
      new Uint8Array([0x1b, 0, 0, 0, 1, 0, 0, 0, 0]), // uint 2^32
    );
    expect(parseGallery(props).items).toEqual([`${TXID_A}i4294967295`, `${TXID_B}i4294967295`]);
    expect(
      parseGallery(cbMap([[0, cbArray([big])], [2, packedBlob(TXID_A)]])),
    ).toEqual({ isGallery: true, items: [], skipped: 1 });
  });

  it('keeps good members alongside bad ones', () => {
    const props = cbMap([
      [0, cbArray([inlineItem(TXID_A), cbUint(0), inlineItem(TXID_C, 2)])],
    ]);
    expect(parseGallery(props)).toEqual({
      isGallery: true,
      items: [`${TXID_A}i0`, `${TXID_C}i2`],
      skipped: 1,
    });
  });
});

describe('gallery: reading off a parsed inscription', () => {
  it('decodes a gallery straight out of an envelope script', () => {
    const props = cbMap([[0, cbArray([inlineItem(TXID_A), inlineItem(TXID_B, 1)])]]);
    const script = envelopeScript({
      fields: [
        [1, 'image/png'],
        [17, props],
      ],
      body: ['hello'],
    });
    expect(galleryItems(inscriptionFromScript(script))).toEqual([`${TXID_A}i0`, `${TXID_B}i1`]);
  });

  it('concatenates properties split across several tag 17 pushes', () => {
    const props = cbMap([[0, cbArray([inlineItem(TXID_A), inlineItem(TXID_C, 5)])]]);
    const cut = 9;
    const script = envelopeScript({
      fields: [
        [17, props.subarray(0, cut)],
        [17, props.subarray(cut)],
      ],
      body: ['hi'],
    });
    const inscription = inscriptionFromScript(script);
    expect(inscription.properties).toEqual(props);
    expect(galleryItems(inscription)).toEqual([`${TXID_A}i0`, `${TXID_C}i5`]);
  });

  it('refuses compressed properties until the caller decodes them', () => {
    const props = cbMap([[0, cbArray([inlineItem(TXID_A)])]]);
    const compressed = withProperties(new Uint8Array([0x1b, 0x00, 0x00]), 'br');

    // reporting "no gallery" here would be indistinguishable from an
    // inscription that declares none, so it throws instead
    expect(() => inscriptionGallery(compressed)).toThrow(GalleryEncodingError);
    expect(() => inscriptionGallery(compressed)).toThrow(/property_encoding "br"/);
    expect(() => galleryItems(compressed)).toThrow(GalleryEncodingError);

    // and the decoded path reads the members
    expect(inscriptionGallery(compressed, { decodedProperties: props }).items).toEqual([
      `${TXID_A}i0`,
    ]);
    expect(galleryItems(compressed, { decodedProperties: props })).toEqual([`${TXID_A}i0`]);
  });

  it('reports no gallery when an encoding is declared with no properties at all', () => {
    // nothing to decompress, so nothing is being hidden
    expect(inscriptionGallery(withProperties(undefined, 'br')).isGallery).toBe(false);
  });

  it('has no gallery for an inscription with no properties field', () => {
    const script = envelopeScript({ fields: [[1, 'text/plain']], body: ['x'] });
    const inscription = inscriptionFromScript(script);
    expect(inscription.properties).toBeUndefined();
    expect(galleryItems(inscription)).toEqual([]);
  });
});
