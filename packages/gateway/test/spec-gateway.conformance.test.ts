/**
 * Conformance suite for SPEC-GATEWAY.md: one test per normative sentence,
 * named for the sentence it speaks for.
 *
 * Quote-anchored, not line-anchored. Every row below carries a verbatim
 * fragment of its normative sentence, asserted to appear exactly once in the
 * spec file before the test that reads it runs, so a reworded requirement
 * fails its own test instead of leaving a green test speaking for a rule the
 * spec no longer states.
 *
 * Every normative line gets a row, tested or not. The accounting test at the
 * bottom derives the lines the rows claim from those fragments and compares
 * them against every MUST-bearing line in the file, so a requirement added to
 * the spec fails this suite until somebody accounts for it.
 *
 * Two requirements held here by accident rather than by intent, which is why
 * this file exists at all. §2's "MUST NOT emit `x-ord-verification` on that
 * replicated surface" holds because the proxy path copies exactly two header
 * names, and §2's "MUST emit attestation headers" holds by delegation to
 * `toResponse`. Both tests below are written against the observable header
 * set, so a widened allowlist or a changed delegation fails them.
 */

import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  internalToDisplay,
  buildMerkleBranch,
  serializeBlock,
  sha256,
  verifyProofBundle,
  type ParsedTx,
  type ProofBundleJson,
} from '@ordspv/core';
import type { FetchFn } from '@ordspv/fetch';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type EnvelopeSpec,
  type TestBlock,
} from '../../core/test/helpers.js';
import { createGateway, routeLabel } from '../src/index.js';

const SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/spec/SPEC-GATEWAY.md',
);
const SPEC = readFileSync(SPEC_PATH, 'utf8');

// ---------------------------------------------------------------------------
// the accounting table
// ---------------------------------------------------------------------------

/**
 * `tested here` and `tested at <where>` both mean a test asserts the
 * behaviour. `binds an external party` means no test in this repository can,
 * because the sentence binds somebody else's software. The fourth is the
 * outcome this suite was built to surface: a requirement with no code behind
 * it, whose test is reported rather than committed green.
 */
type Status =
  | 'tested here'
  | `tested at ${string}`
  | 'binds an external party, not testable in-repo'
  | `unimplemented, reported as a finding: ${string}`;

interface Requirement {
  /** stable handle used by the test that speaks for this row */
  id: string;
  /** spec section, for the test name */
  section: string;
  /** the requirement in a few words, for the test name */
  title: string;
  /** verbatim fragment of the normative sentence; must appear exactly once */
  quote: string;
  /** who the sentence binds */
  binds: string;
  status: Status;
  /** why the status is what it is, and what the test does not reach */
  why: string;
}

const TABLE: Requirement[] = [
  {
    id: 'proxy-no-attestation',
    section: '§2',
    title: 'a proxy gateway MUST NOT emit x-ord-verification on the replicated surface',
    quote:
      'proxy-personality gateway MUST NOT emit `x-ord-verification` on that replicated\n' +
      '  surface.',
    binds: 'proxy-personality gateways',
    status: 'tested here',
    why:
      'the upstream is made to emit the header on every path, so the test fails if the ' +
      'proxy ever copies more header names than the two it copies today. The narrowed ' +
      'MAY on the next sentence is pinned in the same test.',
  },
  {
    id: 'verify-attestation',
    section: '§2',
    title: 'a verify gateway MUST emit attestation headers',
    quote: 'MUST emit attestation headers (§5).',
    binds: 'verify-personality gateways',
    status: 'tested here',
    why:
      'asserted as the header set with its values, not as a call to toResponse, so a ' +
      'changed delegation fails it. The two conditional headers of §5 are driven under ' +
      'their conditions by the delegate case.',
  },
  {
    id: 'both-serve-proof',
    section: '§2',
    title: 'both personalities MUST serve /ord/v1/proof',
    quote: 'Both personalities MUST serve `/ord/v1/proof` (§3) if they advertise this spec.',
    binds: 'gateways of either personality',
    status: 'tested here',
    why: 'one bundle is fetched from each personality and verified client-side.',
  },
  {
    id: 'verify-before-serve',
    section: '§3',
    title: 'bundles MUST verify before being served, and a gateway MUST NOT relay what it cannot verify',
    quote:
      'Bundles MUST verify under SPEC-VERIFICATION before being served\n' +
      '  (a gateway MUST NOT relay bundles it cannot verify).',
    binds: 'gateways',
    status: 'tested here',
    why:
      'thin by design: gateway-relay.props.test.ts drives this requirement harder, ' +
      'across both personalities and the LRU. The row is here for traceability.',
  },
  {
    id: 'content-headers',
    section: '§4',
    title: 'content responses MUST include the ord-parity headers',
    quote: 'responses MUST include:',
    binds: 'gateways',
    status: 'tested here',
    why:
      'every bullet under the sentence is asserted: content type from the envelope and ' +
      'its fallback, cache-control, both CSP policies, and the ACAO header.',
  },
  {
    id: 'encoding-406',
    section: '§4',
    title: 'a gateway MUST return 406 when it neither decompresses nor may send the stored encoding',
    quote: '`--decompress` parity) and otherwise MUST return `406`;',
    binds: 'gateways',
    status:
      'unimplemented, reported as a finding: no 406 exists anywhere in packages/gateway/src',
    why:
      'the verify path serves stored encoded bytes with Content-Encoding whatever the ' +
      'request admits, so a client sending `Accept-Encoding: identity` receives 200 and ' +
      'bytes it did not agree to decode. Reachable whenever the tag-9 encoding is one ' +
      'the decompressor does not handle, or when decoding a recognized one fails. The ' +
      'test is written and reported rather than committed, per the brief protocol.',
  },
  {
    id: 'consumer-encoding',
    section: '§4',
    title: 'consumers MUST determine the encoding from the envelope and MUST NOT infer it from transport',
    quote:
      "- Consumers MUST determine an inscription's encoding from the envelope parse\n" +
      '  (tag 9), via a proof bundle, their own reveal-tx parse, or the\n' +
      '  `x-ord-content-encoding` attestation header (§5), and MUST NOT infer it from\n' +
      '  `Content-Encoding` or any other transport header.',
    binds: 'consumers of gateway responses, this repository included',
    status:
      'unimplemented, reported as a finding: OrdResolver at L0/L1 copies the transport header',
    why:
      'the sentence binds consumers, and this repository ships one: the resolver reading ' +
      'an ord server at L0/L1. It reports `contentEncoding` straight off the response ' +
      'header, in a field documented as the on-chain encoding, and never reads the ' +
      '`x-ord-content-encoding` channel §5 exists to provide. The verified paths take ' +
      'their encoding from the envelope parse and are not affected.',
  },
  {
    id: 'attestation-source',
    section: '§5',
    title: 'x-ord-content-encoding MUST be sourced from the envelope parse',
    quote:
      'It MUST be sourced from the\n' +
      "gateway's own envelope parse of the verified reveal tx (never copied from an\n" +
      'upstream response)',
    binds: 'gateways',
    status: 'tested here',
    why:
      'the served bytes and the transport header are made to disagree with the tag-9 ' +
      'value, and the SERVED source clause is driven through a delegate whose envelope ' +
      'declares the encoding while the addressed inscription declares none.',
  },
  {
    id: 'clients-ignore',
    section: '§5',
    title: 'clients with adversarial gateways MUST ignore attestation headers',
    quote: 'clients with adversarial gateways in their threat model MUST ignore them and verify',
    binds: 'clients of a gateway',
    status: 'binds an external party, not testable in-repo',
    why:
      'a rule about what somebody else does with headers this repository emits; no ' +
      'behaviour of this code can satisfy or violate it. What compliance looks like is ' +
      'the L2+ path, which reads no x-ord-* header from any response and verifies the ' +
      'bundle itself: that is the verify-before-serve row above, and resolver.test.ts.',
  },
  {
    id: 'tier-documentation',
    section: '§6',
    title: 'a gateway exposing /r/* MUST document, per endpoint, which tier it serves',
    quote: 'A gateway exposing `/r/*` MUST document, per endpoint, which tier it serves:',
    binds: 'gateway operators, through their documentation',
    status: 'tested here',
    why:
      'a documentation obligation, discharged for the reference implementation by the ' +
      'tier table this sentence introduces. What is asserted is that the table stays ' +
      'usable: both tiers non-empty, no endpoint in both, and every endpoint named is ' +
      'one this gateway actually routes. What no test can assert is that a third-party ' +
      'deployment published the tiers it serves.',
  },
  {
    id: 'tier-b-unverified',
    section: '§6',
    title: 'Tier B responses MUST NOT carry x-ord-verification',
    quote: 'claims and MUST NOT carry `x-ord-verification`.',
    binds: 'gateways',
    status: 'tested here',
    why:
      'every Tier B endpoint named in the spec is requested from a verify-personality ' +
      'gateway, the personality that emits the header elsewhere, against an upstream ' +
      'that sets it on every response.',
  },
];

// ---------------------------------------------------------------------------
// quote anchoring
// ---------------------------------------------------------------------------

/** 1-based line numbers the fragment spans, or a reason it does not anchor. */
function anchor(quote: string): { first: number; last: number } {
  const at = SPEC.indexOf(quote);
  if (at === -1) {
    throw new Error(
      `SPEC-GATEWAY.md no longer contains this fragment, so the requirement moved or was ` +
        `reworded and its test speaks for nothing:\n${quote}`,
    );
  }
  if (SPEC.indexOf(quote, at + 1) !== -1) {
    throw new Error(
      `fragment appears more than once in SPEC-GATEWAY.md, so it anchors nothing:\n${quote}`,
    );
  }
  const first = SPEC.slice(0, at).split('\n').length;
  return { first, last: first + quote.split('\n').length - 1 };
}

function row(id: string): Requirement {
  const found = TABLE.find((r) => r.id === id);
  if (!found) throw new Error(`no accounting row with id ${id}`);
  return found;
}

function conformance(id: string, body: () => void | Promise<void>): void {
  const r = row(id);
  it(`SPEC-GATEWAY.md ${r.section}: ${r.title}`, async () => {
    anchor(r.quote);
    await body();
  });
}

// ---------------------------------------------------------------------------
// fixtures: one synthetic block, three inscriptions, two gateways
// ---------------------------------------------------------------------------

const E = 'https://esplora.test';
const E2 = 'https://esplora2.test';
const E3 = 'https://esplora3.test';
const U = 'https://upstream.test';
const HEIGHT = 100;

type Route = string | Uint8Array | object;

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

const PNG_BODY = 'a plain inscription body';
/** the ordinary case: content type, a body, no delegation and no encoding */
const PLAIN = inscribe({ fields: [[1, 'text/plain']], body: [PNG_BODY] });
/** no tag 1 at all, so the served content type is the spec's fallback */
const UNTYPED = inscribe({ body: ['no content type on this one'] });
/** the delegate declares the encoding; the inscription addressed declares none */
const ENCODED_DELEGATE = inscribe({
  fields: [
    [1, 'text/plain'],
    [9, 'x-unknown-42'],
  ],
  body: ['stored bytes nothing decodes'],
});
const DELEGATING = inscribe({ fields: [[11, delegateField(ENCODED_DELEGATE.id)]] });

const BLOCK = buildBlock([PLAIN.reveal, UNTYPED.reveal, ENCODED_DELEGATE.reveal, DELEGATING.reveal]);
const CHAIN_ROUTES: Record<string, Route> = blockRoutes(BLOCK, HEIGHT);
for (const i of [PLAIN, UNTYPED, ENCODED_DELEGATE, DELEGATING]) {
  CHAIN_ROUTES[`${E}/tx/${i.commit.txid}/hex`] = bytesToHex(i.commit.raw);
}

/**
 * An upstream ord server that claims verification on every response. Nothing
 * a gateway proxies from it may carry that claim onward.
 */
const LYING_UPSTREAM_HEADERS = {
  'content-type': 'text/plain',
  'x-ord-verification': 'L3',
  'x-ord-block': 'not a block hash',
  'x-ord-content-encoding': 'gzip',
};

function stub(routes: Record<string, Route>): FetchFn {
  return async (url: string) => {
    if (url.startsWith(U)) {
      return new Response(`upstream body for ${url.slice(U.length)}`, {
        headers: LYING_UPSTREAM_HEADERS,
      });
    }
    const route = routes[url];
    if (route === undefined) return new Response(`no stub for ${url}`, { status: 404 });
    if (route instanceof Uint8Array) return new Response(route.slice());
    if (typeof route === 'string') return new Response(route);
    return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
  };
}

function gateway(mode: 'proxy' | 'verify') {
  return createGateway({
    upstream: U,
    esplora: [E],
    anchorSources: [E2, E3],
    mode,
    // synthetic blocks are mined at regtest difficulty
    powLimitBits: null,
    fetchFn: stub(CHAIN_ROUTES),
  });
}

/** Listen on an ephemeral port for the life of one describe block. */
function serve(server: ReturnType<typeof createGateway>): () => string {
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return () => base;
}

// ---------------------------------------------------------------------------

describe('SPEC-GATEWAY conformance', () => {
  const verify = serve(gateway('verify'));
  const proxy = serve(gateway('proxy'));

  // -------------------------------------------------------------------------
  // §2 Personalities
  // -------------------------------------------------------------------------

  conformance('proxy-no-attestation', async () => {
    // the upstream claims L3 on every response it serves, so a proxy that
    // copied one header too many would be caught here rather than in the wild
    for (const path of [
      `/content/${PLAIN.id}`,
      `/r/undelegated-content/${PLAIN.id}`,
      `/r/metadata/${PLAIN.id}`,
      '/r/blockheight',
      '/blockheight',
    ]) {
      const res = await fetch(`${proxy()}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('upstream body');
      expect(res.headers.get('x-ord-verification'), path).toBeNull();
      expect(res.headers.get('x-ord-block'), path).toBeNull();
      expect(res.headers.get('x-ord-content-encoding'), path).toBeNull();
    }

    // the narrowed MAY on the next sentence: /ord/v1/verified verifies locally
    // in either personality, so the header there reports work this gateway did
    const verified = await fetch(`${proxy()}/ord/v1/verified/${PLAIN.id}`);
    expect(verified.status).toBe(200);
    expect(verified.headers.get('x-ord-verification')).toBe('L2');
    expect(await verified.text()).toBe(PNG_BODY);
  });

  conformance('verify-attestation', async () => {
    const res = await fetch(`${verify()}/content/${PLAIN.id}`);
    expect(res.status).toBe(200);
    // §5's unconditional headers, with the values they attest to
    expect(res.headers.get('x-ord-verification')).toBe('L2');
    expect(res.headers.get('x-ord-block')).toBe(BLOCK.blockHash);
    expect(res.headers.get('x-ord-height')).toBe(String(HEIGHT));
    expect(res.headers.get('x-ord-body-sha256')).toBe(
      bytesToHex(sha256(new TextEncoder().encode(PNG_BODY))),
    );

    // §5's two conditional headers, under their conditions
    const delegated = await fetch(`${verify()}/content/${DELEGATING.id}`);
    expect(delegated.status).toBe(200);
    expect(delegated.headers.get('x-ord-delegate')).toBe(ENCODED_DELEGATE.id);
    expect(delegated.headers.get('x-ord-content-encoding')).toBe('x-unknown-42');
  });

  conformance('both-serve-proof', async () => {
    for (const [personality, base] of [
      ['verify', verify()],
      ['proxy', proxy()],
    ] as const) {
      const res = await fetch(`${base}/ord/v1/proof/${PLAIN.id}?level=l2`);
      expect(res.status, personality).toBe(200);
      expect(res.headers.get('content-type'), personality).toContain(
        'application/vnd.ord.proof+json',
      );
      const bundle = (await res.json()) as ProofBundleJson;
      // it is a proof only if the client can check it without asking again
      const checked = verifyProofBundle(bundle, { powLimitBits: null });
      expect(checked.inscription.contentType, personality).toBe('text/plain');
    }
  });

  // -------------------------------------------------------------------------
  // §3 Proof endpoint
  // -------------------------------------------------------------------------

  conformance('verify-before-serve', async () => {
    // one endpoint answers 200 with a body that is not a block header, which
    // is what a CDN error page looks like from here. No malice required
    const broken = { ...CHAIN_ROUTES };
    broken[`${E}/block/${BLOCK.blockHash}/header`] = '<html>502 Bad Gateway</html>';
    const server = createGateway({
      upstream: U,
      esplora: [E],
      mode: 'verify',
      powLimitBits: null,
      fetchFn: stub(broken),
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/ord/v1/proof/${PLAIN.id}`);
      expect(res.status).not.toBe(200);
      // and whatever it did answer is not a bundle asserting it was verified
      expect(res.headers.get('content-type')).not.toContain('vnd.ord.proof');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // -------------------------------------------------------------------------
  // §4 ord-parity response headers
  // -------------------------------------------------------------------------

  conformance('content-headers', async () => {
    const res = await fetch(`${verify()}/content/${PLAIN.id}`);
    expect(res.status).toBe(200);
    // Content-Type from the envelope
    expect(res.headers.get('content-type')).toBe('text/plain');
    // Cache-Control, the immutable form the same section names
    expect(res.headers.get('cache-control')).toBe('public, max-age=1209600, immutable');
    // both ord CSP policies, in one comma-separated header
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self' 'unsafe-eval' 'unsafe-inline' data: blob:");
    expect(csp).toContain('*:*/content/ *:*/blockheight *:*/blockhash');
    // Access-Control-Allow-Origin
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    // "falling back to application/octet-stream" for an envelope with no tag 1
    const untyped = await fetch(`${verify()}/content/${UNTYPED.id}`);
    expect(untyped.status).toBe(200);
    expect(untyped.headers.get('content-type')).toBe('application/octet-stream');
  });

  // -------------------------------------------------------------------------
  // §5 Attestation headers
  // -------------------------------------------------------------------------

  conformance('attestation-source', async () => {
    // the addressed inscription declares no encoding and the delegate does, so
    // a header taken from the wrong envelope would be absent rather than wrong
    const res = await fetch(`${verify()}/content/${DELEGATING.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ord-content-encoding')).toBe('x-unknown-42');
    // never copied from an upstream response: the upstream claims gzip on
    // everything it serves, and this path does not consult it at all
    expect(LYING_UPSTREAM_HEADERS['x-ord-content-encoding']).toBe('gzip');
    // and the same value on a served source that is the addressed inscription
    const direct = await fetch(`${verify()}/content/${ENCODED_DELEGATE.id}`);
    expect(direct.headers.get('x-ord-content-encoding')).toBe('x-unknown-42');
    // an inscription whose envelope declares nothing gets no attestation
    const plain = await fetch(`${verify()}/content/${PLAIN.id}`);
    expect(plain.headers.get('x-ord-content-encoding')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // §6 Recursion endpoint tiers
  // -------------------------------------------------------------------------

  /** the endpoints named in one tier bullet of §6, read out of the spec */
  function tier(name: 'Tier A' | 'Tier B'): string[] {
    const start = SPEC.indexOf(`**${name},`);
    expect(start, `${name} is no longer a bullet in SPEC-GATEWAY.md §6`).toBeGreaterThan(0);
    const end = SPEC.indexOf('\n- ', start);
    const bullet = SPEC.slice(start, end === -1 ? undefined : end);
    return (bullet.match(/`\/[^`]+`/g) ?? []).map((s) => s.slice(1, -1));
  }

  conformance('tier-documentation', () => {
    const a = tier('Tier A');
    const b = tier('Tier B');
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // per endpoint: one tier each, or the table documents nothing usable
    for (const endpoint of a) expect(b, `${endpoint} is in both tiers`).not.toContain(endpoint);

    // and every documented endpoint is one this gateway actually routes, so
    // the tier table cannot document a surface the reference implementation
    // does not serve, nor miss one it does
    for (const endpoint of [...a, ...b]) {
      const concrete = endpoint
        .replace('[/h]', '/840000')
        .replace('<txid>', 'ab'.repeat(32))
        .replace('<id>', `${'ab'.repeat(32)}i0`)
        .replace(/\*$/, 'x');
      expect(routeLabel(concrete), `${endpoint} is documented but not routed`).not.toBe('other');
    }
  });

  conformance('tier-b-unverified', async () => {
    // the verify personality is the one that emits the header at all, and the
    // upstream behind it claims L3 on every response
    for (const endpoint of tier('Tier B')) {
      const path = endpoint
        .replace('<id>', `${'ab'.repeat(32)}i0`)
        .replace(/\*$/, 'something');
      const res = await fetch(`${verify()}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-ord-verification'), path).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // the accounting
  // -------------------------------------------------------------------------

  it('SPEC-GATEWAY.md: every normative line is accounted for by a row in this file', () => {
    const lines = SPEC.split('\n');
    const normative = lines
      .map((text, i) => ({ line: i + 1, text }))
      .filter((l) => l.text.includes('MUST'));

    const claimed = new Map<number, string>();
    for (const r of TABLE) {
      const { first, last } = anchor(r.quote);
      for (let line = first; line <= last; line++) {
        if (!lines[line - 1].includes('MUST')) continue;
        const already = claimed.get(line);
        expect(already, `line ${line} is claimed by both ${already} and ${r.id}`).toBeUndefined();
        claimed.set(line, r.id);
      }
    }

    const unaccounted = normative
      .filter((l) => !claimed.has(l.line))
      .map((l) => `  ${l.line}: ${l.text.trim()}`);
    expect(
      unaccounted,
      `SPEC-GATEWAY.md states requirements no row in this file accounts for:\n${unaccounted.join('\n')}`,
    ).toEqual([]);

    expect(claimed.size).toBe(normative.length);
  });

  it('SPEC-GATEWAY.md: the table says how each requirement is covered', () => {
    for (const r of TABLE) {
      expect(r.why.length, `${r.id} has no reasoning`).toBeGreaterThan(20);
      expect(r.binds.length, `${r.id} does not say who it binds`).toBeGreaterThan(0);
      expect(r.title, `${r.id} is not named for its requirement`).toMatch(/MUST/);
    }
    // the rows this suite does not assert, kept visible rather than counted:
    // a reader of the list below sees the coverage gap without reading the file
    const notTested = TABLE.filter((r) => r.status !== 'tested here').map((r) => r.id);
    expect(notTested).toEqual([
      'encoding-406',
      'consumer-encoding',
      'clients-ignore',
    ]);
  });
});
