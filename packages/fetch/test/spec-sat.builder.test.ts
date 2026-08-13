/**
 * The SPEC-SAT rows whose code lives in @ordspv/fetch: the build loop's
 * walk-and-refuse accounting (`satbuilder.ts` and `failover.ts`), the option
 * that makes a builder emit a witness section for any reveal, and the anchor's
 * bar on the backend that built the bundle (`headertrust.ts`).
 *
 * The accounting table is shared with the core suite
 * (`packages/core/test/spec-sat.rows.ts`), and the accounting test that sums
 * the whole spec lives in `packages/core/test/spec-sat.conformance.test.ts`.
 * Neither file can lose a row: the table names which one drives each, and each
 * asserts it drives exactly the rows assigned to it.
 *
 * Several rows here are `tested at satbuilder.test.ts`, which drives the loop
 * against stubbed backends across its arms and its failure modes. What these
 * tests add is traceability from the spec sentence to an assertion, so they
 * are deliberately thin, and they drive the pure accounting function directly
 * where a whole build would say less about the rule.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CoinbaseHeightUnprovenError,
  CustodyUnsupportedError,
  EnvelopeIndexUnprovenError,
  hexToBytes,
  parseHeader,
} from '@ordspv/core';
import {
  ROOT,
  SPEC,
  anchor,
  drivenIdsFor,
  idsFor,
  row,
} from '../../core/test/spec-sat.rows.js';
import {
  EsploraBackend,
  REFUSAL_CLASS_FACTS,
  RevealSourceError,
  isRecordableBuildRefusal,
  makeHeaderTrust,
} from '../src/index.js';
import { sharedDomainRefusal, type DomainRefusal } from '../src/failover.js';
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
  it(`SPEC-SAT.md ${r.section}: ${r.title}`, async () => {
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

// ---------------------------------------------------------------------------

describe('SPEC-SAT conformance: the build loop', () => {
  // -------------------------------------------------------------------------
  // Envelope binding
  // -------------------------------------------------------------------------

  conformance('builder-section-on-request', () => {
    // "on request" is the whole of the MUST: a single-input reveal proves its
    // own numbering, so the SHOULD beside it leaves a builder free never to
    // emit one, and a consumer holding the inscriber inside its threat model
    // still needs `wtxid` there. The option is the request
    const source = readFileSync(join(ROOT, 'packages/fetch/src/satbuilder.ts'), 'utf8');
    expect(source).toMatch(/witnessSection\?: WitnessSectionMode/);

    const mode = readFileSync(join(ROOT, 'packages/fetch/src/custodybuilder.ts'), 'utf8');
    expect(mode, 'both values the mode takes').toContain(
      "export type WitnessSectionMode = 'always' | 'when-needed'",
    );
    // the one line where the SHOULD and the MUST part company: the default
    // skips a single-input reveal, and `always` is the request that makes the
    // builder emit one there too
    expect(mode).toContain("if (mode === 'when-needed' && reveal.inputs.length === 1) return undefined;");
  });

  // -------------------------------------------------------------------------
  // Terminal coinbase
  // -------------------------------------------------------------------------

  conformance('builder-fee-tail-below-boundary', () => {
    // what the substitution costs a caller, and the reason it is a rule: a
    // caller catching the out-of-scope class does not catch this one, so the
    // build cannot report a chain fact it does not have by reaching for the
    // nearer class
    const substituted = new CoinbaseHeightUnprovenError('below the boundary');
    expect(substituted).not.toBeInstanceOf(CustodyUnsupportedError);
    expect(substituted).toBeInstanceOf(Error);
    expect(substituted.name).toBe('CoinbaseHeightUnprovenError');

    // and neither class is terminal at build, so the substitution happens
    // inside the loop's own accounting rather than around it
    expect(REFUSAL_CLASS_FACTS.CoinbaseHeightUnprovenError.committedAtBuild).toBe(false);
    expect(REFUSAL_CLASS_FACTS.CustodyUnsupportedError.committedAtBuild).toBe(false);

    // the site itself, which is inside the build and not at the CLI, so a
    // library caller sees the substituted class too
    const source = readFileSync(join(ROOT, 'packages/fetch/src/satbuilder.ts'), 'utf8');
    expect(source).toMatch(/BIP34_ENFORCED_FROM/);
    expect(source).toMatch(/new CoinbaseHeightUnprovenError/);
  });

  // -------------------------------------------------------------------------
  // Genealogy bundle: the build loop
  // -------------------------------------------------------------------------

  conformance('refusal-not-terminal', () => {
    // which classes rotate is a table rather than a list kept in the loop, so
    // the predicate is driven against every row of it. An instance is made
    // from the prototype, since the constructors take unlike arguments and
    // `instanceof` is what the predicate reads
    const entries = Object.entries(REFUSAL_CLASS_FACTS);
    expect(entries.length).toBeGreaterThan(1);
    for (const [name, facts] of entries) {
      const instance = Object.create(facts.ctor.prototype) as Error;
      expect(
        isRecordableBuildRefusal(instance),
        `${name} rotates exactly when the reveal txid does not commit its deciding data`,
      ).toBe(!facts.committedAtBuild);
    }

    // and the exemption the sentence carries: a refusal the reveal txid
    // commits is terminal, which is the class raised on the reveal's own
    // input count
    expect(REFUSAL_CLASS_FACTS.EnvelopeIndexUnprovenError.committedAtBuild).toBe(true);
    expect(
      entries.filter(([, facts]) => !facts.committedAtBuild).length,
      'and it is the only one',
    ).toBe(entries.length - 1);
  });

  conformance('input-count-refusal-terminal', () => {
    // terminal is an arm in each loop rather than a property of the class, and
    // the only honest assertion is a source read of the two arms: no builder
    // raises the class, which the taxonomy comment beside its row records, so
    // neither arm is reachable through a build
    for (const file of ['satbuilder.ts', 'custodybuilder.ts']) {
      const source = readFileSync(join(ROOT, `packages/fetch/src/${file}`), 'utf8');
      expect(source, file).toContain('if (e instanceof EnvelopeIndexUnprovenError) throw e;');
    }

    // what is driven is the machinery that would have to agree with those
    // arms: the recording path cannot reach the class however the loop is
    // entered, because the table marks its deciding data committed at build
    expect(REFUSAL_CLASS_FACTS.EnvelopeIndexUnprovenError.committedAtBuild).toBe(true);
    expect(isRecordableBuildRefusal(new EnvelopeIndexUnprovenError('reveal spends 2 inputs'))).toBe(
      false,
    );
  });

  conformance('record-cause-and-walk-again', () => {
    // the cause is kept and attributed rather than folded into a count: two
    // backends refused, and the report names each with what it said
    const shared = sharedDomainRefusal(
      [refusal(A, 'fee tail as A saw it'), refusal(B, 'fee tail as B saw it')],
      2,
    );
    expect(shared?.message).toContain(A);
    expect(shared?.message).toContain(B);

    // where a group did not refuse, its cause is carried too, so a reader can
    // tell a backend that disagreed from one that never answered
    const partial = sharedDomainRefusal([refusal(A, 'fee tail')], 2, [
      { baseUrl: B, error: new Error('connection reset') },
    ]);
    expect(partial?.message).toContain('connection reset');
    expect(partial?.message).toContain(B);
  });

  conformance('refusal-from-served-data', () => {
    // the routing that makes the provenance rule true: the deciding requests
    // go to the member leading the attempt, by name, rather than through the
    // pool, so a refusal recorded under a name rests on what that name served
    const source = readFileSync(join(ROOT, 'packages/fetch/src/satbuilder.ts'), 'utf8');
    expect(source).toContain('revealSource: members[i]');
    // the deciding requests go through the lead by name rather than through
    // the pool, which is what makes a refusal recorded under a name rest on
    // what that name served
    expect(source).toMatch(/const lead = options\.revealSource/);

    // the ordering half: the served reveal's stripped hash is checked against
    // the inscription id's txid before anything is derived from those bytes
    expect(source).toContain('backend served ${tx.txid} for requested ${id.txid}');
    const check = source.indexOf('backend served ${tx.txid}');
    expect(check, 'the check is above the envelope read it guards').toBeLessThan(
      source.indexOf('has no envelope with index'),
    );
  });

  conformance('report-reach-and-other-groups', () => {
    // one call, three backends, one in each group: the reach marker and both
    // named groups are read off it
    const shared = sharedDomainRefusal(
      [refusal(A, 'fee tail')],
      3,
      [{ baseUrl: B, error: new Error('served the wrong transaction') }],
      [C],
    );
    expect(shared?.unanimous).toBe(false);
    expect(shared?.message).toContain('1 of 3 configured backends');
    expect(shared?.message).toContain('produced no usable answer');
    expect(shared?.message).toContain('served the wrong transaction');
    expect(shared?.message).toContain('never led an attempt');
    expect(shared?.message).toContain(C);

    // and the arrangement where every configured backend reached it, so the
    // marker is shown to vary rather than to be false always
    const all = sharedDomainRefusal([refusal(A, 'fee tail'), refusal(B, 'fee tail')], 2);
    expect(all?.unanimous).toBe(true);
    expect(all?.message).toContain('each configured backend led an attempt that ended this way');
  });

  conformance('unanimity-needs-two', () => {
    // one backend agreeing with itself: every part of unanimity is satisfied
    // except the count, since the other two groups are empty
    const alone = sharedDomainRefusal([refusal(A, 'fee tail')], 1);
    expect(alone?.unanimous).toBe(false);
    expect(alone?.message).toContain("one server's word");
    expect(alone?.message).toContain('a second configured backend');

    // the same arrangement with two configured backends does reach it
    const two = sharedDomainRefusal([refusal(A, 'fee tail'), refusal(B, 'fee tail')], 2);
    expect(two?.unanimous).toBe(true);
  });

  conformance('unanimity-means-served-data', () => {
    // the hash check seen from the marker, which is what keeps the marker's
    // claim true: a lead serving bytes for another transaction raises a class
    // the loop cannot record as a refusal, so it lands in the group that puts
    // unanimity out of reach rather than joining the count
    const wrongTx = new RevealSourceError(
      'reveal tx failed at the leading backend https://b.test: backend served aa.. for requested bb..',
    );
    expect(isRecordableBuildRefusal(wrongTx)).toBe(false);
    const withNoAnswer = sharedDomainRefusal([refusal(A, 'fee tail')], 2, [
      { baseUrl: B, error: wrongTx },
    ]);
    expect(withNoAnswer?.unanimous).toBe(false);
    expect(withNoAnswer?.message).toContain('produced no usable answer');

    // and the arrangement the marker is for, where every configured backend
    // led an attempt of its own and refused on what it served itself
    const both = sharedDomainRefusal([refusal(A, 'fee tail'), refusal(B, 'fee tail')], 2);
    expect(both?.unanimous).toBe(true);
  });

  conformance('caller-must-not-read-partial', () => {
    // what the library owes a caller obeying the rule: the marker is a
    // property of the error it catches rather than a phrase in a message it
    // would have to parse
    const partial = sharedDomainRefusal([refusal(A, 'fee tail')], 2, [
      { baseUrl: B, error: new Error('down') },
    ]);
    expect(partial).toBeInstanceOf(CustodyUnsupportedError);
    expect(partial?.unanimous).toBe(false);
    expect(typeof partial?.unanimous).toBe('boolean');

    // a refusal a verifier raised carries no marker at all, which is the
    // third state and the one a caller reads as proven
    const fromVerifier = new CustodyUnsupportedError('fee tail', 1000);
    expect((fromVerifier as { unanimous?: boolean }).unanimous).toBeUndefined();
  });

  conformance('builder-not-an-attester', async () => {
    const hash = HEADER.hash;
    // two attesters agree, and one of them served bytes for the bundle. The
    // threshold is met only by counting the one that built it
    const trust = makeHeaderTrust({
      esploras: [attester(A, hash), attester(B, hash)],
      minAgreement: 2,
      minConfirmations: 0,
      checkpoints: new Map(),
      proofSources: new Set([A]),
    });
    await expect(trust(HEADER, VOTED_HEIGHT)).rejects.toThrow(/agree/);

    // the same vote with an independent second source passes, so the refusal
    // above was the bar and not the arithmetic
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
  });

  // -------------------------------------------------------------------------
  // the accounting: the whole-spec sum lives in the core file
  // -------------------------------------------------------------------------

  it('SPEC-SAT.md: this file speaks for exactly the fetch rows', () => {
    expect([...SPOKEN].sort()).toEqual(drivenIdsFor('fetch').sort());
    expect(idsFor('core').length).toBeGreaterThan(0);
    // the file holding the sum over both tables, named so the split cannot
    // quietly become two half-accountings
    expect(SPEC).toContain('SPEC-SAT');
    expect(
      readFileSync(join(ROOT, 'packages/core/test/spec-sat.conformance.test.ts'), 'utf8'),
    ).toContain('every normative line is accounted for by a row in the table');
  });
});
