import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  decodeCborJson,
  hexToBytes,
  parseTx,
  sha256,
  verifyProofBundle,
  type ProofBundleJson,
} from '@ordspv/core';
import { OrdResolver, boundedDecompressor, nodeDecompressor, toResponse } from '../src/index.js';
import type { FetchFn } from '../src/backends.js';

/**
 * Extended mainnet vectors (fixtures/extended, vendored by
 * scripts/fetch-fixtures.ts and cross-checked against a live ord instance by
 * scripts/parity-sweep.ts). Each fixture is a proof bundle whose reveal tx,
 * header, and merkle branches self-verify cryptographically, so corrupted
 * fixtures cannot pass. The .json summaries carry live-recorded expectations.
 */

const EXT = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/extended');

const IDS = {
  pushnum: 'ded23bc43cf92d13fe72c1626a019b607289053038eaf6faceb9b00b3ca3548ai0',
  batchI1: '74c157fbb6581e86b333395ca5def1442c9e7a5c9795774dc20325c6c012500bi1',
  brotli: '6dc2c16a74dedcae46300b2058ebadc7ca78aea78236459662375c8d7d9804dbi0',
  chunkedMeta: 'c50ed012bcfd8f890269b2802c7c20308c5a6a0a99499d65db1fcae71c3ab707i0',
  gzipNote: '4c83f2e1d12d6f71e9f69159aff48f7946ce04c5ffcc3a3feee4080bac343722i0',
  delegator: '0028084bc1cdddbd3c870af063c6f65d5ba216d932e3d6ea2fd29e2d43ff9ff2i0',
  delegateTarget: '177c1e83ca20790448559382232487c7c97767f69bf46ec62152c3da0e099882i0',
  // second wave, vendored 2026-07-19 (provenance in fixtures/extended/SOURCES.md)
  recursiveHtml: '52b4ea10c2518c954c73594e403ccfb2d50044f5a3b09a224dfa3bf06dd1d499i0',
  brotliLib: '3891327c4bbefc8f0683c51338504d1bfdcc850c5bd8d16c6b34b6f400a8f214i0',
  childOfInsc0: '47c7260764af2ee17aa584d9c035f2e5429aefd96b8016cfe0e3f0bcf04869a3i0',
  jsonI1: '758b032b5f407900aa1c0bc0fea187e0c2649b6fbc0f1fe97f9fa339fd8d68b2i1',
  css: '6c76e134aaaa83912fb74c1ba235f09f4c94c36be6f9fd93343cda82f90d4245i0',
  cbrc20: '49cbc5cbac92cf917dd4539d62720a3e528d17e22ef5fc47070a17ec0d3cf307i0',
} as const;

const INSC0 = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';

interface Summary {
  inscriptionId: string;
  height: number;
  contentType?: string;
  contentEncoding?: string;
  delegate?: string;
  parents: string[];
  pointer?: string;
  metaprotocol?: string;
  metadataHex?: string;
  /** reveal input carrying the envelope (recorded since the second wave) */
  input?: number;
  bodyLength?: number;
  bodySha256?: string;
  flags: Record<string, boolean>;
  served: Record<string, unknown> & { sha256Decoded?: string };
  l2: Record<string, unknown>;
}

const loadSummary = (id: string): Summary =>
  JSON.parse(readFileSync(join(EXT, `${id}.json`), 'utf8'));
const loadBundle = (id: string): ProofBundleJson =>
  JSON.parse(readFileSync(join(EXT, `${id}.bundle.json`), 'utf8'));

describe('extended vectors: every vendored bundle self-verifies offline', () => {
  const bundleFiles = readdirSync(EXT).filter((f) => f.endsWith('.bundle.json'));

  it('covers all thirteen vendored vectors', () => {
    expect(bundleFiles.length).toBe(Object.keys(IDS).length);
  });

  for (const file of bundleFiles) {
    const id = file.replace('.bundle.json', '');
    it(`${id.slice(0, 12)}…${id.slice(-4)} verifies and matches its summary`, () => {
      const bundle = loadBundle(id);
      const summary = loadSummary(id);
      const verified = verifyProofBundle(bundle);
      expect(bundle.inscriptionId).toBe(id);
      expect(verified.height).toBe(summary.height);
      expect(verified.inscription.contentType).toBe(summary.contentType);
      expect(verified.inscription.contentEncoding).toBe(summary.contentEncoding);
      expect(verified.inscription.delegate).toBe(summary.delegate);
      expect(verified.inscription.parents).toEqual(summary.parents);
      expect(verified.inscription.body?.length).toBe(summary.bodyLength);
      expect(verified.inscription.flags).toEqual(summary.flags);
      expect(verified.l2).toEqual(summary.l2);
      if (summary.input !== undefined) {
        expect(verified.inscription.input).toBe(summary.input);
      }
      if (summary.bodySha256) {
        expect(bytesToHex(sha256(verified.inscription.body!))).toBe(summary.bodySha256);
      }
      if (summary.metadataHex) {
        expect(bytesToHex(verified.inscription.metadata!)).toBe(summary.metadataHex);
      }
    });
  }
});

describe('extended vectors: envelope features', () => {
  it('pushnum-era cursed inscription sets the pushnum flag (pre-Jubilee)', () => {
    const v = verifyProofBundle(loadBundle(IDS.pushnum));
    expect(v.inscription.flags.pushnum).toBe(true);
    expect(v.height).toBeLessThan(824544);
    expect(v.inscription.contentType).toBe('text/plain;charset=utf-8');
  });

  it('i>0 addressing verifies the envelope at index 1 with its pointer', () => {
    const v = verifyProofBundle(loadBundle(IDS.batchI1));
    expect(v.inscription.index).toBe(1);
    expect(v.inscription.pointer).toBe(546n);
  });

  it('brotli tag-9 body decodes to the served javascript', async () => {
    const v = verifyProofBundle(loadBundle(IDS.brotli));
    expect(v.inscription.contentEncoding).toBe('br');
    const decoded = await nodeDecompressor('br', v.inscription.body!);
    expect(decoded).toBeDefined();
    expect(decoded!.length).toBeGreaterThan(v.inscription.body!.length);
  });

  it('gzip tag-9 body decodes (chisel.xyz svg, tag-15 note present in payload)', async () => {
    const v = verifyProofBundle(loadBundle(IDS.gzipNote));
    expect(v.inscription.contentEncoding).toBe('gzip');
    const decoded = await nodeDecompressor('gzip', v.inscription.body!);
    expect(decoded).toBeDefined();
    expect(new TextDecoder().decode(decoded!.slice(0, 4))).toBe('<svg');
  });

  it('chunked metadata (>520B) concatenates to valid CBOR with duplicateField set', () => {
    const v = verifyProofBundle(loadBundle(IDS.chunkedMeta));
    expect(v.inscription.metadata!.length).toBeGreaterThan(520);
    expect(v.inscription.flags.duplicateField).toBe(true); // chunking repeats tag 5
    expect(decodeCborJson(v.inscription.metadata!)).toBeDefined();
  });

  it('delegator carries delegate id, metadata, and an EMPTY (present) body', () => {
    const v = verifyProofBundle(loadBundle(IDS.delegator));
    expect(v.inscription.delegate).toBe(IDS.delegateTarget);
    expect(v.inscription.body).toBeDefined();
    expect(v.inscription.body!.length).toBe(0);
    expect(v.inscription.metadata).toBeDefined();
  });

  it('recursive html (ord handbook Oscillations parent) references /r/ and carries a parent', () => {
    const v = verifyProofBundle(loadBundle(IDS.recursiveHtml));
    expect(v.inscription.contentType).toBe('text/html;charset=utf-8');
    const html = new TextDecoder().decode(v.inscription.body!);
    // the point of the vector: on-chain html that calls ord recursive endpoints
    expect(html).toContain('/r/sat/');
    expect(html).toContain('/content/');
    expect(v.inscription.parents).toEqual([
      '303ffd160b94411bdae3b53bdc3d5329f912a81e459490c6da45358d7f4802e3i0',
    ]);
  });

  it('brotli library decompresses (bounded) to the pinned decoded sha256', async () => {
    const summary = loadSummary(IDS.brotliLib);
    const v = verifyProofBundle(loadBundle(IDS.brotliLib));
    expect(v.inscription.contentEncoding).toBe('br');
    expect(v.inscription.input).toBe(1); // reveal input 1, commit tx proves that input
    const decoded = await boundedDecompressor()('br', v.inscription.body!);
    expect(decoded).toBeDefined();
    expect(decoded!.length).toBe(summary.served.length);
    expect(bytesToHex(sha256(decoded!))).toBe(summary.served.sha256Decoded);
    // stored-bytes integrity pin is over the COMPRESSED body, not the decode
    expect(bytesToHex(sha256(v.inscription.body!))).toBe(summary.bodySha256);
  });

  it('child of inscription 0 surfaces its parent (provenance tag)', () => {
    const v = verifyProofBundle(loadBundle(IDS.childOfInsc0));
    expect(v.inscription.parents).toEqual([INSC0]);
    expect(v.inscription.input).toBe(1);
    expect(new TextDecoder().decode(v.inscription.body!)).toBe('\u{1F9FF}'); // 4 utf-8 bytes
    expect(v.l2?.singleInputReveal).toBe(false); // multi-input reveal: the assurance must say so
  });

  it('application/json body at i1 parses as JSON', () => {
    const v = verifyProofBundle(loadBundle(IDS.jsonI1));
    expect(v.inscription.contentType).toBe('application/json;charset=utf-8');
    expect(v.inscription.index).toBe(1);
    const parsed = JSON.parse(new TextDecoder().decode(v.inscription.body!)) as { p: string };
    expect(parsed.p).toBe('vord');
  });

  it('text/css body round-trips (small non-html asset type)', () => {
    const v = verifyProofBundle(loadBundle(IDS.css));
    expect(v.inscription.contentType).toBe('text/css');
    expect(v.inscription.body!.length).toBe(155);
  });

  it('cbrc-20 vector locks tag-7 metaprotocol plus CBOR metadata', () => {
    const v = verifyProofBundle(loadBundle(IDS.cbrc20));
    expect(v.inscription.metaprotocol).toBe('cbrc-20:deploy');
    expect(decodeCborJson(v.inscription.metadata!)).toBeDefined();
    const body = JSON.parse(new TextDecoder().decode(v.inscription.body!)) as { op: string };
    expect(body.op).toBe('deploy');
  });
});

// ---------- offline resolver flows driven by the vendored bundles ----------

type Route = string | Uint8Array | object;

function stubFetch(routes: Record<string, Route>): FetchFn {
  return async (url: string) => {
    const route = routes[url];
    if (route === undefined) return new Response(`no stub for ${url}`, { status: 404 });
    if (route instanceof Uint8Array) return new Response(route.slice());
    if (typeof route === 'string') return new Response(route);
    return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
  };
}

const E = 'https://esplora.test';
// second, independent header source: anchoring is fail-closed, so non-checkpoint
// heights need the proof builder PLUS one independent attester agreeing
const E2 = 'https://esplora2.test';

/** esplora stub routes serving exactly what a vendored L2 bundle contains */
function routesFromBundle(bundle: ProofBundleJson): Record<string, Route> {
  const txid = bundle.inscriptionId.slice(0, 64);
  const routes: Record<string, Route> = {
    [`${E}/tx/${txid}/status`]: {
      confirmed: true,
      block_height: bundle.block.height,
      block_hash: bundle.block.hash,
    },
    [`${E}/tx/${txid}/hex`]: bundle.reveal.hex,
    [`${E}/tx/${txid}/merkle-proof`]: {
      block_height: bundle.block.height,
      merkle: bundle.reveal.txidBranch,
      pos: bundle.reveal.pos,
    },
    [`${E}/block/${bundle.block.hash}/header`]: bundle.block.header,
    [`${E}/block/${bundle.block.hash}`]: {
      id: bundle.block.hash,
      height: bundle.block.height,
      tx_count: bundle.block.txCount,
    },
    // header trust (heights here are not compiled-in checkpoints): the
    // builder (E) is excluded from attesting, E2 supplies the second vote
    [`${E}/block-height/${bundle.block.height}`]: bundle.block.hash,
    [`${E}/blocks/tip/height`]: String(bundle.block.height + 100),
    [`${E2}/block-height/${bundle.block.height}`]: bundle.block.hash,
    [`${E2}/blocks/tip/height`]: String(bundle.block.height + 100),
  };
  if (bundle.commit) {
    const commit = parseTx(hexToBytes(bundle.commit.hex));
    routes[`${E}/tx/${commit.txid}/hex`] = bundle.commit.hex;
  }
  return routes;
}

describe('OrdResolver offline against extended bundles', () => {
  it('decodes the brotli inscription and reports the stored-bytes hash', async () => {
    const summary = loadSummary(IDS.brotli);
    const resolver = new OrdResolver({
      esplora: [E, E2],
      fetchFn: stubFetch(routesFromBundle(loadBundle(IDS.brotli))),
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${IDS.brotli}`);
    expect(result.decoded).toBe(true);
    expect(result.contentEncoding).toBeUndefined();
    // the tag-9 attestation survives decoding (SPEC-GATEWAY §5)
    expect(result.storedContentEncoding).toBe('br');
    expect(result.body.length).toBeGreaterThan(summary.bodyLength!);
    // integrity pins hash STORED bytes, not decoded bytes
    expect(result.verification.bodySha256).toBe(summary.bodySha256);
    expect(result.contentType).toBe('text/javascript');

    const response = toResponse(result);
    expect(response.headers.get('x-ord-content-encoding')).toBe('br');
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('follows the delegate for /content but serves the empty own-body bare', async () => {
    const routes = {
      ...routesFromBundle(loadBundle(IDS.delegator)),
      ...routesFromBundle(loadBundle(IDS.delegateTarget)),
    };
    const resolver = new OrdResolver({ esplora: [E, E2], fetchFn: stubFetch(routes), verification: 'L2' });

    const viaContent = await resolver.resolve(`ord:${IDS.delegator}/content`);
    expect(viaContent.viaDelegate).toBe(IDS.delegateTarget);
    expect(viaContent.body.length).toBe(loadSummary(IDS.delegateTarget).bodyLength);
    expect(viaContent.contentType).toBe('image/svg+xml');

    // bare URI = undelegated referent: the body EXISTS and is empty (ord parity:
    // /r/undelegated-content serves 0 bytes here, confirmed by the parity sweep)
    const bare = await resolver.resolve(`ord:${IDS.delegator}`);
    expect(bare.viaDelegate).toBeUndefined();
    expect(bare.body.length).toBe(0);
  });

  it('serves chunked metadata via /metadata with CBOR decode', async () => {
    const summary = loadSummary(IDS.chunkedMeta);
    const resolver = new OrdResolver({
      esplora: [E, E2],
      fetchFn: stubFetch(routesFromBundle(loadBundle(IDS.chunkedMeta))),
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${IDS.chunkedMeta}/metadata`);
    expect(result.contentType).toBe('application/cbor');
    expect(bytesToHex(result.body)).toBe(summary.metadataHex);
    expect(result.metadataJson).toBeDefined();
  });

  it('addresses envelope i1 through the resolver at L2', async () => {
    const resolver = new OrdResolver({
      esplora: [E, E2],
      fetchFn: stubFetch(routesFromBundle(loadBundle(IDS.batchI1))),
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${IDS.batchI1}`);
    expect(result.inscription?.index).toBe(1);
    expect(result.body.length).toBe(loadSummary(IDS.batchI1).bodyLength);
  });

  it('decodes the brotli library end-to-end and pins BOTH hashes', async () => {
    const summary = loadSummary(IDS.brotliLib);
    const resolver = new OrdResolver({
      esplora: [E, E2],
      fetchFn: stubFetch(routesFromBundle(loadBundle(IDS.brotliLib))),
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${IDS.brotliLib}`);
    expect(result.decoded).toBe(true);
    expect(result.storedContentEncoding).toBe('br');
    // integrity pin: stored (compressed) bytes; decode pin: served bytes
    expect(result.verification.bodySha256).toBe(summary.bodySha256);
    expect(bytesToHex(sha256(result.body))).toBe(summary.served.sha256Decoded);
    expect(result.body.length).toBe(summary.served.length);
  });

  it('keeps stored bytes when the decode budget is smaller than the output', async () => {
    const summary = loadSummary(IDS.brotliLib);
    const resolver = new OrdResolver({
      esplora: [E, E2],
      fetchFn: stubFetch(routesFromBundle(loadBundle(IDS.brotliLib))),
      verification: 'L2',
      maxDecompressedBytes: 1024, // decoded output is 16475 bytes
    });
    const result = await resolver.resolve(`ord:${IDS.brotliLib}`);
    expect(result.decoded).toBe(false);
    expect(result.contentEncoding).toBe('br'); // encoding survives, bytes stay stored
    expect(result.body.length).toBe(summary.bodyLength);
    expect(result.verification.bodySha256).toBe(summary.bodySha256);
  });

  it('resolves the input-1 child of inscription 0 and surfaces its parent', async () => {
    const resolver = new OrdResolver({
      esplora: [E, E2],
      fetchFn: stubFetch(routesFromBundle(loadBundle(IDS.childOfInsc0))),
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${IDS.childOfInsc0}`);
    expect(result.inscription?.parents).toEqual([INSC0]);
    expect(new TextDecoder().decode(result.body)).toBe('\u{1F9FF}');
    expect(result.verification.l2?.singleInputReveal).toBe(false);
  });
});
