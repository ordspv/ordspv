/**
 * Conformance suite for SPEC-URI.md: one test per normative sentence, named
 * for the sentence it speaks for.
 *
 * Three rules make this more than a second copy of the resolver tests.
 *
 * Quote-anchored, not line-anchored. Every row below carries a verbatim
 * fragment of its normative sentence, and the fragment is asserted to still
 * appear exactly once in the spec file before the test that reads it runs. A
 * spec edit that rewords or moves a requirement fails its own test until the
 * pair is updated together, so the suite and the spec cannot drift apart in
 * silence.
 *
 * Every normative line gets a row, tested or not. The accounting test at the
 * bottom derives the set of lines the rows claim from those fragments and
 * compares it against every MUST-bearing line in the file, so a requirement
 * added to the spec fails this suite until somebody accounts for it. Silent
 * non-coverage is the failure mode the suite exists to end.
 *
 * Duplication with the rest of the suite is deliberate. resolver.test.ts
 * covers several of these behaviours already and covers them harder; the job
 * here is traceability from the sentence to a test, so a thin re-assertion is
 * the normal case and a `tested at` row is for where a thin one would be
 * disproportionate.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  internalToDisplay,
  buildMerkleBranch,
  serializeBlock,
  sha256,
  type ParsedTx,
} from '@ordspv/core';
import { OrdResolver, parseOrdUri } from '../src/index.js';
import type { FetchFn } from '../src/backends.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type EnvelopeSpec,
  type TestBlock,
} from '../../core/test/helpers.js';

const SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/spec/SPEC-URI.md',
);
const SPEC = readFileSync(SPEC_PATH, 'utf8');

// ---------------------------------------------------------------------------
// the accounting table
// ---------------------------------------------------------------------------

/**
 * `tested here` and `tested at <where>` both mean a test asserts the
 * behaviour; the third means no test in this repository can, because the
 * sentence binds somebody else's software.
 */
type Status = 'tested here' | `tested at ${string}` | 'binds an external party, not testable in-repo';

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
    id: 'lowercase',
    section: '§2',
    title: 'resolvers MUST normalize to lowercase before use, except the base64 digest',
    quote:
      'Resolvers MUST normalize to\n' +
      '  lowercase before use. (Inscription IDs survive URI authority case-folding by\n' +
      '  construction.) The one carve-out is the base64 digest form of `#integrity=`, whose\n' +
      '  alphabet is case-significant: resolvers MUST fold the frame around such a digest\n' +
      '  (scheme, id, path, fragment key, algorithm prefix) and MUST NOT fold the digest\n' +
      '  value, since folding it would name different bytes.',
    binds: 'resolvers',
    status: 'tested here',
    why:
      'every part of the grammar that can fold is asserted folding: the scheme, the ' +
      'inscription id, the path segment, the fragment key, the algorithm prefix and a ' +
      'hex digest. A whole URI uppercased end to end, which is the QR alphanumeric case ' +
      'line 29 gives as the rationale, is asserted to parse identically to its lowercase ' +
      'twin. The one part that does not fold is the base64 digest form, because base64 ' +
      'is case-significant and folding it would name a different 32 bytes; §2 carries ' +
      'that carve-out and the test drives the frame around such a digest instead.',
  },
  {
    id: 'alias',
    section: '§2',
    title: 'resolvers MUST accept ord:// and MUST treat it identically to ord:',
    quote: 'resolvers MUST accept it and MUST treat\n  `ord://X` identically to `ord:X`.',
    binds: 'resolvers',
    status: 'tested here',
    why: 'both MUSTs on the line are one behaviour: parse both forms and compare the whole result.',
  },
  {
    id: 'delegate-absent',
    section: '§3',
    title: 'a delegate that is not yet inscribed MUST fail, with no fallback',
    quote:
      'with a delegate whose reveal is not yet inscribed MUST fail\n' +
      "  (upstream 404 semantics), not fall back to the delegating inscription's own body.",
    binds: 'resolvers',
    status: 'tested here',
    why: 'the delegating inscription is given a body of its own, so a fallback would be visible.',
  },
  {
    id: 'referent-immutable',
    section: '§3',
    title: 'a resolver MUST NOT let anything outside the chain data decide a referent',
    quote:
      'A resolver MUST NOT let\n' +
      '  anything outside the chain data a URI names decide its referent',
    binds: 'resolvers',
    status: 'tested here',
    why:
      'the immutability claim was keywordless until 0.3.4 and the MAY beside it was the ' +
      'only keyword on the line, so the caching permission was normative and the fact it ' +
      'rests on was not. What is asserted is the resolver side of it: the same id mined ' +
      'into two different blocks, at two heights, in two positions, beside different ' +
      'neighbours, resolves to the same bytes and the same content type through two ' +
      'resolvers over two backends. What no test can reach is "forever", which is a ' +
      'claim about the chain and not about this code.',
  },
  {
    id: 'envelope-index',
    section: '§3',
    title: 'a resolver MUST count every envelope flat across inputs, cursed and unbound included',
    quote:
      'A resolver MUST count every parsed envelope, cursed and unbound\n' +
      '  included, flat across inputs in order, matching ord.',
    binds: 'resolvers',
    status: 'tested here',
    why:
      'the counting rule decides which bytes an id names, and a resolver counting per ' +
      'input or skipping the envelopes ord calls cursed would serve the wrong ' +
      'inscription under a well-formed id. A two-input reveal carrying two envelopes on ' +
      'the first input and one on the second is resolved at each of its three indices, ' +
      'so per-input counting and skip-the-second-in-an-input both fail here. The second ' +
      'envelope in one input is cursed by ord numbering, which is what makes it the ' +
      'entry a counter is tempted to drop.',
  },
  {
    id: 'no-referent',
    section: '§3',
    title: 'an inscription with no body has no referent and MUST fail',
    quote: 'has no referent: resolution MUST fail with a\n  not-found-equivalent error.',
    binds: 'resolvers',
    status: 'tested here',
    why: 'both arms of the sentence are covered: the bare form and the /content form.',
  },
  {
    id: 'integrity',
    section: '§4',
    title: 'an integrity fragment MUST be verified and MUST fail on mismatch at every level',
    quote:
      'MUST verify it and MUST fail resolution on mismatch,\n  regardless of verification level.',
    binds: 'resolvers',
    status: 'tested here',
    why: '"regardless of verification level" is the load-bearing clause, so every level is driven.',
  },
  {
    id: 'digest-domain',
    section: '§4',
    title: 'a resolver MUST hash the stored body pushes, before any decoding',
    quote:
      'A resolver MUST hash exactly\n' +
      '  the concatenated envelope body pushes, BEFORE any content-encoding is decoded and\n' +
      '  before any transport re-encoding.',
    binds: 'resolvers',
    status: 'tested here',
    why:
      'the domain is what makes a pin a fact about the chain rather than about a ' +
      'resolver, so it is driven on an inscription whose stored bytes and decoded bytes ' +
      'differ: gzip on chain, tag 9 declaring it, the resolver decoding it for the ' +
      'caller. The pin over the stored bytes verifies and the pin over the bytes the ' +
      'caller receives is refused, which is the direction a resolver hashing what it ' +
      'returns would get backwards. The `/metadata` arm of the same sentence is driven ' +
      'beside it on the raw CBOR.',
  },
  {
    id: 'indeterminate',
    section: '§4',
    title: 'a transport-decoded mismatch MUST be distinguished from a real one',
    quote: 'and observes a mismatch MUST distinguish\n  "indeterminate" from "mismatch"',
    binds: 'resolvers',
    status: 'tested here',
    why: 'the two outcomes are asserted as distinct error codes over the same pin and the same bytes.',
  },
  {
    id: 'levels',
    section: '§5',
    title: 'resolvers MUST implement the verification-level contract',
    quote: 'Resolvers MUST implement the verification-level contract of SPEC-VERIFICATION',
    binds: 'resolvers',
    status: 'tested here',
    why:
      'the contract is another spec, so what is asserted here is the part a resolver ' +
      'surfaces: every result is labelled with the level it reached, L0 carries no ' +
      'chain context, and L1 without a pin is refused rather than served as L1. The ' +
      "L2 and L3 evidence rules are SPEC-VERIFICATION's own conformance work.",
  },
  {
    id: 'envelope-semantics',
    section: '§5',
    title: "resolvers MUST apply ord's envelope semantics exactly",
    quote:
      "Resolvers MUST apply ord's envelope semantics exactly (tag table, take semantics,\n" +
      '  duplicate/unbound flags, one-hop delegation).',
    binds: 'resolvers',
    status: 'tested here',
    why:
      'one-hop delegation is the clause with a resolver-level observable and is asserted ' +
      'here. The tag table, take semantics and the duplicate/unbound flags are envelope ' +
      "parsing, covered against ord's own vectors in packages/core/test/envelope.test.ts.",
  },
  {
    id: 'encoding',
    section: '§5',
    title: 'stored bytes and the label MUST be delivered, and an unknown encoding MUST NOT fail',
    quote:
      'and MUST otherwise deliver the stored bytes together\n' +
      '  with the encoding label. Resolvers MUST NOT fail solely because an encoding is\n' +
      '  unknown',
    binds: 'resolvers',
    status: 'tested here',
    why: 'one inscription carrying an encoding nothing decodes exercises both sentences at once.',
  },
  {
    id: 'unknown-parts',
    section: '§5',
    title: 'unknown paths and unknown fragments MUST fail parsing',
    quote: 'Unknown paths and unknown fragments MUST fail parsing',
    binds: 'resolvers',
    status: 'tested here',
    why:
      'fail-closed, so the assertion is that parsing throws rather than that it ignores ' +
      'the part it did not understand.',
  },
  {
    id: 'invalid-vectors',
    section: '§8',
    title: 'the invalid test vectors MUST fail',
    quote: 'Invalid (MUST fail): `ord:abci0` (short txid)',
    binds: 'resolvers',
    status: 'tested here',
    why: 'all five vectors are driven, each read out of the spec text rather than retyped.',
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
      `SPEC-URI.md no longer contains this fragment, so the requirement moved or was ` +
        `reworded and its test speaks for nothing:\n${quote}`,
    );
  }
  if (SPEC.indexOf(quote, at + 1) !== -1) {
    throw new Error(`fragment appears more than once in SPEC-URI.md, so it anchors nothing:\n${quote}`);
  }
  const first = SPEC.slice(0, at).split('\n').length;
  return { first, last: first + quote.split('\n').length - 1 };
}

function row(id: string): Requirement {
  const found = TABLE.find((r) => r.id === id);
  if (!found) throw new Error(`no accounting row with id ${id}`);
  return found;
}

/**
 * One conformance test. The quote anchor runs first, so a reworded spec
 * sentence fails here and names itself instead of leaving a green test
 * asserting a rule the spec no longer states.
 */
function conformance(id: string, body: () => void | Promise<void>): void {
  const r = row(id);
  it(`SPEC-URI.md ${r.section}: ${r.title}`, async () => {
    anchor(r.quote);
    await body();
  });
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ID = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';

const E = 'https://esplora.test';
const E2 = 'https://esplora2.test';
const E3 = 'https://esplora3.test';
const O = 'https://ord.test';
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

/** One inscription in its own commit/reveal pair, ready to be mined. */
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

/** Mine the given inscriptions into one block and serve everything they need. */
function chain(inscriptions: Inscribed[], height = 100): OrdResolver {
  const block = buildBlock(inscriptions.map((i) => i.reveal));
  const routes = blockRoutes(block, height);
  for (const i of inscriptions) routes[`${E}/tx/${i.commit.txid}/hex`] = bytesToHex(i.commit.raw);
  return new OrdResolver({ esplora: [E], fetchFn: stubFetch(routes), ...SYNTHETIC });
}

// ---------------------------------------------------------------------------
// §2 Syntax
// ---------------------------------------------------------------------------

describe('SPEC-URI conformance', () => {
  conformance('lowercase', () => {
    // the id survives URI authority case folding, so an all-uppercase id is
    // the same id and the parse says so in the canonical form it returns
    const shouted = `ORD:${ID.toUpperCase()}`;
    expect(parseOrdUri(shouted).idString).toBe(ID);
    expect(parseOrdUri(shouted).canonical).toBe(`ord:${ID}`);
    expect(parseOrdUri(`ORD://${ID.toUpperCase()}`).canonical).toBe(`ord:${ID}`);
    // a hex digest is normalized the same way, so two spellings of one pin are
    // one pin and the comparison against a computed digest cannot miss
    const digest = 'A'.repeat(64);
    expect(parseOrdUri(`ord:${ID}#integrity=sha256-${digest}`).integrity?.digestHex).toBe(
      'a'.repeat(64),
    );

    // everywhere: the path segment, the fragment key and the algorithm prefix
    // fold as well, each on its own so a failure names which one
    expect(parseOrdUri(`ord:${ID}/CONTENT`).path).toBe('content');
    expect(parseOrdUri(`ord:${ID}/Metadata`).path).toBe('metadata');
    expect(parseOrdUri(`ord:${ID}#INTEGRITY=sha256-${digest}`).integrity?.digestHex).toBe(
      'a'.repeat(64),
    );
    expect(parseOrdUri(`ord:${ID}#integrity=SHA256-${digest}`).integrity?.digestHex).toBe(
      'a'.repeat(64),
    );

    // the case the rationale on line 29 names: QR alphanumeric mode is
    // uppercase-only, so an entire URI shouted must be the same URI
    const hexUri = `ord:${ID}/content#integrity=sha256-${'a'.repeat(64)}`;
    expect(parseOrdUri(hexUri.toUpperCase())).toEqual(parseOrdUri(hexUri));

    // and the one value that MUST NOT fold with the rest: base64 is
    // case-significant, so the frame around it folds and it does not
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
    const b64 = Buffer.from(bytes).toString('base64').replace(/=+$/, '');
    // the vector is only a test of case preservation if it has both cases in it
    expect(b64).not.toBe(b64.toLowerCase());
    expect(b64).not.toBe(b64.toUpperCase());
    const expected = bytesToHex(bytes);
    expect(parseOrdUri(`ord:${ID}#integrity=sha256-${b64}`).integrity?.digestHex).toBe(expected);
    expect(
      parseOrdUri(`ORD://${ID.toUpperCase()}/CONTENT#INTEGRITY=SHA256-${b64}`).integrity?.digestHex,
    ).toBe(expected);
  });

  conformance('alias', () => {
    for (const tail of [
      ID,
      `${ID}/content`,
      `${ID}/metadata`,
      `${ID}#integrity=sha256-${'b'.repeat(64)}`,
    ]) {
      // identically: every field of the parse, not merely the id
      expect(parseOrdUri(`ord://${tail}`)).toEqual(parseOrdUri(`ord:${tail}`));
      expect(parseOrdUri(`ord://${tail}`).canonical).toBe(`ord:${tail}`);
    }
  });

  // -------------------------------------------------------------------------
  // §3 Referents
  // -------------------------------------------------------------------------

  conformance('delegate-absent', async () => {
    // the delegating inscription carries a body of its own, so serving it
    // would be the fallback the sentence forbids rather than a coincidence
    const notInscribed = `${'cd'.repeat(32)}i0`;
    const delegating = inscribe({
      fields: [
        [1, 'text/plain'],
        [11, delegateField(notInscribed)],
      ],
      body: ['the delegating body, which /content MUST NOT serve'],
    });
    const resolver = chain([delegating]);

    await expect(resolver.resolve(`ord:${delegating.id}/content`)).rejects.toThrow();
    const failure = await resolver.resolve(`ord:${delegating.id}/content`).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('the delegating body');
    // and the bare form, whose referent is the original content, still serves
    // it: the refusal above is about the delegate and not about the document
    const bare = await resolver.resolve(`ord:${delegating.id}`);
    expect(new TextDecoder().decode(bare.body)).toContain('the delegating body');
  });

  conformance('no-referent', async () => {
    // bare form: an inscription with no body of its own
    const bodyless = inscribe({ fields: [[1, 'text/plain']] });
    // /content form: the effective source is a delegate that has no body
    const emptyDelegate = inscribe({ fields: [[1, 'text/plain']] });
    const delegating = inscribe({
      fields: [[11, delegateField(emptyDelegate.id)]],
    });
    const resolver = chain([bodyless, emptyDelegate, delegating]);

    await expect(resolver.resolve(`ord:${bodyless.id}`)).rejects.toMatchObject({
      code: 'NO_CONTENT',
    });
    await expect(resolver.resolve(`ord:${delegating.id}/content`)).rejects.toMatchObject({
      code: 'NO_CONTENT',
    });
  });

  conformance('referent-immutable', async () => {
    const stored = 'the bytes this id names, wherever it is asked about';
    const one = inscribe({ fields: [[1, 'text/plain']], body: [stored] });
    const filler = inscribe({ fields: [[1, 'text/plain']], body: ['a neighbour'] });

    // the same inscription mined into two different blocks: different height,
    // different position, different neighbours, different backend answers
    const first = await chain([one], 100).resolve(`ord:${one.id}`);
    const second = await chain([filler, one], 250).resolve(`ord:${one.id}`);

    expect(new TextDecoder().decode(second.body)).toBe(stored);
    expect(second.body).toEqual(first.body);
    expect(second.contentType).toBe(first.contentType);
    // and the chain context each resolve established really did differ, so the
    // sameness above is the referent and not two identical resolves
    expect(second.verification.blockHash).not.toBe(first.verification.blockHash);
    expect(second.verification.height).not.toBe(first.verification.height);
  });

  conformance('envelope-index', async () => {
    // one input carrying two envelopes, then an input carrying one. The second
    // envelope in an input is cursed by ord numbering and counts all the same
    const twoInOne = concatBytes(
      envelopeScript({ fields: [[1, 'text/plain']], body: ['envelope 0'] }, { checksigPrefix: true }),
      envelopeScript({ fields: [[1, 'text/plain']], body: ['envelope 1'] }),
    );
    const alone = envelopeScript(
      { fields: [[1, 'text/plain']], body: ['envelope 2'] },
      { checksigPrefix: true },
    );
    const tapFirst = taprootCommit(twoInOne);
    const tapSecond = taprootCommit(alone);
    const commit = commitTx(tapFirst.scriptPubKey);
    const reveal = revealTx(
      [
        { script: twoInOne, controlBlock: tapFirst.controlBlock },
        { script: alone, controlBlock: tapSecond.controlBlock },
      ],
      { prevTxidLE: commit.txidLE, vout: 0 },
    );
    const inscribed = { id: `${reveal.txid}i0`, reveal, commit };
    const resolver = chain([inscribed]);

    // flat across inputs in order: index 2 is the second input's envelope, and
    // a resolver counting per input or dropping the cursed one would land
    // somewhere else on at least one of these
    for (const [index, body] of [
      [0, 'envelope 0'],
      [1, 'envelope 1'],
      [2, 'envelope 2'],
    ] as const) {
      const at = await resolver.resolve(`ord:${reveal.txid}i${index}`, { verification: 'L3' });
      expect(new TextDecoder().decode(at.body), `index ${index}`).toBe(body);
    }
    // and one past the end is not a referent at all
    await expect(resolver.resolve(`ord:${reveal.txid}i3`)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // §4 The integrity fragment
  // -------------------------------------------------------------------------

  conformance('digest-domain', async () => {
    // stored bytes and delivered bytes differ, which is the only arrangement
    // where the domain is observable
    const decoded = 'the text a caller receives once the resolver inflates it';
    const gzipped = new Uint8Array(gzipSync(Buffer.from(decoded)));
    const one = inscribe({
      fields: [
        [1, 'text/plain'],
        [9, 'gzip'],
      ],
      body: [gzipped],
    });
    const resolver = chain([one]);

    const served = await resolver.resolve(`ord:${one.id}`);
    expect(new TextDecoder().decode(served.body)).toBe(decoded);
    expect(served.decoded).toBe(true);

    const storedDigest = bytesToHex(sha256(gzipped));
    const deliveredDigest = bytesToHex(sha256(new TextEncoder().encode(decoded)));
    expect(storedDigest).not.toBe(deliveredDigest);

    // the pin over the stored pushes verifies; the pin over the bytes the
    // caller was handed does not, which is the direction a resolver hashing
    // its own output would get backwards
    const pinned = await resolver.resolve(`ord:${one.id}#integrity=sha256-${storedDigest}`);
    expect(pinned.verification.integrityChecked).toBe(true);
    await expect(
      resolver.resolve(`ord:${one.id}#integrity=sha256-${deliveredDigest}`),
    ).rejects.toMatchObject({ code: 'INTEGRITY' });

    // the /metadata arm of the same sentence: the raw CBOR chunks, as stored
    const meta = Uint8Array.from([0xa1, 0x61, 0x6b, 0x61, 0x76]); // {"k":"v"}
    const withMeta = inscribe({
      fields: [
        [1, 'text/plain'],
        [5, meta],
      ],
      body: ['a body the metadata pin must not hash'],
    });
    const metaResolver = chain([withMeta]);
    const metaDigest = bytesToHex(sha256(meta));
    const metaPinned = await metaResolver.resolve(
      `ord:${withMeta.id}/metadata#integrity=sha256-${metaDigest}`,
    );
    expect(metaPinned.body).toEqual(meta);
    expect(metaPinned.verification.integrityChecked).toBe(true);
  });

  conformance('integrity', async () => {
    const stored = 'pinned bytes';
    const one = inscribe({ fields: [[1, 'text/plain']], body: [stored] });
    const verified = chain([one]);
    const digest = bytesToHex(sha256(new TextEncoder().encode(stored)));
    const wrong = '0'.repeat(64);

    // L2 and L3: the chain-data path
    for (const level of ['L2', 'L3'] as const) {
      const ok = await verified.resolve(`ord:${one.id}#integrity=sha256-${digest}`, {
        verification: level,
      });
      expect(ok.verification.integrityChecked, level).toBe(true);
      await expect(
        verified.resolve(`ord:${one.id}#integrity=sha256-${wrong}`, { verification: level }),
      ).rejects.toMatchObject({ code: 'INTEGRITY' });
    }

    // L0 and L1: the trusted-gateway path, where the pin is the only evidence
    const served = new TextEncoder().encode(stored);
    const gateway = new OrdResolver({
      ordGateways: [O],
      fetchFn: async (url: string) =>
        url === `${O}/r/undelegated-content/${ID}`
          ? new Response(served.slice(), { headers: { 'content-type': 'text/plain' } })
          : new Response('no', { status: 404 }),
    });
    for (const level of ['none', 'L1'] as const) {
      const ok = await gateway.resolve(`ord:${ID}#integrity=sha256-${digest}`, {
        verification: level,
      });
      expect(ok.verification.integrityChecked, level).toBe(true);
      await expect(
        gateway.resolve(`ord:${ID}#integrity=sha256-${wrong}`, { verification: level }),
      ).rejects.toMatchObject({ code: 'INTEGRITY' });
    }
  });

  conformance('indeterminate', async () => {
    // one body, one pin it does not match, two transports: the difference
    // between the answers is the whole requirement
    const served = new TextEncoder().encode('plain text, whatever the header says');
    const pin = 'sha256-' + 'f'.repeat(64);
    function gatewayServing(headers: Record<string, string>): OrdResolver {
      return new OrdResolver({
        ordGateways: [O],
        verification: 'L1',
        fetchFn: async (url: string) =>
          url === `${O}/r/undelegated-content/${ID}`
            ? new Response(served.slice(), { headers })
            : new Response('no', { status: 404 }),
      });
    }

    // the HTTP layer reports having decoded a transport encoding, so the
    // stored-bytes pin cannot be evaluated against what is in hand
    await expect(
      gatewayServing({ 'content-type': 'text/plain', 'content-encoding': 'br' }).resolve(
        `ord:${ID}#integrity=${pin}`,
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_INDETERMINATE' });

    // same bytes, same pin, no such report: this one is a real mismatch
    await expect(
      gatewayServing({ 'content-type': 'text/plain' }).resolve(`ord:${ID}#integrity=${pin}`),
    ).rejects.toMatchObject({ code: 'INTEGRITY' });
  });

  // -------------------------------------------------------------------------
  // §5 Resolution requirements
  // -------------------------------------------------------------------------

  conformance('levels', async () => {
    const one = inscribe({ fields: [[1, 'text/plain']], body: ['levelled'] });
    const verified = chain([one]);

    // every result is labelled with the level it reached, so no consumer can
    // mistake one level for another (SPEC-VERIFICATION §2's own L0 rule)
    for (const level of ['L2', 'L3'] as const) {
      const result = await verified.resolve(`ord:${one.id}`, { verification: level });
      expect(result.verification.level).toBe(level);
      // a chain-data level carries the chain context it claims
      expect(result.verification.blockHash).toBeTruthy();
      expect(result.verification.height).toBe(100);
    }

    const served = new TextEncoder().encode('levelled');
    const gateway = new OrdResolver({
      ordGateways: [O],
      fetchFn: async (url: string) =>
        url === `${O}/r/undelegated-content/${ID}`
          ? new Response(served.slice(), { headers: { 'content-type': 'text/plain' } })
          : new Response('no', { status: 404 }),
    });
    const l0 = await gateway.resolve(`ord:${ID}`, { verification: 'none' });
    expect(l0.verification.level).toBe('none');
    // no chain context is established at L0, and the report does not imply any
    expect(l0.verification.blockHash).toBeUndefined();
    expect(l0.verification.height).toBeUndefined();
    // L1 is the pin, so L1 without one is refused rather than served as L1
    await expect(gateway.resolve(`ord:${ID}`, { verification: 'L1' })).rejects.toMatchObject({
      code: 'INTEGRITY',
    });

    // the default is L2 or better, which is the SHOULD on the same line
    expect((await chain([one]).resolve(`ord:${one.id}`)).verification.level).toBe('L2');
  });

  conformance('envelope-semantics', async () => {
    // one hop, never chained: A delegates to B, B delegates to C, and B has a
    // body. /content on A serves B's body and never reaches C
    const c = inscribe({ fields: [[1, 'text/plain']], body: ['C, one hop too far'] });
    const b = inscribe({
      fields: [
        [1, 'text/plain'],
        [11, delegateField(c.id)],
      ],
      body: ['B, the delegate'],
    });
    const a = inscribe({ fields: [[11, delegateField(b.id)]] });
    const resolver = chain([a, b, c]);

    const viaDelegate = await resolver.resolve(`ord:${a.id}/content`);
    expect(new TextDecoder().decode(viaDelegate.body)).toBe('B, the delegate');
    expect(viaDelegate.viaDelegate).toBe(b.id);
    // the envelope-level data reported is the ADDRESSED inscription's, so a
    // consumer can still see the delegation it went through
    expect(viaDelegate.inscription?.delegate).toBe(b.id);
  });

  conformance('encoding', async () => {
    // any string can appear on-chain in tag 9, and nothing decodes this one
    const stored = 'stored bytes, encoded by nothing in particular';
    const one = inscribe({
      fields: [
        [1, 'text/plain'],
        [9, 'x-unknown-42'],
      ],
      body: [stored],
    });
    const result = await chain([one]).resolve(`ord:${one.id}`);

    // delivered: the stored bytes, undecoded, with the label beside them
    expect(new TextDecoder().decode(result.body)).toBe(stored);
    expect(result.contentEncoding).toBe('x-unknown-42');
    expect(result.decoded).toBe(false);
    // and the attestation-grade copy of the same label, which survives decoding
    expect(result.storedContentEncoding).toBe('x-unknown-42');
    // did not fail: the level reached is the one that was asked for
    expect(result.verification.level).toBe('L2');
  });

  conformance('unknown-parts', () => {
    // fail-closed: a path this resolver does not understand must not quietly
    // serve the bare referent under a URI that meant something else
    expect(() => parseOrdUri(`ord:${ID}/preview`)).toThrow(/unknown ord URI path/);
    expect(() => parseOrdUri(`ord:${ID}/children`)).toThrow(/unknown ord URI path/);
    expect(() => parseOrdUri(`ord:${ID}/content/extra`)).toThrow(/too many path segments/);
    expect(() => parseOrdUri(`ord:${ID}#sha256=${'a'.repeat(64)}`)).toThrow(/unknown ord URI fragment/);
    expect(() => parseOrdUri(`ord:${ID}#anything`)).toThrow(/unknown ord URI fragment/);
    // an empty fragment is not an unknown one: RFC 3986 reads `#` as the same
    // referent, so it parses and carries no pin
    expect(parseOrdUri(`ord:${ID}#`).integrity).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // §8 Test vectors
  // -------------------------------------------------------------------------

  conformance('invalid-vectors', () => {
    // read out of the spec rather than retyped, so a vector added to the list
    // is driven here without anybody remembering to copy it. The paragraph
    // runs to the next blank line, so a sixth vector on a fourth line is read
    // too and fails the expectation below until it is accounted for
    const start = SPEC.indexOf('Invalid (MUST fail):');
    const end = SPEC.indexOf('\n\n', start);
    const paragraph = SPEC.slice(start, end === -1 ? undefined : end);
    const listed = (paragraph.match(/`([^`]+)`/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed).toEqual([
      'ord:abci0',
      'ord:<64hex>i01',
      'ord:<64hex>i4294967296',
      'ord:<id>/preview',
      'ord:<id>#integrity=md5-…',
    ]);

    const hex = 'a'.repeat(64);
    const concrete = listed.map((v) =>
      v.replace('<64hex>', hex).replace('<id>', ID).replace('…', 'abc'),
    );
    for (const uri of concrete) {
      expect(() => parseOrdUri(uri), uri).toThrow();
    }
  });

  // -------------------------------------------------------------------------
  // the accounting
  // -------------------------------------------------------------------------

  /**
   * The RFC 2119 keyword definition is the one MUST-bearing line that states
   * no requirement, so it is the one line no row claims.
   */
  const KEYWORD_DEFINITION = 'The key words MUST, MUST NOT, SHOULD, MAY are to be interpreted per RFC 2119.';

  it('SPEC-URI.md: every normative line is accounted for by a row in this file', () => {
    const lines = SPEC.split('\n');
    const keywordLine = lines.findIndex((l) => l.includes(KEYWORD_DEFINITION)) + 1;
    expect(keywordLine, 'the RFC 2119 keyword definition is gone from the spec').toBeGreaterThan(0);

    const normative = lines
      .map((text, i) => ({ line: i + 1, text }))
      .filter((l) => l.text.includes('MUST') && l.line !== keywordLine);

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
      `SPEC-URI.md states requirements no row in this file accounts for:\n${unaccounted.join('\n')}`,
    ).toEqual([]);

    // and the other direction: a row claiming a line that carries no MUST
    // would mean the table drifted off the requirements it is accounting for
    expect(claimed.size).toBe(normative.length);
  });

  it('SPEC-URI.md: the table says how each requirement is covered', () => {
    for (const r of TABLE) {
      expect(r.why.length, `${r.id} has no reasoning`).toBeGreaterThan(20);
      expect(r.binds.length, `${r.id} does not say who it binds`).toBeGreaterThan(0);
      if (r.status !== 'binds an external party, not testable in-repo') {
        expect(r.title, `${r.id} is not named for its requirement`).toMatch(/MUST/);
      }
    }
  });
});
