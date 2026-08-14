/**
 * The SPEC-CUSTODY rows whose code lives in @ordspv/fetch: the builder's duty
 * to emit a witness section on request, its walk-and-refuse accounting
 * (`custodybuilder.ts` and `failover.ts`), the hop cap, the anchor's bar on
 * the backend that built the bundle (`headertrust.ts`), and the resolver's
 * per-source tip liveness.
 *
 * The accounting table is shared with the core suite
 * (`packages/core/test/spec-custody.rows.ts`), and the accounting test that
 * sums the whole spec lives in
 * `packages/core/test/spec-custody.conformance.test.ts`. Neither file can lose
 * a row: the table names which one drives each, and each asserts it drives
 * exactly the rows assigned to it.
 *
 * Most rows here drive a real build against the mock esplora in
 * `custodystub.ts`, which is what the SPEC-SAT session recommended after three
 * of its own builder rows came down to source reads. Two rows are `tested at`
 * citations to the suites that drive the loop across its arms, with a thin
 * re-assertion of the mechanism the cited test relies on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  bytesToHex,
  hexToBytes,
  parseHeader,
  serializeBlock,
  verifyCustodyBundle,
} from '@ordspv/core';
import type { ParsedTx } from '@ordspv/core';
import {
  ROOT,
  SPEC,
  anchor,
  drivenIdsFor,
  idsFor,
  row,
} from '../../core/test/spec-custody.rows.js';
import {
  CustodyError,
  CustodyHopLimitError,
  EsploraBackend,
  REFUSAL_CLASS_FACTS,
  WitnessSectionUnavailableError,
  buildCustodyBundle,
  fetchCustody,
  isRecordableBuildRefusal,
  makeHeaderTrust,
  type AttemptInfo,
} from '../src/index.js';
import { sharedDomainRefusal, type DomainRefusal } from '../src/failover.js';
import type { FetchFn } from '../src/backends.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
} from '../../core/test/helpers.js';
import {
  E,
  E2,
  E3,
  OPTS,
  inscriptionSetup,
  legacySpend,
  mirror,
  routesForBlock,
  stubFetch,
  type Route,
} from './custodystub.js';

// ---------------------------------------------------------------------------
// the test wrapper
// ---------------------------------------------------------------------------

/** ids this file speaks for, compared against the table at the bottom */
const SPOKEN: string[] = [];

function conformance(id: string, body: () => void | Promise<void>): void {
  const r = row(id);
  if (r.file !== 'fetch') throw new Error(`row ${id} is assigned to the ${r.file} file`);
  SPOKEN.push(id);
  it(`SPEC-CUSTODY.md ${r.section}: ${r.title}`, async () => {
    anchor(r.quote);
    await body();
  });
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const A = 'https://a.test';
const B = 'https://b.test';
const C = 'https://c.test';
/** a fourth attester, for the arrangements where both walkers may serve bytes */
const E4 = 'https://esplora4.test';

type RefusalCtor = (typeof REFUSAL_CLASS_FACTS)[keyof typeof REFUSAL_CLASS_FACTS]['ctor'];

function refusal(baseUrl: string, message: string): DomainRefusal {
  return { baseUrl, error: new CustodyUnsupportedError(message, 1000) };
}

/** the vendored mainnet header, at a height no compiled-in checkpoint covers */
const HEADER = parseHeader(
  hexToBytes(readFileSync(join(ROOT, 'fixtures/insc0/header-767430.hex'), 'utf8').trim()),
);
const VOTED_HEIGHT = 800_000;

function attester(base: string, hashAtHeight: string): EsploraBackend {
  const routes: Record<string, string> = {
    [`${base}/block-height/${VOTED_HEIGHT}`]: hashAtHeight,
    [`${base}/blocks/tip/height`]: String(VOTED_HEIGHT + 10),
  };
  const fetchFn: FetchFn = async (url: string) =>
    routes[url] !== undefined ? new Response(routes[url]) : new Response('no stub', { status: 404 });
  return new EsploraBackend(base, fetchFn);
}

/** a single-input reveal with every route a build needs, raw block optional */
function singleInputRoutes(withRawBlock: boolean): {
  setup: ReturnType<typeof inscriptionSetup>;
  routes: Record<string, Route>;
} {
  const setup = inscriptionSetup();
  const routes = routesForBlock(setup.block, 100, 120);
  routes[`${E}/tx/${setup.commit.txid}/hex`] = bytesToHex(setup.commit.raw);
  routes[`${E}/tx/${setup.reveal.txid}/outspend/0`] = { spent: false };
  if (withRawBlock) {
    routes[`${E}/block/${setup.block.blockHash}/raw`] = serializeBlock(
      hexToBytes(setup.block.headerHex),
      setup.block.txs,
    );
  }
  return { setup, routes };
}

/**
 * A two-input reveal, envelope 0 on input 0. Only input 0's previous
 * transaction is fetched, since the envelope's index decides how far the
 * values have to reach, so input 1 spends a prevout nothing serves.
 */
function multiInputRoutes(withRawBlock: boolean): {
  id: string;
  routes: Record<string, Route>;
} {
  const script = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['custody'] },
    { checksigPrefix: true },
  );
  const second = envelopeScript(
    { fields: [[1, 'text/plain']], body: ['second'] },
    { checksigPrefix: true },
  );
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx(
    [
      { script, controlBlock: tap.controlBlock },
      { script: second, controlBlock: taprootCommit(second).controlBlock },
    ],
    { prevTxidLE: commit.txidLE, vout: 0 },
  );
  const block = buildBlock([reveal]);
  const routes = routesForBlock(block, 100, 120);
  routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
  routes[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
  if (withRawBlock) {
    routes[`${E}/block/${block.blockHash}/raw`] = serializeBlock(
      hexToBytes(block.headerHex),
      block.txs,
    );
  }
  return { id: `${reveal.txid}i0`, routes };
}

/**
 * A chain of `n` confirmed transfers behind one reveal, every hop paying its
 * whole input onward so the tracked offset survives. Both configured backends
 * answer the same routes, so each walks to the same wall.
 */
function longPathSetup(n: number): { id: string; fetchFn: FetchFn } {
  const { commit, reveal, block, id } = inscriptionSetup();
  const value = reveal.outputs[0].value;
  const routes = routesForBlock(block, 100, 300);
  routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
  let prev: ParsedTx = reveal;
  for (let i = 0; i < n; i++) {
    const spend = legacySpend(prev.txid, 0, [value]);
    const b = buildBlock([spend]);
    Object.assign(routes, routesForBlock(b, 105 + i, 300));
    routes[`${E}/tx/${prev.txid}/outspend/0`] = {
      spent: true,
      txid: spend.txid,
      vin: 0,
      status: { confirmed: true, block_height: 105 + i, block_hash: b.blockHash },
    };
    prev = spend;
  }
  routes[`${E}/tx/${prev.txid}/outspend/0`] = { spent: false };
  const base = stubFetch(routes);
  return { id, fetchFn: (url, init) => base(url.replace(E2, E), init) };
}

// ---------------------------------------------------------------------------

describe('SPEC-CUSTODY conformance: the builder and the resolver', () => {
  // -------------------------------------------------------------------------
  // Envelope binding
  // -------------------------------------------------------------------------

  conformance('builder-section-any-reveal', async () => {
    // "ANY reveal" is what separates this from the SHOULD at :123. A
    // single-input reveal proves its own numbering, so the default emits no
    // section and a builder could reasonably stop there
    const { setup, routes } = singleInputRoutes(true);
    const backend = new EsploraBackend(E, stubFetch(routes));

    const dflt = await buildCustodyBundle(setup.id, backend, { powLimitBits: null });
    expect('witness' in dflt.bundle.hops[0], 'the SHOULD half: no section by default').toBe(false);

    // and the MUST: asked for one, the builder produces it on the very reveal
    // that needs nothing more, so the consumer the sentence names can have
    // `wtxid` on every inscription it verifies
    const always = await buildCustodyBundle(setup.id, backend, {
      witnessSection: 'always',
      powLimitBits: null,
    });
    expect(always.bundle.hops[0].witness).toBeDefined();
    const verified = verifyCustodyBundle(always.bundle, { powLimitBits: null });
    expect(verified.indexProof).toBe('wtxid');
    expect(verified.singleInputReveal, 'on a single-input reveal').toBe(true);
  });

  conformance('builder-section-failure-distinguishable', async () => {
    // the same build with the raw block withheld: the section cannot be
    // fetched, and the builder has to fail rather than quietly hand back the
    // bundle it could build
    const { setup, routes } = singleInputRoutes(false);
    const backend = new EsploraBackend(E, stubFetch(routes));
    const e = (await buildCustodyBundle(setup.id, backend, {
      witnessSection: 'always',
      powLimitBits: null,
    }).catch((x: unknown) => x)) as Error;

    expect(e, 'it failed rather than emitting a bundle').toBeInstanceOf(
      WitnessSectionUnavailableError,
    );
    // distinguishable from the verifier's refusal: one is availability and the
    // other is a reveal that cannot prove its numbering at all
    expect(e).not.toBeInstanceOf(EnvelopeIndexUnprovenError);
    expect(new EnvelopeIndexUnprovenError('x')).not.toBeInstanceOf(WitnessSectionUnavailableError);

    // and the same routes without the request still build, so the failure is
    // the request meeting an absent block rather than the routes
    const ok = await buildCustodyBundle(setup.id, backend, { powLimitBits: null });
    expect('witness' in ok.bundle.hops[0]).toBe(false);
  });

  conformance('refusal-not-terminal', () => {
    // which classes rotate is a table rather than a list kept in the loop, so
    // the re-assert reads the table: every class the loop can record answers
    // false to `committedAtBuild`, which is the sentence's test for what a
    // build may treat as terminal
    // an instance of each class without calling its constructor, since the
    // arities differ and only the prototype chain decides `instanceof`
    const instance = (ctor: RefusalCtor): Error => Object.create(ctor.prototype) as Error;

    const recordable = Object.entries(REFUSAL_CLASS_FACTS).filter(([, f]) =>
      isRecordableBuildRefusal(instance(f.ctor)),
    );
    expect(recordable.length, 'the table has recordable classes to speak for').toBeGreaterThan(0);
    for (const [name, facts] of recordable) {
      expect(
        facts.committedAtBuild,
        `${name} is recorded and rotated on, so the txid cannot commit what decided it`,
      ).toBe(false);
    }

    // and the exemption runs the other way: a class the txid does commit is
    // not recordable, so no amount of rotation can reach it
    for (const [name, facts] of Object.entries(REFUSAL_CLASS_FACTS)) {
      if (!facts.committedAtBuild) continue;
      expect(
        isRecordableBuildRefusal(instance(facts.ctor)),
        `${name} is committed at build, so the loop must not record and rotate on it`,
      ).toBe(false);
    }
  });

  conformance('record-cause-and-walk-again', async () => {
    // a real build over two backends where the first serves a reveal for
    // another transaction: the loop records that as its cause and the second
    // leads the next attempt
    const { commit, reveal, block, id } = inscriptionSetup();
    const decoy = legacySpend('55'.repeat(32), 0, [546n]);
    let routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    routes = mirror(routes, E, E2);
    // E alone serves the wrong bytes for the reveal
    routes[`${E}/tx/${reveal.txid}/hex`] = bytesToHex(decoy.raw);
    // both walkers may serve bytes, so the vote needs two attesters that
    // cannot have
    routes[`${E4}/block-height/100`] = routes[`${E3}/block-height/100`];
    routes[`${E4}/blocks/tip/height`] = routes[`${E3}/blocks/tip/height`];

    const attempts: AttemptInfo[] = [];
    const res = await fetchCustody(id, {
      ...OPTS,
      anchorSources: [E3, E4],
      fetchFn: stubFetch(routes),
      onAttempt: (a) => attempts.push(a),
    });

    expect(res.custody.satpoint.txid, 'the second backend built it').toBe(reveal.txid);
    expect(attempts.map((a) => a.baseUrl), 'both backends led, in order').toEqual([E, E2]);
    // the cause is kept and attributed rather than folded into a count
    expect(attempts[0].cause, 'the first attempt led with nothing behind it').toBeUndefined();
    expect(attempts[1].cause, "the second carries the first backend's cause").toBeDefined();
    expect(attempts[1].cause!.message).toContain(reveal.txid);
  });

  conformance('input-count-refusal-terminal', async () => {
    // no build raises the class, so the arm is read rather than driven and
    // what the read asserts is placement: the terminal check sits above the
    // recording path in the walk loop, so no rotation can reach the class
    // however the loop is entered
    const source = readFileSync(join(ROOT, 'packages/fetch/src/custodybuilder.ts'), 'utf8');
    const terminal = source.indexOf('if (e instanceof EnvelopeIndexUnprovenError) throw e;');
    const recorded = source.indexOf(
      'if (isRecordableBuildRefusal(e) || e instanceof SatPositionError) {',
    );
    const verified = source.indexOf('verifyCustodyBundle(built.bundle');
    expect(terminal, "the walk loop's catch carries the arm").toBeGreaterThan(0);
    expect(terminal, 'above the recording path').toBeLessThan(recorded);
    expect(recorded, 'and the whole walk loop above the verification').toBeLessThan(verified);

    // the table the recording path consults agrees with the arm: the deciding
    // data is committed at build, so the predicate refuses the class outright
    expect(REFUSAL_CLASS_FACTS.EnvelopeIndexUnprovenError.committedAtBuild).toBe(true);
    expect(isRecordableBuildRefusal(new EnvelopeIndexUnprovenError('reveal spends 2 inputs'))).toBe(
      false,
    );

    // and why no build raises it, driven rather than asserted: a real
    // two-input build is given a section under the default mode, so the reveal
    // shape the verifier would refuse never leaves the builder
    const served = multiInputRoutes(true);
    const backend = new EsploraBackend(E, stubFetch(served.routes));
    const built = await buildCustodyBundle(served.id, backend, { powLimitBits: null });
    expect(built.bundle.hops[0].witness, 'when-needed emits one for a multi-input reveal').toBeDefined();
    expect(verifyCustodyBundle(built.bundle, { powLimitBits: null }).indexProof).toBe('wtxid');

    // the same routes without the raw block end at availability instead, which
    // is the other way out and still not the index class
    const withheld = multiInputRoutes(false);
    const e = (await buildCustodyBundle(withheld.id, new EsploraBackend(E, stubFetch(withheld.routes)), {
      powLimitBits: null,
    }).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(WitnessSectionUnavailableError);
    expect(e).not.toBeInstanceOf(EnvelopeIndexUnprovenError);
  });

  conformance('verifier-refusal-terminal', async () => {
    // both classes a verifier raises leave `fetchCustody` as themselves,
    // between the verification call and the wrap everything else takes
    const source = readFileSync(join(ROOT, 'packages/fetch/src/custodybuilder.ts'), 'utf8');
    const verified = source.indexOf('verifyCustodyBundle(built.bundle');
    const unproven = source.indexOf(
      'if (e instanceof EnvelopeIndexUnprovenError) throw e;',
      verified,
    );
    const domain = source.indexOf('if (e instanceof CustodyUnsupportedError) throw e;', verified);
    const wrapped = source.indexOf("throw new CustodyError('VERIFY_FAILED'", verified);
    expect(verified, 'the builder verifies what it built').toBeGreaterThan(0);
    expect(unproven, 'the index refusal leaves unwrapped').toBeGreaterThan(verified);
    expect(unproven).toBeLessThan(wrapped);
    expect(domain, 'and so does the domain refusal').toBeGreaterThan(verified);
    expect(domain).toBeLessThan(wrapped);

    // what those arms preserve: the wrapper answers false to both `instanceof`
    // tests, so wrapping would erase the distinction a caller discriminates on
    const wrapper = new CustodyError('VERIFY_FAILED', 'bundle refused');
    expect(wrapper).not.toBeInstanceOf(CustodyUnsupportedError);
    expect(wrapper).not.toBeInstanceOf(EnvelopeIndexUnprovenError);

    // the arms are read rather than driven because the walk computes the same
    // satpoints the verification recomputes, so a bundle the walk completed is
    // one the verifier accepts. That much is driven: the build reaches its own
    // verification and passes it
    const { setup, routes } = singleInputRoutes(true);
    const built = await buildCustodyBundle(setup.id, new EsploraBackend(E, stubFetch(routes)), {
      powLimitBits: null,
    });
    expect(verifyCustodyBundle(built.bundle, { powLimitBits: null }).hops).toBe(1);
  });

  conformance('report-reach-and-no-answer-group', () => {
    // the marker and the groups are one report, so all three are read off one
    // call: three backends, one refused, one answered nothing, one never led
    const shared = sharedDomainRefusal(
      [refusal(A, 'v1 does not track sats through fees')],
      3,
      [{ baseUrl: B, error: new Error('connection reset') }],
      [C],
    );
    expect(shared).toBeDefined();
    expect(shared!.unanimous, 'it did not reach every backend').toBe(false);
    expect(shared!.message, 'the group that answered nothing, with what ended it').toContain(
      `${B}: connection reset`,
    );
    expect(shared!.message, 'and the group that never led').toContain(C);
    expect(shared!.message).toMatch(/never led an attempt/);
    expect(shared!.message).toMatch(/produced no usable answer/);

    // the marker varies, which is what makes it a report rather than a label
    const every = sharedDomainRefusal([refusal(A, 'fees'), refusal(B, 'fees')], 2);
    expect(every!.unanimous).toBe(true);

    // what the custody wrapper itself can reach: its loop breaks only on
    // success, so on the failure path every configured backend has led and the
    // never-led group is empty by construction. The call site says so
    const source = readFileSync(join(ROOT, 'packages/fetch/src/custodybuilder.ts'), 'utf8');
    expect(source).toContain('sharedDomainRefusal(refusals, backends.length, noAnswer)');
  });

  conformance('unanimity-needs-two', () => {
    // one backend agreeing with itself is the case the rule exists for: every
    // part of unanimity is satisfied here except the count
    const alone = sharedDomainRefusal([refusal(A, 'v1 does not track sats through fees')], 1);
    expect(alone).toBeDefined();
    expect(alone!.unanimous, 'one server agreeing with itself is one server').toBe(false);
    expect(alone!.message, 'and the message says what a second backend would add').toMatch(
      /a second configured backend is/,
    );

    // two in the same arrangement, which is the only thing that moved
    const pair = sharedDomainRefusal([refusal(A, 'fees'), refusal(B, 'fees')], 2);
    expect(pair!.unanimous).toBe(true);
    expect(pair!.message).toMatch(/each configured backend led an attempt/);
  });

  conformance('caller-must-not-read-partial', () => {
    // the sentence binds callers and this repository ships one. What the
    // library owes it is that the marker rides on the error a caller catches,
    // rather than in a message a caller would have to parse
    const partial = sharedDomainRefusal([refusal(A, 'fees')], 2, [
      { baseUrl: B, error: new Error('timeout') },
    ]);
    expect(partial).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(partial!, 'unanimous')).toBe(true);
    expect(partial!.unanimous).toBe(false);
    expect(partial, 'and it is the domain class, so a caller catches it by type').toBeInstanceOf(
      CustodyUnsupportedError,
    );
  });

  // -------------------------------------------------------------------------
  // Custody bundle
  // -------------------------------------------------------------------------

  conformance('builder-hop-cap-distinguishable', async () => {
    // the sentence gives its own test: refused under a cap the path exceeds,
    // and walked under one raised past it, so the refusal cannot have been
    // about the path
    const { id, fetchFn } = longPathSetup(4);
    const e = (await fetchCustody(id, { ...OPTS, fetchFn, maxHops: 3 }).catch(
      (x: unknown) => x,
    )) as CustodyHopLimitError;

    // its own class, so a caller discriminates on it rather than on a message
    expect(e).toBeInstanceOf(CustodyHopLimitError);
    expect(e, 'a backend failure is the wrapper class').not.toBeInstanceOf(CustodyUnsupportedError);
    // and it carries what the caller has to raise
    expect(e.cap).toBe(3);
    expect(e.hops).toBe(4);
    expect(e.message).toMatch(/raise the cap with --max-hops/);

    // unproven rather than a statement about the chain: the same routes under
    // a raised cap walk the whole path and verify
    const res = await fetchCustody(id, { ...OPTS, fetchFn, maxHops: 4 });
    expect(res.custody.hops, 'the reveal plus four transfers').toBe(5);

    // the class is recordable, so a wall every backend reached reports as a
    // shared refusal rather than as a build failure naming other backends
    expect(isRecordableBuildRefusal(new CustodyHopLimitError('x', 1, 2))).toBe(true);
    expect(REFUSAL_CLASS_FACTS.CustodyHopLimitError.committedAtBuild).toBe(false);
  });

  conformance('builder-not-an-attester', async () => {
    const hash = HEADER.hash;
    // two attesters agree, and one of them served bytes for the bundle. The
    // threshold is met only by counting the one that helped build it
    const trust = makeHeaderTrust({
      esploras: [attester(A, hash), attester(B, hash)],
      minAgreement: 2,
      minConfirmations: 0,
      checkpoints: new Map(),
      proofSources: new Set([A]),
    });
    await expect(trust(HEADER, VOTED_HEIGHT)).rejects.toThrow(/agree/);

    // the same vote with an independent second source passes, so the refusal
    // above was the bar rather than the arithmetic
    const independent = makeHeaderTrust({
      esploras: [attester(A, hash), attester(B, hash), attester(C, hash)],
      minAgreement: 2,
      minConfirmations: 0,
      checkpoints: new Map(),
      proofSources: new Set([A]),
    });
    const report = await independent(HEADER, VOTED_HEIGHT);
    expect(report.anchored).toBe(true);
    expect(report.sourcesAgreed).toBe(2);

    // the wrapper bars every backend that served bytes and not just the
    // walker, which is what the cited test drives on the raw-block server
    const source = readFileSync(join(ROOT, 'packages/fetch/src/custodybuilder.ts'), 'utf8');
    expect(source).toContain('proofSources: built.servedBaseUrls');
  });

  // -------------------------------------------------------------------------
  // What custody proofs cannot say
  // -------------------------------------------------------------------------

  conformance('tip-liveness-per-source', async () => {
    const { commit, reveal, block, id } = inscriptionSetup();
    let routes = routesForBlock(block, 100, 120);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    routes = mirror(routes, E, E2);
    // the arrangement a resolver folding the answers into one verdict could
    // not report: the two backends disagree about the tip
    routes[`${E}/tx/${reveal.txid}/outspend/0`] = { spent: false };
    routes[`${E2}/tx/${reveal.txid}/outspend/0`] = () =>
      new Response('upstream down', { status: 502 });

    const res = await fetchCustody(id, { ...OPTS, fetchFn: stubFetch(routes) });

    // per source, under its own name
    expect(res.tip.map((t) => t.source).sort()).toEqual([E, E2].sort());
    expect(res.tip.find((t) => t.source === E)!.state).toBe('unspent');
    expect(res.tip.find((t) => t.source === E2)!.state, 'not folded into the other').toBe('error');

    // never part of the proof: the verified custody result carries no liveness
    // field of its own, and re-verifying the same bundle offline reaches the
    // same answer with no outspend request made at all
    expect(Object.keys(res.custody)).not.toContain('tip');
    expect(Object.keys(res.custody)).not.toContain('unspent');
    const offline = verifyCustodyBundle(res.bundle, { powLimitBits: null });
    expect(offline.satpoint).toEqual(res.custody.satpoint);
  });

  // -------------------------------------------------------------------------
  // the accounting: the whole-spec sum lives in the core file
  // -------------------------------------------------------------------------

  it('SPEC-CUSTODY.md: this file speaks for exactly the fetch rows', () => {
    expect([...SPOKEN].sort()).toEqual(drivenIdsFor('fetch').sort());
    expect(idsFor('core').length, 'the core file drives no rows').toBeGreaterThan(0);
    expect(SPEC.length, 'the shared table reads the spec').toBeGreaterThan(0);
  });
});
