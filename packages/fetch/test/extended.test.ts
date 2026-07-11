import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  decodeCborJson,
  hexToBytes,
  parseTx,
  verifyProofBundle,
  type ProofBundleJson,
} from '@ord-resolver/core';
import { OrdResolver, nodeDecompressor } from '../src/index.js';
import type { FetchFn } from '../src/backends.js';

/**
 * Extended mainnet vectors (fixtures/extended, vendored by
 * scripts/fetch-fixtures.ts and cross-checked against a live ord instance by
 * scripts/parity-sweep.ts). Each fixture is a proof bundle whose reveal tx,
 * header, and merkle branches self-verify cryptographically — corrupted
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
} as const;

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
  bodyLength?: number;
  bodySha256?: string;
  flags: Record<string, boolean>;
  served: Record<string, unknown>;
  l2: Record<string, unknown>;
}

const loadSummary = (id: string): Summary =>
  JSON.parse(readFileSync(join(EXT, `${id}.json`), 'utf8'));
const loadBundle = (id: string): ProofBundleJson =>
  JSON.parse(readFileSync(join(EXT, `${id}.bundle.json`), 'utf8'));

describe('extended vectors: every vendored bundle self-verifies offline', () => {
  const bundleFiles = readdirSync(EXT).filter((f) => f.endsWith('.bundle.json'));

  it('covers all seven vendored vectors', () => {
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
      expect(verified.inscription.body?.length).toBe(summary.bodyLength);
      expect(verified.inscription.flags).toEqual(summary.flags);
      expect(verified.l2).toEqual(summary.l2);
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
    // header trust (heights here are not compiled-in checkpoints)
    [`${E}/block-height/${bundle.block.height}`]: bundle.block.hash,
    [`${E}/blocks/tip/height`]: String(bundle.block.height + 100),
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
      esplora: [E],
      fetchFn: stubFetch(routesFromBundle(loadBundle(IDS.brotli))),
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${IDS.brotli}`);
    expect(result.decoded).toBe(true);
    expect(result.contentEncoding).toBeUndefined();
    expect(result.body.length).toBeGreaterThan(summary.bodyLength!);
    // integrity pins hash STORED bytes, not decoded bytes
    expect(result.verification.bodySha256).toBe(summary.bodySha256);
    expect(result.contentType).toBe('text/javascript');
  });

  it('follows the delegate for /content but serves the empty own-body bare', async () => {
    const routes = {
      ...routesFromBundle(loadBundle(IDS.delegator)),
      ...routesFromBundle(loadBundle(IDS.delegateTarget)),
    };
    const resolver = new OrdResolver({ esplora: [E], fetchFn: stubFetch(routes), verification: 'L2' });

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
      esplora: [E],
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
      esplora: [E],
      fetchFn: stubFetch(routesFromBundle(loadBundle(IDS.batchI1))),
      verification: 'L2',
    });
    const result = await resolver.resolve(`ord:${IDS.batchI1}`);
    expect(result.inscription?.index).toBe(1);
    expect(result.body.length).toBe(loadSummary(IDS.batchI1).bodyLength);
  });
});
