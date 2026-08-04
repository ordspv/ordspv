import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHeader, hexToBytes } from '@ordspv/core';
import {
  checkpointTrustHeader,
  EsploraBackend,
  HeaderTrustError,
  makeHeaderTrust,
} from '../src/index.js';
import type { FetchFn } from '../src/backends.js';
import { buildBlock, dummyTx } from '../../core/test/helpers.js';

/**
 * Header-anchoring is FAIL-CLOSED: a proof header at a height covered by
 * neither a checkpoint nor enough independent sources must throw. A backend
 * that served the bundle neither votes nor counts: the number reported is the
 * number of agreeing attesters that had no hand in building it.
 */

// the real vendored mainnet header at 767430 — satisfies the mainnet powLimit
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insc0');
const HEADER = parseHeader(
  hexToBytes(readFileSync(join(FIXTURES, 'header-767430.hex'), 'utf8').trim()),
);
const HEIGHT = 767430;

function esplora(base: string, routes: Record<string, string>): EsploraBackend {
  const fetchFn: FetchFn = async (url: string) =>
    routes[url] !== undefined
      ? new Response(routes[url])
      : new Response('no stub', { status: 404 });
  return new EsploraBackend(base, fetchFn);
}

const agreeRoutes = (base: string, hash: string, tip = HEIGHT + 10): Record<string, string> => ({
  [`${base}/block-height/${HEIGHT}`]: hash,
  [`${base}/blocks/tip/height`]: String(tip),
});

describe('fail-closed header anchoring', () => {
  it('rejects a non-checkpoint height served by a single esplora (the builder)', async () => {
    const only = esplora('https://a.test', agreeRoutes('https://a.test', HEADER.hash));
    const trust = makeHeaderTrust({
      esploras: [only],
      checkpoints: new Map(),
      proofSource: 'https://a.test',
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(HeaderTrustError);
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/not independently anchored/);
  });

  it('rejects when there is no proof source and only one source agrees', async () => {
    const only = esplora('https://a.test', agreeRoutes('https://a.test', HEADER.hash));
    const trust = makeHeaderTrust({ esploras: [only], checkpoints: new Map() });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/not independently anchored/);
  });

  it('a compromised proof builder among N cannot self-satisfy the vote', async () => {
    // the builder WOULD agree with its own header, but its vote is excluded;
    // both honest sources report a different canonical hash at that height
    const otherHash = 'f'.repeat(64);
    const builder = esplora('https://builder.test', agreeRoutes('https://builder.test', HEADER.hash));
    const honest1 = esplora('https://h1.test', agreeRoutes('https://h1.test', otherHash));
    const honest2 = esplora('https://h2.test', agreeRoutes('https://h2.test', otherHash));
    const trust = makeHeaderTrust({
      esploras: [builder, honest1, honest2],
      checkpoints: new Map(),
      proofSource: 'https://builder.test',
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/not independently anchored/);
  });

  it('rejects a bundle served by one backend with only one agreeing outside attester', async () => {
    // the pre-0.3.0 arithmetic credited the serving backend with a vote, so
    // this configuration anchored on a single outside opinion
    const builder = esplora('https://builder.test', agreeRoutes('https://builder.test', HEADER.hash));
    const attester = esplora('https://h1.test', agreeRoutes('https://h1.test', HEADER.hash));
    const trust = makeHeaderTrust({
      esploras: [builder, attester],
      checkpoints: new Map(),
      proofSource: 'https://builder.test',
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(
      /not independently anchored: 1 independent source/,
    );
    // the message names the excluded backend and the flag that adds attesters
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/1 serving backend\(s\) excluded/);
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/--anchor-source/);
  });

  it('refuses to build an anchor that needs no agreeing source', async () => {
    // `agreed.length < 0` is never true, so a zero threshold reported a header
    // as anchored on nobody's word at all
    expect(() => makeHeaderTrust({ minAgreement: 0 })).toThrow(HeaderTrustError);
    expect(() => makeHeaderTrust({ minAgreement: 0 })).toThrow(/pass an integer of 1 or more/);
    expect(() => makeHeaderTrust({ minAgreement: -1 })).toThrow(HeaderTrustError);
    // 1 is thin and allowed, and the default stands
    expect(() => makeHeaderTrust({ minAgreement: 1 })).not.toThrow();
    expect(() => makeHeaderTrust({})).not.toThrow();
  });

  it('refuses a threshold that is not a whole number of sources', async () => {
    // `NaN < 1` is false, so a bare lower bound passed NaN through: `required`
    // became NaN, `independentSources < required` was false for every value,
    // and the anchor reported hash-at-height with nobody agreeing. A caller
    // passing Number(process.env.X) reaches it, and a sub-BIP34 coinbase
    // height rests on that attestation
    expect(() => makeHeaderTrust({ minAgreement: Number.NaN })).toThrow(HeaderTrustError);
    expect(() => makeHeaderTrust({ minAgreement: Number.NaN })).toThrow(
      /minAgreement NaN is not a whole number of agreeing sources/,
    );
    expect(() => makeHeaderTrust({ minAgreement: 1.5 })).toThrow(HeaderTrustError);
    expect(() => makeHeaderTrust({ minAgreement: 1.5 })).toThrow(
      /minAgreement 1.5 is not a whole number/,
    );
  });

  it('reports hash-at-height as what an anchor attested', async () => {
    // the marker the core verifier reads before accepting a sub-BIP34
    // coinbase height; both anchor kinds compare the hash AT the height
    const a1 = esplora('https://h1.test', agreeRoutes('https://h1.test', HEADER.hash));
    const a2 = esplora('https://h2.test', agreeRoutes('https://h2.test', HEADER.hash));
    const voted = await makeHeaderTrust({ esploras: [a1, a2], checkpoints: new Map() })(
      HEADER,
      HEIGHT,
    );
    expect(voted.attests).toBe('hash-at-height');
    const checkpointed = await makeHeaderTrust({
      esploras: [],
      checkpoints: new Map([[HEIGHT, HEADER.hash]]),
    })(HEADER, HEIGHT);
    expect(checkpointed.checkpointHit).toBe(true);
    expect(checkpointed.attests).toBe('hash-at-height');
  });

  it('accepts two agreeing attesters that did not serve the bundle', async () => {
    const builder = esplora('https://builder.test', agreeRoutes('https://builder.test', HEADER.hash));
    const a1 = esplora('https://h1.test', agreeRoutes('https://h1.test', HEADER.hash));
    const a2 = esplora('https://h2.test', agreeRoutes('https://h2.test', HEADER.hash));
    const trust = makeHeaderTrust({
      esploras: [builder, a1, a2],
      checkpoints: new Map(),
      proofSource: 'https://builder.test',
    });
    const report = await trust(HEADER, HEIGHT);
    expect(report.anchored).toBe(true);
    expect(report.independentSources).toBe(2);
    expect(report.sourcesQueried).toBe(2); // the builder was not asked to attest
    expect(report.sourcesAgreed).toBe(2);
    expect(report.builderIsSource).toBe(true);
  });

  it('excludes every backend named by proofSources, not just one', async () => {
    // a pooled build serves bytes from several backends; all of them are out
    const p1 = esplora('https://p1.test', agreeRoutes('https://p1.test', HEADER.hash));
    const p2 = esplora('https://p2.test', agreeRoutes('https://p2.test', HEADER.hash));
    const attester = esplora('https://h1.test', agreeRoutes('https://h1.test', HEADER.hash));
    const trust = makeHeaderTrust({
      esploras: [p1, p2, attester],
      checkpoints: new Map(),
      proofSources: new Set(['https://p1.test', 'https://p2.test']),
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/2 serving backend\(s\) excluded/);
  });

  it('excludes a serving backend spelled with different capitalization', async () => {
    // host names are case-insensitive, so this is the same server; comparing
    // raw strings let it vote for the header it had just served
    const alias = esplora('https://Mempool.space/api', agreeRoutes('https://mempool.space/api', HEADER.hash));
    const outsider = esplora('https://h1.test', agreeRoutes('https://h1.test', HEADER.hash));
    const trust = makeHeaderTrust({
      esploras: [alias, outsider],
      checkpoints: new Map(),
      proofSources: new Set(['https://mempool.space/api']),
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(HeaderTrustError);
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/1 independent source/);
  });

  it('counts one endpoint once however many times it is listed', async () => {
    // the same attester under three spellings is one attester, so the default
    // threshold of two is not met
    const routes = agreeRoutes('https://h1.test/api', HEADER.hash);
    const trust = makeHeaderTrust({
      esploras: [
        esplora('https://h1.test/api', routes),
        esplora('https://H1.test/api/', routes),
        esplora('https://h1.test:443/api', routes),
      ],
      checkpoints: new Map(),
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/1 independent source/);
  });

  it('excludes a serving backend spelled as a root-anchored FQDN', async () => {
    // a trailing dot names the same DNS host, so this is the serving backend
    // under another spelling, and it collapses to one attester with it
    const alias = esplora('https://mempool.space./api', agreeRoutes('https://mempool.space/api', HEADER.hash));
    const outsider = esplora('https://h1.test', agreeRoutes('https://h1.test', HEADER.hash));
    const trust = makeHeaderTrust({
      esploras: [alias, outsider],
      checkpoints: new Map(),
      proofSources: new Set(['https://mempool.space/api']),
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(HeaderTrustError);
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/1 independent source/);
  });

  it('counts an agreeing attester whose tip endpoint fails (agreement is hash-only)', async () => {
    // the attester answers hash-at-height but its tip endpoint 404s; without
    // minConfirmations the tip must not be consulted at all, so the agreeing
    // vote survives a flaky tip endpoint
    const builder = esplora('https://builder.test', {});
    const flakyTip = esplora('https://h1.test', {
      [`https://h1.test/block-height/${HEIGHT}`]: HEADER.hash,
    });
    const attester = esplora('https://h2.test', agreeRoutes('https://h2.test', HEADER.hash));
    const trust = makeHeaderTrust({
      esploras: [builder, flakyTip, attester],
      checkpoints: new Map(),
      proofSource: 'https://builder.test',
    });
    const report = await trust(HEADER, HEIGHT);
    expect(report.anchored).toBe(true);
    expect(report.independentSources).toBe(2);
    expect(report.sourcesAgreed).toBe(2);
    expect(report.tipHeight).toBeUndefined(); // tip phase skipped entirely
  });

  it('still enforces minConfirmations through the separate tip phase', async () => {
    const builder = esplora('https://builder.test', {});
    // both attesters agree; their tips are only 2 blocks above the proof height
    const a1 = esplora('https://h1.test', agreeRoutes('https://h1.test', HEADER.hash, HEIGHT + 2));
    const a2 = esplora('https://h2.test', agreeRoutes('https://h2.test', HEADER.hash, HEIGHT + 2));
    const common = {
      esploras: [builder, a1, a2],
      checkpoints: new Map<number, string>(),
      proofSource: 'https://builder.test',
    };
    await expect(
      makeHeaderTrust({ ...common, minConfirmations: 6 })(HEADER, HEIGHT),
    ).rejects.toThrow(/only 3 confirmations/);
    await expect(
      makeHeaderTrust({ ...common, minConfirmations: 3 })(HEADER, HEIGHT),
    ).resolves.toMatchObject({ anchored: true, tipHeight: HEIGHT + 2 });
  });

  it('checkpoint hit anchors without any live source', async () => {
    const trust = makeHeaderTrust({ esploras: [] });
    const report = await trust(HEADER, HEIGHT); // 767430 is a compiled checkpoint
    expect(report.checkpointHit).toBe(true);
    expect(report.anchored).toBe(true);
    expect(report.independentSources).toBe(0);
    expect(report.builderIsSource).toBe(false);
  });
});

describe('proof-of-work limit floor', () => {
  it('rejects a header whose target is easier than the mainnet powLimit', async () => {
    const block = buildBlock([dummyTx()]); // mined at regtest bits 0x207fffff
    const header = parseHeader(hexToBytes(block.headerHex));
    const trust = makeHeaderTrust({ esploras: [], checkpoints: new Map() });
    await expect(trust(header, 100)).rejects.toThrow(/easier than the proof-of-work limit/);
  });

  it('powLimitBits: null disables the floor for non-mainnet chains', async () => {
    const block = buildBlock([dummyTx()]);
    const header = parseHeader(hexToBytes(block.headerHex));
    const a = esplora('https://a.test', {
      [`https://a.test/block-height/100`]: header.hash,
      [`https://a.test/blocks/tip/height`]: '110',
    });
    const b = esplora('https://b.test', {
      [`https://b.test/block-height/100`]: header.hash,
      [`https://b.test/blocks/tip/height`]: '110',
    });
    const trust = makeHeaderTrust({
      esploras: [a, b],
      checkpoints: new Map(),
      powLimitBits: null,
    });
    const report = await trust(header, 100);
    expect(report.anchored).toBe(true);
    expect(report.independentSources).toBe(2);
  });

  it('mainnet headers pass the default floor', async () => {
    const trust = makeHeaderTrust({ esploras: [] }); // checkpoint covers the rest
    await expect(trust(HEADER, HEIGHT)).resolves.toMatchObject({ checkpointHit: true });
  });
});

/**
 * The synchronous checkpoint adapter for the core `trustHeader` hook, which is
 * how `ord-resolve verify` consults the compiled-in checkpoints offline. It
 * mirrors makeHeaderTrust's checkpoint arm: a mismatch is refused, a match
 * asserts hash-at-height, and a height no checkpoint covers passes silently.
 */
describe('checkpointTrustHeader', () => {
  it('asserts hash-at-height when the compiled-in checkpoint matches', () => {
    expect(checkpointTrustHeader()(HEADER, HEIGHT)).toBe('hash-at-height');
  });

  it('refuses a header that contradicts the checkpoint at its claimed height', () => {
    const hook = checkpointTrustHeader();
    expect(() => hook(HEADER, 824544)).toThrow(HeaderTrustError);
    expect(() => hook(HEADER, 824544)).toThrow(/at height 824544 contradicts checkpoint/);
  });

  it('passes silently at a height no checkpoint covers', () => {
    expect(checkpointTrustHeader()(HEADER, HEIGHT + 1)).toBeUndefined();
  });

  it('reads a caller-supplied checkpoint set in place of the default', () => {
    const pinned = checkpointTrustHeader(new Map([[123, HEADER.hash]]));
    expect(pinned(HEADER, 123)).toBe('hash-at-height');
    // the default set pins height 0; this set does not, so 0 passes silently
    expect(pinned(HEADER, 0)).toBeUndefined();
  });
});
