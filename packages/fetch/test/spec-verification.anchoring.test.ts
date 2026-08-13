/**
 * The SPEC-VERIFICATION rows whose code lives in @ordspv/fetch: §4's header
 * anchoring (`headertrust.ts`), §2's L0 labelling and §6's delegate hop (both
 * `resolver.ts`).
 *
 * The accounting table is shared with the core suite
 * (`packages/core/test/spec-verification.rows.ts`), and the accounting test
 * that sums the whole spec lives in
 * `packages/core/test/spec-verification.conformance.test.ts`. Neither file can
 * lose a row: the table names which of the two drives each one, and each file
 * asserts it drives exactly the rows assigned to it.
 *
 * Most rows here are `tested at headertrust.test.ts`, which drives the anchor
 * across its arms and its failure modes. What these tests add is traceability
 * from the spec sentence to an assertion, so they are deliberately thin.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  buildMerkleBranch,
  hexToBytes,
  internalToDisplay,
  parseHeader,
  serializeBlock,
  type ParsedTx,
} from '@ordspv/core';
import {
  ROOT,
  anchor,
  drivenIdsFor,
  idsFor,
  row,
} from '../../core/test/spec-verification.rows.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type EnvelopeSpec,
  type TestBlock,
} from '../../core/test/helpers.js';
import {
  EsploraBackend,
  HeaderTrustDisagreementError,
  HeaderTrustError,
  MAINNET_CHECKPOINTS,
  OrdResolver,
  checkpointTrustHeader,
  makeHeaderTrust,
} from '../src/index.js';
import type { FetchFn } from '../src/backends.js';

// ---------------------------------------------------------------------------
// the test wrapper
// ---------------------------------------------------------------------------

/** ids this file speaks for, compared against the table at the bottom */
const SPOKEN: string[] = [];

function conformance(id: string, body: () => void | Promise<void>): void {
  const r = row(id);
  if (r.file !== 'fetch') throw new Error(`row ${id} is assigned to the ${r.file} file`);
  SPOKEN.push(id);
  it(`SPEC-VERIFICATION.md ${r.section}: ${r.title}`, async () => {
    anchor(r.quote);
    await body();
  });
}

// ---------------------------------------------------------------------------
// anchoring fixtures: the vendored mainnet header at a checkpoint height
// ---------------------------------------------------------------------------

const HEADER = parseHeader(
  hexToBytes(readFileSync(join(ROOT, 'fixtures/insc0/header-767430.hex'), 'utf8').trim()),
);
const CHECKPOINT_HEIGHT = 767430;
/** a height no compiled-in checkpoint covers, so the vote decides it */
const VOTED_HEIGHT = 800_000;

function esplora(base: string, hashAtHeight: string, height = VOTED_HEIGHT): EsploraBackend {
  const routes: Record<string, string> = {
    [`${base}/block-height/${height}`]: hashAtHeight,
    [`${base}/blocks/tip/height`]: String(height + 10),
  };
  const fetchFn: FetchFn = async (url: string) =>
    routes[url] !== undefined ? new Response(routes[url]) : new Response('no stub', { status: 404 });
  return new EsploraBackend(base, fetchFn);
}

function unreachable(base: string): EsploraBackend {
  return new EsploraBackend(base, async () => new Response('down', { status: 502 }));
}

const OTHER_HASH = '00000000000000000000' + 'ab'.repeat(22);

// ---------------------------------------------------------------------------
// resolver fixtures: one synthetic block, served by one stubbed backend
// ---------------------------------------------------------------------------

const E = 'https://esplora.test';
const E2 = 'https://esplora2.test';
const E3 = 'https://esplora3.test';
const O = 'https://ord.test';
const BLOCK_HEIGHT = 100;
/** synthetic blocks are mined at regtest difficulty and outside the checkpoints */
const SYNTHETIC = { powLimitBits: null as null, anchorSources: [E2, E3] };

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

interface Inscribed {
  id: string;
  reveal: ParsedTx;
  commit: ParsedTx;
}

function inscribe(spec: EnvelopeSpec): Inscribed {
  const leaf = envelopeScript(spec, { checksigPrefix: true });
  const tap = taprootCommit(leaf);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script: leaf, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  return { id: `${reveal.txid}i0`, reveal, commit };
}

/** the id of an inscription, as the 32 bytes a tag-11 delegate field carries */
function delegateField(id: string): Uint8Array {
  return hexToBytes(id.slice(0, 64)).reverse();
}

function blockRoutes(block: TestBlock, height: number): Record<string, Route> {
  const routes: Record<string, Route> = {
    [`${E}/block/${block.blockHash}/header`]: block.headerHex,
    [`${E}/block/${block.blockHash}`]: { id: block.blockHash, height, tx_count: block.txCount },
    [`${E}/block/${block.blockHash}/raw`]: serializeBlock(hexToBytes(block.headerHex), block.txs),
  };
  for (const base of [E, E2, E3]) {
    routes[`${base}/block-height/${height}`] = block.blockHash;
    routes[`${base}/blocks/tip/height`] = String(height + 10);
  }
  const txids = block.txs.map((t) => t.txidLE);
  block.txs.forEach((tx, pos) => {
    routes[`${E}/tx/${tx.txid}/status`] = {
      confirmed: true,
      block_height: height,
      block_hash: block.blockHash,
    };
    routes[`${E}/tx/${tx.txid}/hex`] = bytesToHex(tx.raw);
    routes[`${E}/tx/${tx.txid}/merkle-proof`] = {
      block_height: height,
      merkle: buildMerkleBranch(txids, pos).map(internalToDisplay),
      pos,
    };
  });
  return routes;
}

/** B carries the body, A delegates to it and keeps a body of its own */
const DELEGATE = inscribe({ fields: [[1, 'text/html']], body: ['<h1>the delegate body</h1>'] });
const DELEGATING = inscribe({
  fields: [
    [1, 'text/plain'],
    [11, delegateField(DELEGATE.id)],
  ],
  body: ['the delegating body, which /content never serves'],
});
/**
 * Two blocks, so one inscription's evidence can be broken without touching the
 * other's. In one block a corrupted witness moves the block's own witness
 * root, which would break the addressed inscription's L3 proof along with the
 * delegate's and leave the test unable to say which one refused.
 */
const BLOCK_A = buildBlock([DELEGATING.reveal]);
const BLOCK_B = buildBlock([DELEGATE.reveal]);
const HEIGHT_B = BLOCK_HEIGHT + 1;

function delegateRoutes(): Record<string, Route> {
  const routes = {
    ...blockRoutes(BLOCK_A, BLOCK_HEIGHT),
    ...blockRoutes(BLOCK_B, HEIGHT_B),
  };
  for (const i of [DELEGATING, DELEGATE]) {
    routes[`${E}/tx/${i.commit.txid}/hex`] = bytesToHex(i.commit.raw);
  }
  return routes;
}

// ---------------------------------------------------------------------------

describe('SPEC-VERIFICATION conformance: anchoring, labelling, delegation', () => {
  // -------------------------------------------------------------------------
  // §2 Levels
  // -------------------------------------------------------------------------

  conformance('l0-label', async () => {
    const served = new TextEncoder().encode('bytes accepted as served');
    const id = DELEGATE.id;
    const gateway = new OrdResolver({
      ordGateways: [O],
      fetchFn: async (url: string) =>
        url === `${O}/r/undelegated-content/${id}`
          ? new Response(served.slice(), { headers: { 'content-type': 'text/plain' } })
          : new Response('no', { status: 404 }),
    });

    const l0 = await gateway.resolve(`ord:${id}`, { verification: 'none' });
    // labelled: the level it reached travels with the bytes
    expect(l0.verification.level).toBe('none');
    // and no chain context, so nothing in the report reads as verified
    expect(l0.verification.blockHash).toBeUndefined();
    expect(l0.verification.height).toBeUndefined();
    expect(l0.verification.integrityChecked).toBe(false);

    // the same field on a level that did establish chain context, so a label
    // that stopped varying would fail here rather than pass on one arm
    const verified = new OrdResolver({
      esplora: [E],
      fetchFn: stubFetch(delegateRoutes()),
      ...SYNTHETIC,
    });
    const l2 = await verified.resolve(`ord:${DELEGATE.id}`, { verification: 'L2' });
    expect(l2.verification.level).toBe('L2');
    expect(l2.verification.blockHash).toBe(BLOCK_B.blockHash);
    expect(l2.verification.height).toBe(HEIGHT_B);
  });

  // -------------------------------------------------------------------------
  // §4 Header anchoring
  // -------------------------------------------------------------------------

  conformance('checkpoint-refuse', async () => {
    // the compiled-in set, which a behavioural test alone would not notice
    // losing: the block holding inscription 0 is in it, and its hash is the
    // one the vendored header hashes to
    expect(MAINNET_CHECKPOINTS.get(CHECKPOINT_HEIGHT)).toBe(HEADER.hash);
    expect(MAINNET_CHECKPOINTS.size).toBeGreaterThanOrEqual(3);

    // outright: the async anchor refuses before it asks any attester, so an
    // agreeing majority cannot outvote a compiled-in hash
    const agreeing = [
      esplora('https://a.test', OTHER_HASH, CHECKPOINT_HEIGHT),
      esplora('https://b.test', OTHER_HASH, CHECKPOINT_HEIGHT),
    ];
    const trust = makeHeaderTrust({ esploras: agreeing });
    const relabelled = parseHeader(hexToBytes(bytesToHex(HEADER.raw)));
    await expect(trust(relabelled, CHECKPOINT_HEIGHT)).resolves.toMatchObject({
      checkpointHit: true,
      anchored: true,
      attests: 'hash-at-height',
      sourcesQueried: 0,
    });
    // and a header that is not the checkpoint's, at the checkpoint's height
    const impostor = parseHeader(hexToBytes(bytesToHex(HEADER.raw)).map((b, i) => (i === 76 ? b ^ 0xff : b)));
    await expect(trust(impostor, CHECKPOINT_HEIGHT)).rejects.toThrow(/contradicts checkpoint/);

    // the same pair through the synchronous hook the CLI hands the verifiers
    const hook = checkpointTrustHeader();
    expect(hook(HEADER, CHECKPOINT_HEIGHT)).toBe('hash-at-height');
    expect(() => hook(impostor, CHECKPOINT_HEIGHT)).toThrow(HeaderTrustError);
    expect(() => hook(impostor, CHECKPOINT_HEIGHT)).toThrow(/contradicts checkpoint/);
  });

  conformance('serving-excluded', async () => {
    // the arrangement that separates the two MUSTs: the serving endpoint
    // agrees, so a vote that merely ignored its opinion would still reach the
    // threshold on its count. It contributes neither
    const trust = makeHeaderTrust({
      esploras: [
        esplora('https://server.test', HEADER.hash),
        esplora('https://outsider.test', HEADER.hash),
      ],
      checkpoints: new Map(),
      proofSources: ['https://server.test'],
    });
    await expect(trust(HEADER, VOTED_HEIGHT)).rejects.toThrow(/not independently anchored/);
    await expect(trust(HEADER, VOTED_HEIGHT)).rejects.toThrow(/1 independent source/);

    // and the same vote with a second outsider in place of the server
    const outsiders = makeHeaderTrust({
      esploras: [
        esplora('https://server.test', HEADER.hash),
        esplora('https://outsider.test', HEADER.hash),
        esplora('https://another.test', HEADER.hash),
      ],
      checkpoints: new Map(),
      proofSources: ['https://server.test'],
    });
    await expect(outsiders(HEADER, VOTED_HEIGHT)).resolves.toMatchObject({
      anchored: true,
      independentSources: 2,
      builderIsSource: true,
      sourcesQueried: 2,
    });
  });

  conformance('operator-diversity', async () => {
    // two hostnames one party plainly runs are still two entries: nothing in
    // a hostname states who operates it, and the anchor infers nothing
    const sameOperator = makeHeaderTrust({
      esploras: [
        esplora('https://eu.one-operator.test', HEADER.hash),
        esplora('https://us.one-operator.test', HEADER.hash),
      ],
      checkpoints: new Map(),
    });
    await expect(sameOperator(HEADER, VOTED_HEIGHT)).resolves.toMatchObject({
      anchored: true,
      independentSources: 2,
    });

    // the other side of the bound: two spellings of ONE host are one entry,
    // which is all the canonical form is allowed to fold
    const spellings = makeHeaderTrust({
      esploras: [
        esplora('https://A.test', HEADER.hash),
        esplora('https://a.test./', HEADER.hash),
      ],
      checkpoints: new Map(),
    });
    await expect(spellings(HEADER, VOTED_HEIGHT)).rejects.toThrow(/not independently anchored/);
    await expect(spellings(HEADER, VOTED_HEIGHT)).rejects.toThrow(/of 1 attester/);
  });

  conformance('buckets-distinguish', async () => {
    // one attester in each state, in one call. Reported separately is the
    // requirement, so the two counts are read apart from each other
    const trust = makeHeaderTrust({
      esploras: [
        esplora('https://agrees.test', HEADER.hash),
        esplora('https://disagrees.test', OTHER_HASH),
        unreachable('https://silent.test'),
      ],
      checkpoints: new Map(),
      // the buckets are what this reads, so the threshold is set where the one
      // agreeing attester meets it and the call reaches its report
      minAgreement: 1,
      onDisagreement: 'flag',
    });
    const report = await trust(HEADER, VOTED_HEIGHT);
    expect(report.sourcesAgreed).toBe(1);
    expect(report.sourcesDisagreed).toBe(1);
    expect(report.sourcesUnreachable).toBe(1);
    expect(report.sourcesMalformed).toBe(0);
    // the accounting identity that keeps the four honest
    expect(
      report.sourcesAgreed +
        report.sourcesDisagreed +
        report.sourcesUnreachable +
        report.sourcesMalformed,
    ).toBe(report.sourcesQueried);
    // the disagreeing endpoint is named with what it said; the silent one has
    // nothing to name, which is the difference the sentence asks for
    expect(report.disagreements).toEqual([
      { baseUrl: 'https://disagrees.test', hash: OTHER_HASH },
    ]);
  });

  conformance('disagreement-refuse', async () => {
    // by default, and whatever the agreeing count is: two agree, one does not
    const trust = makeHeaderTrust({
      esploras: [
        esplora('https://a.test', HEADER.hash),
        esplora('https://b.test', HEADER.hash),
        esplora('https://c.test', OTHER_HASH),
      ],
      checkpoints: new Map(),
    });
    await expect(trust(HEADER, VOTED_HEIGHT)).rejects.toThrow(HeaderTrustDisagreementError);
    // the refusal names the contested height rather than the threshold, which
    // two agreeing attesters had already met
    await expect(trust(HEADER, VOTED_HEIGHT)).rejects.toThrow(
      new RegExp(`height ${VOTED_HEIGHT} is contested`),
    );
    await expect(trust(HEADER, VOTED_HEIGHT)).rejects.not.toThrow(/not independently anchored/);
  });

  conformance('flag-no-attestation', async () => {
    const contested = [
      esplora('https://a.test', HEADER.hash),
      esplora('https://b.test', HEADER.hash),
      esplora('https://c.test', OTHER_HASH),
    ];
    const flagged = await makeHeaderTrust({
      esploras: contested,
      checkpoints: new Map(),
      onDisagreement: 'flag',
    })(HEADER, VOTED_HEIGHT);
    // the opt-out records the disagreement and the call resolves
    expect(flagged.anchored).toBe(true);
    expect(flagged.sourcesDisagreed).toBe(1);
    // and asserts nothing about the pair another attester denies
    expect(flagged.attests).toBeUndefined();

    // the clean arm of the same anchor, where the assertion is made
    const clean = await makeHeaderTrust({
      esploras: contested.slice(0, 2),
      checkpoints: new Map(),
      onDisagreement: 'flag',
    })(HEADER, VOTED_HEIGHT);
    expect(clean.attests).toBe('hash-at-height');
  });

  // -------------------------------------------------------------------------
  // §6 Delegation and recursion
  // -------------------------------------------------------------------------

  conformance('delegate-both', async () => {
    for (const level of ['L2', 'L3'] as const) {
      const honest = new OrdResolver({
        esplora: [E],
        fetchFn: stubFetch(delegateRoutes()),
        ...SYNTHETIC,
      });
      const served = await honest.resolve(`ord:${DELEGATING.id}/content`, { verification: level });
      expect(new TextDecoder().decode(served.body), level).toBe('<h1>the delegate body</h1>');
      expect(served.viaDelegate, level).toBe(DELEGATE.id);
      // at the same level: the report describes the block of the bytes served,
      // which is the delegate's and not the addressed inscription's
      expect(served.verification.level, level).toBe(level);
      expect(served.verification.blockHash, level).toBe(BLOCK_B.blockHash);

      // now break the delegate's own evidence and nothing else. The backend
      // serves another block under the delegate's block hash, on both routes a
      // builder reads: the header at L2, the raw block at L3
      const corrupted = delegateRoutes();
      corrupted[`${E}/block/${BLOCK_B.blockHash}/header`] = BLOCK_A.headerHex;
      corrupted[`${E}/block/${BLOCK_B.blockHash}/raw`] = serializeBlock(
        hexToBytes(BLOCK_A.headerHex),
        BLOCK_A.txs,
      );
      const bad = new OrdResolver({
        esplora: [E],
        fetchFn: stubFetch(corrupted),
        ...SYNTHETIC,
      });
      await expect(
        bad.resolve(`ord:${DELEGATING.id}/content`, { verification: level }),
      ).rejects.toThrow();

      // and the delegating inscription's own referent still resolves off the
      // same backend, so the refusal above is the delegate's proof and not
      // the document
      const bare = await bad.resolve(`ord:${DELEGATING.id}`, { verification: level });
      expect(new TextDecoder().decode(bare.body), level).toContain('the delegating body');
    }
  });

  // -------------------------------------------------------------------------
  // the accounting: the whole-spec sum lives in the core file
  // -------------------------------------------------------------------------

  it('SPEC-VERIFICATION.md: this file speaks for exactly the fetch rows', () => {
    expect([...SPOKEN].sort()).toEqual(drivenIdsFor('fetch').sort());
    expect(idsFor('core').length).toBeGreaterThan(0);
    // the file holding the sum over both tables, named so the split cannot
    // quietly become two half-accountings
    expect(
      readFileSync(
        join(ROOT, 'packages/core/test/spec-verification.conformance.test.ts'),
        'utf8',
      ),
    ).toContain('every normative line is accounted for by a row in the table');
  });
});
