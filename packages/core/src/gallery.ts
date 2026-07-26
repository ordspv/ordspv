/**
 * Galleries: member lists from the properties field (tag 17).
 *
 * Per the handbook, inscriptions whose properties contain Items are galleries.
 * The member list therefore lives in the gallery inscription's OWN envelope,
 * so it is on-chain content verifiable exactly like any other inscription
 * bytes: an L2/L3 proof over the gallery inscription settles both membership
 * and completeness with no indexer involved. This is unlike children
 * provenance, where the parent's envelope says nothing about who claimed it
 * and enumeration needs an index.
 *
 * Two interchangeable encodings exist and both are accepted:
 * - inline: each Item carries its serialized inscription id (32..36 bytes,
 *   txid followed by a trailing-zero-trimmed little-endian index) under Item
 *   key 0;
 * - packed: Properties key 2 holds the concatenated 32-byte txids and each
 *   Item carries only the index component of its id under Item key 2
 *   (absent means 0). Item at array position i takes txid slice i.
 *
 * Handling is lenient, matching how ord treats malformed envelope data:
 * entries that do not decode as items are skipped rather than poisoning the
 * whole list, and properties with no Items yield an empty non-gallery result.
 * `skipped` reports how many entries were dropped, so a caller that needs to
 * claim a complete member list can tell whether it got one.
 *
 * Properties may be compressed (property_encoding, tag 19). Decompression is
 * IO- and platform-dependent, so this zero-IO module does not do it: pass the
 * already-decoded bytes as `decodedProperties` when an encoding is declared.
 */

import { decodeCbor, type CborValue } from './cbor.js';
import { parseInscriptionIdValue, type Inscription } from './envelope.js';
import { internalToDisplay } from './bytes.js';

/** Properties map key holding the Items array. */
export const PROPERTY_KEY_ITEMS = 0;
/** Properties map key holding concatenated 32-byte txids (packed encoding). */
export const PROPERTY_KEY_GALLERY_TXIDS = 2;
/** Item map key holding a serialized inscription id (inline encoding). */
export const ITEM_KEY_ID = 0;
/** Item map key holding an inscription index (packed encoding). */
export const ITEM_KEY_INDEX = 2;

const MAX_INSCRIPTION_INDEX = 0xffffffff;
const TXID_BYTES = 32;

/** A decoded gallery member list. */
export interface GalleryInfo {
  /**
   * True when the properties decoded to a map carrying an Items array, which
   * is ord's definition of a gallery. A gallery whose every entry is
   * malformed is still a gallery with no resolvable members.
   */
  isGallery: boolean;
  /** Member inscription ids in declared order. */
  items: string[];
  /** Entries in the Items array that did not yield an id. */
  skipped: number;
}

const NOT_A_GALLERY: GalleryInfo = { isGallery: false, items: [], skipped: 0 };

function isPlainMap(v: CborValue): v is { [key: string]: CborValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** CBOR uint keys are stringified by the decoder; look them up by number. */
function at(map: { [key: string]: CborValue }, key: number): CborValue {
  return map[String(key)];
}

function inscriptionIndex(raw: CborValue): number | undefined {
  if (raw === undefined) return 0;
  const n = typeof raw === 'number' ? raw : typeof raw === 'bigint' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_INSCRIPTION_INDEX) return undefined;
  return n;
}

/** Decode a gallery member list from raw (decompressed) properties CBOR. */
export function parseGallery(properties: Uint8Array): GalleryInfo {
  if (properties.length === 0) return NOT_A_GALLERY;

  let decoded: CborValue;
  try {
    decoded = decodeCbor(properties);
  } catch {
    return NOT_A_GALLERY;
  }
  if (!isPlainMap(decoded)) return NOT_A_GALLERY;

  const entries = at(decoded, PROPERTY_KEY_ITEMS);
  if (!Array.isArray(entries)) return NOT_A_GALLERY;

  const packedRaw = at(decoded, PROPERTY_KEY_GALLERY_TXIDS);
  const packed = packedRaw instanceof Uint8Array ? packedRaw : undefined;

  const items: string[] = [];
  let skipped = 0;

  entries.forEach((entry, i) => {
    if (!isPlainMap(entry)) {
      skipped++;
      return;
    }

    // inline: the item carries the whole serialized id
    const serialized = at(entry, ITEM_KEY_ID);
    if (serialized instanceof Uint8Array) {
      const id = parseInscriptionIdValue(serialized);
      if (id) items.push(id);
      else skipped++;
      return;
    }

    // packed: txid comes from the properties-level blob at this position
    if (!packed || packed.length < TXID_BYTES * (i + 1)) {
      skipped++;
      return;
    }
    const index = inscriptionIndex(at(entry, ITEM_KEY_INDEX));
    if (index === undefined) {
      skipped++;
      return;
    }
    const txidLE = packed.subarray(TXID_BYTES * i, TXID_BYTES * (i + 1));
    items.push(`${internalToDisplay(txidLE)}i${index}`);
  });

  return { isGallery: true, items, skipped };
}

/** Options for reading a gallery off a parsed inscription. */
export interface GalleryOptions {
  /**
   * Properties bytes already decompressed by the caller. Required to read a
   * gallery whose inscription declares a property_encoding (tag 19), since
   * decompression lives outside this module.
   */
  decodedProperties?: Uint8Array;
}

/** Read the gallery member list declared by a parsed inscription. */
export function inscriptionGallery(
  inscription: Pick<Inscription, 'properties' | 'propertyEncoding'>,
  options: GalleryOptions = {},
): GalleryInfo {
  const raw = options.decodedProperties ?? inscription.properties;
  if (!raw) return NOT_A_GALLERY;
  // compressed bytes are not CBOR; refuse rather than report an empty gallery
  if (!options.decodedProperties && inscription.propertyEncoding) return NOT_A_GALLERY;
  return parseGallery(raw);
}

/** Gallery member inscription ids declared by a parsed inscription. */
export function galleryItems(
  inscription: Pick<Inscription, 'properties' | 'propertyEncoding'>,
  options: GalleryOptions = {},
): string[] {
  return inscriptionGallery(inscription, options).items;
}
