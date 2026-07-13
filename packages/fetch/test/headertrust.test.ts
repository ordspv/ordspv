import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHeader, hexToBytes } from '@ordspv/core';
import { EsploraBackend, HeaderTrustError, makeHeaderTrust } from '../src/index.js';
import type { FetchFn } from '../src/backends.js';
import { buildBlock, dummyTx } from '../../core/test/helpers.js';

/**
 * Header-anchoring is FAIL-CLOSED: a proof header at a height covered by
 * neither a checkpoint nor enough independent sources must throw, and the
 * backend that built the proof must not be able to vote for its own header.
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

  it('accepts builder + one independent agreeing source (the 2-source default path)', async () => {
    const builder = esplora('https://builder.test', {});
    const attester = esplora('https://h1.test', agreeRoutes('https://h1.test', HEADER.hash));
    const trust = makeHeaderTrust({
      esploras: [builder, attester],
      checkpoints: new Map(),
      proofSource: 'https://builder.test',
    });
    const report = await trust(HEADER, HEIGHT);
    expect(report.anchored).toBe(true);
    expect(report.independentSources).toBe(2);
    expect(report.sourcesQueried).toBe(1); // the builder was not asked to attest
    expect(report.sourcesAgreed).toBe(1);
  });

  it('checkpoint hit anchors without any live source', async () => {
    const trust = makeHeaderTrust({ esploras: [] });
    const report = await trust(HEADER, HEIGHT); // 767430 is a compiled checkpoint
    expect(report.checkpointHit).toBe(true);
    expect(report.anchored).toBe(true);
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
