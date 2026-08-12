import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHeader, hexToBytes } from '@ordspv/core';
import {
  checkpointTrustHeader,
  EsploraBackend,
  HeaderTrustDisagreementError,
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
    const common = {
      esploras: [builder, honest1, honest2],
      checkpoints: new Map<number, string>(),
      proofSource: 'https://builder.test',
    };
    // both honest endpoints answering another block is a contested height
    // before it is a failed vote, and that is what the default reports
    await expect(makeHeaderTrust(common)(HEADER, HEIGHT)).rejects.toThrow(/is contested/);
    // the exclusion itself, read through the arm that still counts: flagging
    // the disagreement leaves one agreeing attester short of the threshold,
    // because the builder's own agreement was never in the count
    await expect(
      makeHeaderTrust({ ...common, onDisagreement: 'flag' })(HEADER, HEIGHT),
    ).rejects.toThrow(/not independently anchored: 0 independent source/);
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
});

/**
 * An attester that answers and disagrees is not an attester that said
 * nothing. Both used to arrive as the complement of the agreeing count, so
 * three states of the world (down, serving another chain, serving an error
 * page under HTTP 200) produced byte-identical reports.
 */
describe('what an attester answered, bucket by bucket', () => {
  const OTHER = 'f'.repeat(64);
  const builder = () => esplora('https://builder.test', {});
  const common = {
    checkpoints: new Map<number, string>(),
    proofSource: 'https://builder.test',
  };
  const agrees = (base: string) => esplora(base, agreeRoutes(base, HEADER.hash));
  const denies = (base: string) => esplora(base, agreeRoutes(base, OTHER));
  /** answers /block-height with exactly this text, whatever it is */
  const says = (base: string, body: string) => esplora(base, agreeRoutes(base, body));
  /** no route at all, so every query rejects */
  const down = (base: string) => esplora(base, {});

  it('reports every source it queried in exactly one bucket', async () => {
    const report = await makeHeaderTrust({
      ...common,
      esploras: [
        builder(),
        agrees('https://a1.test'),
        agrees('https://a2.test'),
        down('https://d1.test'),
        says('https://m1.test', '<html>bad gateway</html>'),
      ],
      onDisagreement: 'flag',
    })(HEADER, HEIGHT);
    expect(report.sourcesQueried).toBe(4); // the builder is not asked
    expect(report.sourcesAgreed).toBe(2);
    expect(report.sourcesUnreachable).toBe(1);
    expect(report.sourcesMalformed).toBe(1);
    expect(report.sourcesDisagreed).toBe(0);
    expect(
      report.sourcesAgreed +
        report.sourcesDisagreed +
        report.sourcesMalformed +
        report.sourcesUnreachable,
    ).toBe(report.sourcesQueried);
  });

  it('holds the accounting on the arms that query nobody', async () => {
    // the checkpoint arm and a call with no attesters configured both report
    // zeroes rather than leaving a reader to infer the shape from absence
    for (const report of [
      await makeHeaderTrust({ esploras: [] })(HEADER, HEIGHT), // 767430 is compiled in
      await makeHeaderTrust({ ...common, esploras: [builder()], minAgreement: 1 })(
        HEADER,
        HEIGHT,
      ).catch((e: Error) => e),
    ]) {
      if (report instanceof Error) {
        expect(report.message).toMatch(/of 0 attester\(s\), 0 agreed/);
        continue;
      }
      expect(report.sourcesDisagreed).toBe(0);
      expect(report.sourcesUnreachable).toBe(0);
      expect(report.sourcesMalformed).toBe(0);
      expect(report.disagreements).toEqual([]);
      expect(report.malformed).toEqual([]);
      expect(
        report.sourcesAgreed +
          report.sourcesDisagreed +
          report.sourcesMalformed +
          report.sourcesUnreachable,
      ).toBe(report.sourcesQueried);
    }
  });

  it('refuses a height a majority of attesters names another block at', async () => {
    // the threshold is met by two, four contradict them, and the old code
    // reported the header anchored with the contradiction nowhere in sight.
    // Reachable on the shipped defaults: DEFAULT_ANCHOR_SOURCES holds five
    // endpoints and minAgreement is 2
    const trust = makeHeaderTrust({
      ...common,
      esploras: [
        builder(),
        agrees('https://a1.test'),
        agrees('https://a2.test'),
        denies('https://d1.test'),
        denies('https://d2.test'),
        denies('https://d3.test'),
        denies('https://d4.test'),
      ],
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(HeaderTrustDisagreementError);
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/4 attester\(s\) name another block/);
    // every disagreeing endpoint and the hash it served
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(
      new RegExp(`https://d4.test says ${OTHER}`),
    );
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/2 attester\(s\) agreed/);
  });

  it('refuses a single disagreement while the threshold is met', async () => {
    const trust = makeHeaderTrust({
      ...common,
      esploras: [builder(), agrees('https://a1.test'), agrees('https://a2.test'), denies('https://d1.test')],
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(HeaderTrustDisagreementError);
  });

  it('is caught by a caller already catching HeaderTrustError', async () => {
    // subclassing is the compatibility contract: existing callers test the
    // base class and must keep seeing this refusal
    const trust = makeHeaderTrust({
      ...common,
      esploras: [builder(), agrees('https://a1.test'), agrees('https://a2.test'), denies('https://d1.test')],
    });
    const thrown = await trust(HEADER, HEIGHT).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(HeaderTrustError);
    expect(thrown).toBeInstanceOf(HeaderTrustDisagreementError);
  });

  it('flags a disagreement, keeps anchored, and withholds the attestation', async () => {
    // an operator who knows one of their endpoints lags opts out by name; the
    // agreeing attesters did meet the threshold, so anchored stays true and
    // the disagreement travels as its own counts. The contested pair asserts
    // nothing, so a sub-BIP34 coinbase height under this anchor is refused
    const report = await makeHeaderTrust({
      ...common,
      esploras: [builder(), agrees('https://a1.test'), agrees('https://a2.test'), denies('https://d1.test')],
      onDisagreement: 'flag',
    })(HEADER, HEIGHT);
    expect(report.anchored).toBe(true);
    expect(report.attests).toBeUndefined();
    expect(report.sourcesDisagreed).toBe(1);
    expect(report.disagreements).toEqual([{ baseUrl: 'https://d1.test', hash: OTHER }]);
    expect(report.independentSources).toBe(2);
    // an uncontested vote still attests, so the withholding is the
    // disagreement's doing and not the flag's
    const clean = await makeHeaderTrust({
      ...common,
      esploras: [builder(), agrees('https://a1.test'), agrees('https://a2.test')],
      onDisagreement: 'flag',
    })(HEADER, HEIGHT);
    expect(clean.attests).toBe('hash-at-height');
  });

  it('reads a 200 carrying a non-hash body as malformed, not as a disagreement', async () => {
    // an endpoint serving an error page is broken, and calling it a competing
    // claim would refuse a height nobody contested
    const report = await makeHeaderTrust({
      ...common,
      esploras: [
        builder(),
        agrees('https://a1.test'),
        agrees('https://a2.test'),
        says('https://m1.test', '<html>bad gateway</html>'),
      ],
    })(HEADER, HEIGHT);
    expect(report.sourcesMalformed).toBe(1);
    expect(report.sourcesDisagreed).toBe(0);
    expect(report.attests).toBe('hash-at-height');
    // the source and the length, never the body: that text is attacker
    // controlled and would land in somebody's log
    expect(report.malformed).toEqual([{ baseUrl: 'https://m1.test', length: 24 }]);
    expect(JSON.stringify(report)).not.toContain('bad gateway');
  });

  it('reads a truncated or overlong hex answer as malformed', async () => {
    for (const [body, length] of [
      ['', 0],
      ['f'.repeat(63), 63],
      ['f'.repeat(65), 65],
      ['g'.repeat(64), 64],
    ] as const) {
      const report = await makeHeaderTrust({
        ...common,
        esploras: [builder(), agrees('https://a1.test'), agrees('https://a2.test'), says('https://m1.test', body)],
      })(HEADER, HEIGHT);
      expect(report.malformed, body).toEqual([{ baseUrl: 'https://m1.test', length }]);
    }
  });

  it('reads an upper-case answer as the same hash rather than as malformed', async () => {
    // the answer is trimmed and lowercased before it is compared, and the
    // shape check has to run on the same normalized form
    const report = await makeHeaderTrust({
      ...common,
      esploras: [
        builder(),
        agrees('https://a1.test'),
        says('https://a2.test', `  ${HEADER.hash.toUpperCase()}\n`),
      ],
    })(HEADER, HEIGHT);
    expect(report.sourcesAgreed).toBe(2);
    expect(report.sourcesMalformed).toBe(0);
  });

  it('names the breakdown when the threshold is not met', async () => {
    // "N/M attesters agreed" read the same whether the missing endpoints were
    // unreachable or were serving another chain
    const trust = makeHeaderTrust({
      ...common,
      esploras: [
        builder(),
        agrees('https://a1.test'),
        denies('https://d1.test'),
        down('https://x1.test'),
        says('https://m1.test', 'nope'),
      ],
      onDisagreement: 'flag',
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(
      /of 4 attester\(s\), 1 agreed, 1 named another block, 1 answered no block hash, 1 did not answer/,
    );
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/1 serving backend\(s\) excluded/);
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(
      /https:\/\/m1.test answered 4 characters that are no block hash/,
    );
    await expect(trust(HEADER, HEIGHT)).rejects.not.toThrow(/nope/);
  });

  it('lets the checkpoint arm settle a height before any attester is asked', async () => {
    // 767430 is compiled in, so the vote never runs and a disagreeing
    // attester at that height changes nothing
    const report = await makeHeaderTrust({ esploras: [denies('https://d1.test')] })(HEADER, HEIGHT);
    expect(report.checkpointHit).toBe(true);
    expect(report.sourcesQueried).toBe(0);
    expect(report.sourcesDisagreed).toBe(0);
    // and a header contradicting the checkpoint still fails on the checkpoint
    await expect(
      makeHeaderTrust({
        esploras: [denies('https://d1.test')],
        checkpoints: new Map([[HEIGHT, OTHER]]),
      })(HEADER, HEIGHT),
    ).rejects.toThrow(/contradicts checkpoint/);
  });
});

describe('the confirmation-depth phase', () => {
  const builder = () => esplora('https://builder.test', {});
  const common = {
    checkpoints: new Map<number, string>(),
    proofSource: 'https://builder.test',
  };

  /** agrees on the hash, answers the tip endpoint with exactly this text */
  const tipSaying = (base: string, tip: string) =>
    esplora(base, {
      [`${base}/block-height/${HEIGHT}`]: HEADER.hash,
      [`${base}/blocks/tip/height`]: tip,
    });

  /** agrees on the hash, has no tip endpoint at all */
  const noTip = (base: string) =>
    esplora(base, { [`${base}/block-height/${HEIGHT}`]: HEADER.hash });

  it('refuses when a depth is requested and every tip query fails', async () => {
    // the fail-open case: the depth went unenforced, the report carried no
    // tipHeight to say so, and the call resolved as anchored
    const trust = makeHeaderTrust({
      ...common,
      esploras: [builder(), noTip('https://h1.test'), noTip('https://h2.test')],
      minConfirmations: 6,
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(HeaderTrustError);
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/no attester stated a usable tip height/);
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/2 queried, 0 answered/);
  });

  it('drops a garbage tip in either ordering of the same two attesters', async () => {
    // Number('nonsense') is NaN, the comparator returns NaN, and sort leaves
    // the pair where it found it, so the median landed on the garbage or not
    // depending on which attester came first. The two orderings disagreed
    const good = () => tipSaying('https://good.test', String(HEIGHT + 2));
    const bad = () => tipSaying('https://bad.test', 'nonsense');
    for (const esploras of [
      [builder(), bad(), good()],
      [builder(), good(), bad()],
    ]) {
      const report = await makeHeaderTrust({ ...common, esploras, minConfirmations: 3 })(HEADER, HEIGHT);
      expect(report.tipHeight).toBe(HEIGHT + 2);
      expect(report.tipsQueried).toBe(2);
      expect(report.tipsAnswered).toBe(1);
      await expect(
        makeHeaderTrust({ ...common, esploras, minConfirmations: 6 })(HEADER, HEIGHT),
      ).rejects.toThrow(/only 3 confirmations/);
    }
  });

  it('reads an empty tip response as no answer rather than height zero', async () => {
    // Number('') is 0, so an empty body used to read as tip height zero and
    // produce "only -767429 confirmations", blaming depth for a bad answer
    const trust = makeHeaderTrust({
      ...common,
      esploras: [builder(), tipSaying('https://h1.test', ''), tipSaying('https://h2.test', '')],
      minConfirmations: 6,
    });
    await expect(trust(HEADER, HEIGHT)).rejects.toThrow(/no attester stated a usable tip height/);
    await expect(trust(HEADER, HEIGHT)).rejects.not.toThrow(/confirmations, need/);
  });

  it('reads a negative or fractional tip as no answer', async () => {
    for (const junk of ['-1', '1.5', '0x10', '1e6', ' ']) {
      const trust = makeHeaderTrust({
        ...common,
        esploras: [builder(), tipSaying('https://h1.test', junk), tipSaying('https://h2.test', junk)],
        minConfirmations: 6,
      });
      await expect(trust(HEADER, HEIGHT), junk).rejects.toThrow(/0 answered/);
    }
  });

  it('reports the tip counts only on the arm that queried tips', async () => {
    const esploras = [builder(), tipSaying('https://h1.test', String(HEIGHT + 10)), tipSaying('https://h2.test', String(HEIGHT + 10))];
    const enforced = await makeHeaderTrust({ ...common, esploras, minConfirmations: 6 })(HEADER, HEIGHT);
    expect(enforced.tipsQueried).toBe(2);
    expect(enforced.tipsAnswered).toBe(2);
    expect(enforced.tipHeight).toBe(HEIGHT + 10);

    // no depth requested: the phase never runs, and absent counts say that
    // rather than claiming zero answers to a query nobody made
    const skipped = await makeHeaderTrust({ ...common, esploras })(HEADER, HEIGHT);
    expect(skipped.tipsQueried).toBeUndefined();
    expect(skipped.tipsAnswered).toBeUndefined();
    expect(skipped.tipHeight).toBeUndefined();

    // a checkpoint returns above the phase entirely
    const checkpointed = await makeHeaderTrust({ esploras: [], minConfirmations: 6 })(HEADER, HEIGHT);
    expect(checkpointed.checkpointHit).toBe(true);
    expect(checkpointed.tipsQueried).toBeUndefined();
  });

  it('refuses a depth that is not a whole number of blocks', async () => {
    // the same reach as the minAgreement guard: Number(process.env.X) is NaN,
    // NaN is falsy, and the whole phase was skipped for a caller who asked
    // for a floor
    expect(() => makeHeaderTrust({ minConfirmations: Number.NaN })).toThrow(HeaderTrustError);
    expect(() => makeHeaderTrust({ minConfirmations: Number.NaN })).toThrow(
      /minConfirmations NaN is not a whole number of blocks/,
    );
    expect(() => makeHeaderTrust({ minConfirmations: -1 })).toThrow(/pass an integer of 0 or more/);
    expect(() => makeHeaderTrust({ minConfirmations: 6.5 })).toThrow(
      /minConfirmations 6.5 is not a whole number/,
    );
    // 0 is the documented way to enforce no depth, and the default stands
    expect(() => makeHeaderTrust({ minConfirmations: 0 })).not.toThrow();
    expect(() => makeHeaderTrust({})).not.toThrow();
  });

  it('queries no tip at all for a depth of zero', async () => {
    const trust = makeHeaderTrust({
      ...common,
      esploras: [builder(), noTip('https://h1.test'), noTip('https://h2.test')],
      minConfirmations: 0,
    });
    const report = await trust(HEADER, HEIGHT);
    expect(report.anchored).toBe(true);
    expect(report.tipsQueried).toBeUndefined();
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
