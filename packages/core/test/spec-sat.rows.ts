/**
 * The accounting table for SPEC-SAT.md, shared by the two files that speak for
 * it.
 *
 * Most of the spec binds `@ordspv/core` (`satnumber.ts`, and the helpers it
 * shares with `custody.ts`), so the main suite is
 * `packages/core/test/spec-sat.conformance.test.ts`. The rows whose code lives
 * in `@ordspv/fetch` are the build loop's walk-and-refuse accounting
 * (`satbuilder.ts`, `failover.ts`, `headertrust.ts`), driven from
 * `packages/fetch/test/spec-sat.builder.test.ts`. The table itself is one array
 * so the split cannot lose a row: the accounting test in the core file sums the
 * whole spec against every row here, whichever file drives it.
 *
 * Which sentences bind which package does not follow the section headings. The
 * builder rules are mostly the last section, but :128 sits in the envelope
 * binding section and binds builders, and :291 sits inside the builder
 * paragraph's own section and binds verifiers. Every row is assigned by reading
 * the code it asserts.
 *
 * THE KEYWORD FILTER. Measured on this file: 62 occurrences of MUST over 59
 * lines, 10 of them MUST NOT, and no REQUIRED, SHALL or RECOMMENDED anywhere.
 * The normative set here is therefore every line matching `/\bMUST\b/`, which
 * catches MUST NOT as well. SPEC-VERIFICATION needed `MUST|REQUIRED` because it
 * states three requirements with REQUIRED alone; widening the pattern here
 * would change nothing, and narrowing it below MUST is not available. The five
 * SHOULD lines (:128, :134, :233, :273, :274) and the one MAY (:70) are outside
 * the set by that choice and are named in the rows whose sentences carry them, so
 * a reader can see they were read rather than missed. This spec has no RFC 2119
 * boilerplate line, so nothing is excluded by name.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SPEC_PATH = join(ROOT, 'docs/spec/SPEC-SAT.md');
export const SPEC = readFileSync(SPEC_PATH, 'utf8');

/**
 * `tested here` and `tested at <path>: <test name>` both mean a test asserts
 * the behaviour, the second naming a test elsewhere that carries the load.
 * The third is for a rule no bundle can present, where a check that runs first
 * decides every reachable case: the row says which check that is and what a
 * bundle would have to contain to get past it. The fourth is the outcome this
 * suite exists to surface: a requirement with no code behind it, whose test is
 * reported rather than committed green.
 */
export type Status =
  | 'tested here'
  | `tested at ${string}`
  | `unreachable through a bundle, met by a check that runs first: ${string}`
  | `unimplemented, reported as a finding: ${string}`;

/**
 * A requirement with no code behind it. Written as a call rather than as a
 * concatenation, since concatenated literals widen to `string` and would drop
 * out of the `Status` union without a word from `tsc`.
 */
function finding(detail: string): Status {
  return `unimplemented, reported as a finding: ${detail}`;
}

/** A rule no bundle can present, for the same reason `finding` is a call. */
function unreachable(detail: string): Status {
  return `unreachable through a bundle, met by a check that runs first: ${detail}`;
}

export interface Requirement {
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
  /** which of the two files drives this row */
  file: 'core' | 'fetch';
  /** why the status is what it is, and what the test does not reach */
  why: string;
}

export const TABLE: Requirement[] = [
  // -------------------------------------------------------------------------
  // Sat numbering
  // -------------------------------------------------------------------------
  {
    id: 'theoretical-subsidy',
    section: 'Sat numbering',
    title:
      'implementations MUST number by the theoretical subsidy, and an underpaid one MUST NOT shift later blocks',
    quote:
      'Implementations MUST number sats by the *theoretical* subsidy. An underpaid or\n' +
      'unclaimed subsidy MUST NOT shift the numbers of later blocks, because ordinals\n' +
      'depend on how many sats could have been mined rather than on how many were.',
    binds: 'implementations that number sats',
    status: 'tested here',
    file: 'core',
    why:
      'two clauses of different reach. The first is driven through a whole bundle whose ' +
      'terminal coinbase pays out less than its subsidy: the sat the walk folds to is ' +
      'the schedule position, unmoved by what the block actually paid. The second is ' +
      'about blocks a genealogy never reads, so no bundle can show it and the test ' +
      'drives `firstSatOfBlock` directly, across both sides of an epoch boundary: ' +
      'consecutive first sats differ by the theoretical subsidy at every height, so ' +
      'nothing an underpaying block does can reach a later one.',
  },

  // -------------------------------------------------------------------------
  // Start position in the reveal
  // -------------------------------------------------------------------------
  {
    id: 'prevtx-supply',
    section: 'Start position',
    title: 'a bundle MUST supply prev txs for inputs 0..k and verifiers MUST use every one supplied',
    quote:
      'A bundle MUST supply prev txs for inputs `0..k` so the\n' +
      "envelope input's value is proven, MAY supply more, and MUST supply enough to\n" +
      'reach the start position. Verifiers MUST use every prev tx supplied.',
    binds: 'bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'three clauses, and the middle one is the MAY that this suite does not count. The ' +
      'floor is driven by removing the envelope input\'s entry, which is refused by the ' +
      'input it names rather than by a count. "Every prev tx supplied" is driven in the ' +
      'arrangement that separates it from "enough to reach": a two-input reveal whose ' +
      'position sits in input 0, where input 1\'s value can change nothing, and whose ' +
      'second entry is a real transaction the input does not name. A verifier reading ' +
      'only as far as the position needs would accept it. The reach clause is stated ' +
      'again at :160 and driven by the values-reach-position row, since it is the same ' +
      'rule seen from the verifier side.',
  },
  {
    id: 'prevtx-surplus',
    section: 'Start position',
    title: 'a bundle MUST NOT supply more prev txs than inputs and verifiers MUST refuse one that does',
    quote:
      'MUST NOT supply more prev txs than the transaction has inputs, and verifiers\n' +
      'MUST refuse a bundle that does: an entry past the input count corresponds to',
    binds: 'bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the refusal is driven at the reveal and at a funding step, which are the two ' +
      'shapes carrying a prev tx list a verifier walks, with the surplus entry a copy of ' +
      'an entry the bundle already carries. That is the case a verifier ignoring the ' +
      'surplus would accept, since every entry it reads hashes correctly. The terminal ' +
      'coinbase is the third shape and has a stricter rule of its own at :75.',
  },
  {
    id: 'coinbase-empty-prevtxs',
    section: 'Start position',
    title: 'the terminal coinbase hop MUST carry an empty prevTxs list and verifiers MUST refuse a nonempty one',
    quote:
      'The terminal coinbase hop MUST carry an empty `prevTxs` list, since its only\n' +
      'input is the null prevout and no supplied prev tx can be used; verifiers MUST\n' +
      'refuse a coinbase hop whose list is nonempty.',
    binds: 'bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the count rule of :72 would admit one entry here, since a coinbase has one input, ' +
      'so the one-entry case is what the test drives first and the reason the rule is ' +
      'stated separately. A longer list is driven beside it and the empty list the ' +
      'reference builder writes still verifies.',
  },
  {
    id: 'fee-bound-reveal',
    section: 'Start position',
    title: 'verifiers MUST refuse a start position at or past the total output sats',
    quote:
      "to fee sats (ord routes it through the block's coinbase); verifiers MUST\n" +
      'refuse (`CustodyUnsupportedError`), not guess.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the reveal is built so the default start position lands at or past its total ' +
      'output sats: two inputs, the envelope on the second, and outputs worth less than ' +
      'the first input. The refusal is asserted to be the class callers discriminate on ' +
      'and to carry the reveal block\'s height. The same reveal verified as far as its ' +
      'envelope binding, so the refusal is the position rule and not an earlier check. ' +
      'What the test does not reach is the pointer branch, which the sentence says ' +
      'cannot reach it: `pointer < totalOut` is that branch\'s own gate, asserted here ' +
      'by driving a pointer at the same reveal and reading the position it produces.',
  },
  {
    id: 'unbound-refusal',
    section: 'Start position',
    title: 'v1 MUST refuse an unbound inscription',
    quote:
      'in the envelope) have no chain location and therefore no sat to name. v1 MUST\n' +
      'refuse (`CustodyUnsupportedError`).',
    binds: 'v1 implementations',
    status: 'tested here',
    file: 'core',
    why:
      'the sentence names two conditions and both are driven: a commit paying zero to ' +
      'the envelope input, and an envelope carrying an unrecognized even field, which is ' +
      "ord's other unbound rule and reaches the same refusal from the envelope bytes " +
      'alone. Both are asserted to carry the class rather than a number, since the ' +
      'failure this guards is a verifier naming a sat for an inscription that has none.',
  },

  // -------------------------------------------------------------------------
  // Envelope binding
  // -------------------------------------------------------------------------
  {
    id: 'binding-before-position',
    section: 'Envelope binding',
    title: 'verifiers MUST bind the envelope before deriving a start position and MUST record indexProof',
    quote:
      'Verifiers MUST perform the envelope binding of SPEC-CUSTODY at the reveal\n' +
      'before deriving a start position, including its two-way index rule, and\n' +
      'MUST record the way the index was proven in `indexProof`:',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"before deriving a start position" is the load-bearing clause, so the test drives ' +
      'a reveal whose witness was rewritten to carry a pointer naming another sat under ' +
      'an unchanged txid: a verifier deriving first and binding afterwards would fold to ' +
      "the forged sat and only then object. Both values of `indexProof` are read off " +
      'bundles that verify, since a field that never varies would satisfy a thinner ' +
      'test. The two-way index rule is :106 and :111, whose own rows drive the arms.',
  },
  {
    id: 'witness-section-no-fallback',
    section: 'Envelope binding',
    title: 'a reveal hop carrying a witness section MUST be verified against the block commitment with no fallback',
    quote:
      '- a reveal hop carrying a witness section MUST be verified against the\n' +
      "  block's BIP-141 witness commitment as SPEC-CUSTODY specifies, with no\n" +
      '  fallback past a section that fails.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"no fallback" is the half a thin test would miss, so the section is broken on a ' +
      'reveal that would verify without one at all: a single-input reveal, which :111 ' +
      'says needs nothing more, carrying a section that does not fold. A verifier ' +
      'falling back reports `single-input` and a sat; this one refuses. The success ' +
      'arm is driven on a multi-input reveal, where the section is the only thing that ' +
      'can prove the numbering, and the residual clause under it is `singleLeafTree`, ' +
      'reported beside the answer.',
  },
  {
    id: 'multi-input-no-section-refused',
    section: 'Envelope binding',
    title: 'a verifier MUST refuse a reveal with more than one input and no witness section',
    quote: 'A verifier MUST refuse a reveal with more than one input and no witness',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'that the refusal happens at all, where the two rows after it are about how it ' +
      'reads and when it fires. It is driven at index 0, which is the case a verifier ' +
      'could think it knows without proof: the first envelope it finds is the one the ' +
      'id asks for, whatever the other input carries. The same reveal one input ' +
      'shorter is read, and the same two-input reveal with a section is read, so the ' +
      'refusal is the input count meeting the absent proof rather than anything else ' +
      'in the document.',
  },
  {
    id: 'unproven-index-distinguishable',
    section: 'Envelope binding',
    title: 'the verifier MUST refuse an unprovable index distinguishably from a forgery, naming the count and the index',
    quote:
      'verifier MUST refuse it distinguishably from a forgery\n' +
      "(`EnvelopeIndexUnprovenError`), naming the reveal's input count and the\n" +
      'requested index',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'a multi-input reveal with no section is refused, and the refusal is read for the ' +
      'three things the sentence asks of it: a class of its own rather than a plain ' +
      'Error, the input count, and the index asked for. The same bundle with the section ' +
      'attached verifies, so the refusal is shown to be about the missing proof rather ' +
      'than about the reveal.',
  },
  {
    id: 'unproven-index-before-selection',
    section: 'Envelope binding',
    title: 'the verifier MUST refuse before selecting an envelope',
    quote:
      'The verifier MUST refuse before selecting an envelope,\n' +
      'because the envelope count of such a reveal is itself unproven',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'ordering, so it is driven with an index no envelope holds: without a section the ' +
      'refusal names the unprovable numbering and never says the index is absent, and ' +
      'with a section the same index reaches the absence message, which is a count the ' +
      'bundle can now support. A verifier selecting first would report absence in both.',
  },
  {
    id: 'input-k-checks',
    section: 'Envelope binding',
    title: 'at input k the verifier MUST reject a key-path spend, MUST reject a non-P2TR prevout, and MUST verify the BIP-341 commitment',
    quote:
      'At input `k` itself, in every case, the verifier MUST reject a key-path\n' +
      'spend, MUST reject a prevout scriptPubKey that is not P2TR, and MUST verify\n' +
      'the BIP-341 script-path commitment, rejecting the bundle when it does not',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'three checks on one input, each driven on its own bundle. The non-P2TR arm ' +
      'replaces the commit with one paying a bare script, and the commitment arm serves ' +
      'a witness the commit output never committed under an unchanged txid. The key-path ' +
      'arm is driven at `verifyEnvelopeBinding` rather than through a bundle, because an ' +
      'input spent by key path carries no envelope for ord to number, so no bundle can ' +
      'present one at input k; the check guards callers of the helper, which the ' +
      'genealogy verifier is.',
  },
  {
    id: 'section-only-at-reveal',
    section: 'Envelope binding',
    title: 'the verifier MUST accept a witness section only at the reveal and MUST refuse one elsewhere',
    quote:
      'The verifier MUST accept a witness section only at the reveal, and MUST\n' +
      'refuse a bundle carrying one on a funding step or on the terminal coinbase',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'both forbidden positions are driven, with a section that verifies at the reveal ' +
      'of the same bundle, so the refusal rests on where it sits. A falsy value is ' +
      'driven at both too, since the guard reads presence rather than truth and untrusted ' +
      'JSON can carry `"witness": 0`; `GenealogyStepJson` declares no such field, so ' +
      'only untrusted JSON reaches the funding-step arm at all.',
  },
  {
    id: 'builder-section-on-request',
    section: 'Envelope binding',
    title: 'builders MUST be able to emit a witness section for any reveal on request',
    quote:
      'Builders SHOULD emit the section for multi-input reveals, and MUST be\n' +
      'able to emit it for any reveal on request',
    binds: 'builders',
    status:
      'tested at packages/fetch/test/satbuilder.test.ts: witnessSection always attaches a section to a single-input reveal',
    file: 'fetch',
    why:
      '"any reveal" is what separates the MUST from the SHOULD beside it: a single-input ' +
      'reveal proves its own numbering, so a builder could reasonably never emit one, and ' +
      'a consumer holding the inscriber inside its threat model needs `wtxid` there too. ' +
      'The cited test drives `witnessSection: always` against a single-input reveal and ' +
      'reads `wtxid` off the verification. The re-assert here reads the option off the ' +
      'builder surface and asserts the default leaves single-input reveals alone, which ' +
      'is the SHOULD half and the reason the MUST needs asking for.',
  },

  // -------------------------------------------------------------------------
  // Backward step
  // -------------------------------------------------------------------------
  {
    id: 'values-from-prevtxs',
    section: 'Backward step',
    title: 'input values MUST come from the referenced prev txs and each MUST hash to the txid the input names',
    quote:
      'Input values MUST come from the referenced previous\n' +
      "transactions, and each previous transaction's bytes MUST hash to the txid the\n" +
      'input names.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the hash rule is driven with a prev tx that is a real transaction of the right ' +
      'shape and the wrong identity, refused by name at the entry that carries it. That ' +
      'the values then come from those bytes is driven by editing the funded output\'s ' +
      'value in a prev tx: the edit moves the txid, so a verifier reading values from ' +
      'anywhere else would have to be given them, and the refusal is the hash. Both the ' +
      'reveal hop and a funding step are driven, which are the two places the walk reads ' +
      'values.',
  },
  {
    id: 'prevtx-alignment',
    section: 'Backward step',
    title:
      'a bundle MUST align prev txs from input 0 as a prefix, and a verifier MUST read them at those positions',
    quote:
      'A bundle MUST align prev txs from input 0 so that they form a prefix of\n' +
      'the input list, and a verifier MUST read them at those positions.',
    binds: 'bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'positional rather than matched by txid, which is only visible where two entries ' +
      'differ. Every two-input fixture above spends one commit twice, so their entries ' +
      'are interchangeable and a swap there would prove nothing; this row gets a ' +
      'funding step with two inputs from two different transactions. Swapping its ' +
      'entries is refused at entry 0, and so is supplying the entry for input 1 alone, ' +
      'which is the sharper arm: that entry is the one the answer needs, it is correct, ' +
      'and it is still refused for not being at its position. A verifier matching by ' +
      'txid accepts both. That input 1 is load-bearing at all is driven beside them, by ' +
      'supplying input 0 alone and reading the shortfall.',
  },
  {
    id: 'values-reach-position',
    section: 'Backward step',
    title: 'a verifier whose supplied values do not reach the position MUST reject and say so',
    quote:
      'verifier whose supplied values do not reach the position MUST reject and say so\n' +
      'rather than assume the sat came from an input it cannot value.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"and say so" is the half with a class behind it: `SatFundingIncompleteError` says ' +
      'the document stopped short, where `SatPositionError` says it contradicts itself, ' +
      'and the two are asserted apart from each other on the same fixture. The ' +
      'arrangement is a pointer landing in an input later than the envelope\'s, with the ' +
      "prev tx list stopping at the envelope input, which is the case where assuming " +
      'would name a sat from the only input the bundle valued.',
  },

  // -------------------------------------------------------------------------
  // Terminal coinbase
  // -------------------------------------------------------------------------
  {
    id: 'coinbase-fee-tail',
    section: 'Terminal coinbase',
    title: 'v1 MUST refuse a position in the coinbase fee tail',
    quote:
      'v1 MUST refuse\n' +
      '  (`CustodyUnsupportedError`), symmetric with forward custody.',
    binds: 'v1 implementations',
    status: 'tested here',
    file: 'core',
    why:
      'the boundary is the whole of the rule, so the same chain is driven twice with one ' +
      'value moved across it: a coinbase whose first output ends one sat below the ' +
      'subsidy yields a number, and the same chain with that output one sat longer ' +
      'refuses. The refusal names the block, since a caller told only that the sat is ' +
      'beyond v1 cannot tell which block it would have to account for.',
  },
  {
    id: 'height-never-unchecked',
    section: 'Terminal coinbase',
    title: 'verifiers MUST NOT accept a claimed height unchecked',
    quote: 'so verifiers MUST NOT accept a claimed height unchecked.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the umbrella over the two arms below it, so the test drives one bundle on each ' +
      'side of the boundary with nothing to check the claim: below, no trust hook; above, ' +
      'a coinbase whose scriptSig carries no height. Both refuse. The same two bundles ' +
      'with their checks in place verify, which is what makes the refusals the height ' +
      'rule rather than the rest of the document.',
  },
  {
    id: 'bip34-parse-and-reject',
    section: 'Terminal coinbase',
    title: 'at or above 230,000 verifiers MUST parse the BIP34 height and MUST reject a contradicting claim',
    quote:
      'At heights at or above 230,000, verifiers MUST parse the BIP34 height from the\n' +
      "coinbase's own scriptSig (first push, little-endian) and MUST reject a bundle\n" +
      'whose claimed height contradicts it.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the little-endian reading is asserted against a push written out byte by byte, ' +
      'since a verifier reading it the other way round would refuse every honest bundle ' +
      'and pass no test that only checks refusals. The contradiction arm moves the ' +
      'claimed height alone, leaving the push, and the absent-push arm carries a ' +
      'scriptSig that is not a height at all. The boundary itself is asserted by driving ' +
      'the same unparseable coinbase below it, where the rule does not bite.',
  },
  {
    id: 'sub-bip34-refusal',
    section: 'Terminal coinbase',
    title: 'a verifier MUST refuse a sub-230,000 coinbase height unless the hook attested the block hash at it',
    quote:
      'A verifier MUST refuse a bundle whose terminal coinbase claims a height\n' +
      "below 230,000 unless the caller's header trust hook attested the block hash at",
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'one bundle, driven with and without the attestation, which is the only difference ' +
      'between the two calls. The hook is asserted to have been asked about the terminal ' +
      "coinbase's own header at the claimed height, since a hook attesting some other " +
      'header would bind nothing and the verifier reads one answer.',
  },
  {
    id: 'hook-must-state-what-it-checked',
    section: 'Terminal coinbase',
    title: 'a verifier MUST NOT accept on the hook presence alone and MUST read acceptance only from what the hook states',
    quote:
      'A verifier MUST NOT accept such a\n' +
      "height on the hook's presence alone: a hook that runs and returns without\n" +
      'objecting may have checked nothing at all, so the hook MUST say what it\n' +
      'checked, and the verifier MUST read acceptance only from that statement',
    binds: 'verifiers and header trust hooks',
    status: 'tested here',
    file: 'core',
    why:
      'the hole the sentence closes is a hook that runs and returns quietly, so that is ' +
      'the arm driven: the hook is called, records the heights it saw, returns nothing, ' +
      'and the bundle is still refused. The same hook returning the marker accepts, and ' +
      'a hook returning some other value is refused too, so acceptance is read from the ' +
      'statement rather than from the hook having answered at all.',
  },
  {
    id: 'sub-bip34-refusal-named',
    section: 'Terminal coinbase',
    title: 'the refusal MUST be distinguishable from a forgery and MUST name the claimed height and the boundary',
    quote:
      'The refusal\n' +
      'MUST be distinguishable from a forgery (`CoinbaseHeightUnprovenError` in the\n' +
      'reference implementation), since such a bundle can be honest and merely\n' +
      'unprovable offline, and the refusal MUST name the claimed height and the',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'distinguishable is asserted against the two classes it could be confused with and ' +
      'not only against its own name: a forgery is a plain Error and an out-of-domain ' +
      'path is `CustodyUnsupportedError`, and this is neither. Both numbers the sentence ' +
      'asks for are read out of the message, and the remedy it names is there too, since ' +
      'a caller told only that the height is unproven has nothing to do next.',
  },
  {
    id: 'no-sat-for-unproven-height',
    section: 'Terminal coinbase',
    title: 'a verifier MUST NOT report a sat number, name or rarity for such a bundle',
    quote:
      'A verifier MUST NOT report a sat number, name or rarity for\n' +
      'such a bundle',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'a refusal that throws reports nothing, so what the test establishes is that the ' +
      'three fields exist to be suppressed: the same bundle with the attestation returns ' +
      'all three, and without it the call produces no result object at all. The reason ' +
      'the sentence names is driven beside it, on the fixture that shows it: the same ' +
      'bundle re-claimed at height 0 yields sat 0 at mythic, so a server choosing the ' +
      'height chooses the rarity.',
  },
  {
    id: 'builder-fee-tail-below-boundary',
    section: 'Terminal coinbase',
    title: 'a builder MUST NOT report a fee-tail refusal as out of scope below 230,000',
    quote:
      'A builder MUST NOT report a fee-tail\n' +
      'refusal as out of scope when the terminal coinbase is below 230,000 and its\n' +
      'claimed height is not otherwise established',
    binds: 'builders',
    status:
      'tested at packages/fetch/test/satbuilder.test.ts: refuses a sub-boundary fee tail as CoinbaseHeightUnprovenError, never out of scope',
    file: 'fetch',
    why:
      'the refusal turns on the subsidy boundary, which the claimed height decides, so a ' +
      'build reporting out of scope on an unproven height asserts a chain fact it does ' +
      'not have. The cited test drives a live build on both sides of 230,000 and reads ' +
      'the class each one ends with. The re-assert here is the taxonomy consequence, ' +
      'which is what a caller sees: the two classes report different categories and exit ' +
      'codes, so the substitution is not cosmetic.',
  },

  // -------------------------------------------------------------------------
  // Genealogy bundle
  // -------------------------------------------------------------------------
  {
    id: 'format-coinbase-pos-and-prevtxs',
    section: 'Genealogy bundle',
    title: 'the terminal coinbase tx.pos MUST be 0 and its prevTxs MUST be empty',
    quote: 'tx.pos MUST be 0, prevTxs MUST be empty',
    binds: 'bundles and the verifiers that read them',
    status: 'tested here',
    file: 'core',
    why:
      'the position half is the one with no other statement of it in the spec, and it is ' +
      'driven through a bundle whose coinbase is otherwise honest: the claimed position ' +
      'is moved to 1 and the refusal names position 0. It fires above the merkle fold, ' +
      'which is what makes it a rule of its own rather than a consequence of the branch ' +
      'not matching, and the test asserts the message rather than the throw for that ' +
      'reason. The prevTxs half restates :75, whose row drives the message variants.',
  },
  {
    id: 'endpoint-anchoring',
    section: 'Genealogy bundle',
    title: 'verifiers MUST recompute the header hash, check PoW, require a valid txCount and branch depth, and fold the branch, at both endpoints',
    quote:
      'Verifiers MUST, for the reveal and the coinbase: recompute the header hash,\n' +
      'check proof of work, require a valid `txCount` and a branch depth equal to\n' +
      '`treeHeight(txCount)` (CVE-2017-12842 hardening, as in SPEC-VERIFICATION), and\n' +
      "fold the txid branch to the header's merkle root.",
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"for the reveal and the coinbase" is the clause a one-endpoint test would miss, so ' +
      'each of the four checks is broken at each endpoint in turn and the refusal is ' +
      'asserted to name the endpoint it was broken at. The proof-of-work half is driven ' +
      'as the mainnet floor, which is the check that refuses these regtest headers; ' +
      '`checkProofOfWork` against the header\'s own nBits is driven at ' +
      'packages/core/test/spec-verification.conformance.test.ts, since a header failing ' +
      'its own target has to be mined for the purpose.',
  },
  {
    id: 'sixty-four-byte-endpoints',
    section: 'Genealogy bundle',
    title: 'the reveal and the coinbase MUST be rejected at a stripped size of 64 bytes',
    quote:
      'MUST be rejected at a stripped size of 64 bytes, since their txids are folded\n' +
      'through a merkle branch and a 64-byte stripped transaction is indistinguishable',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'both named endpoints are driven, each on a bundle whose walk reaches it, and the ' +
      'refusal names the endpoint. The guard runs above the txid comparison at each, ' +
      'which is why a 64-byte transaction that hashes to nothing the chain expects still ' +
      'reaches it. The funding step is driven beside them: :233 makes that a SHOULD and ' +
      'the implementation runs the same guard there, so the test records what the code ' +
      'does rather than only what this line requires. The prev-tx carve-out of :234 is ' +
      'not driven, and no test in this repository drives it, because a 64-byte ' +
      'transaction has no room for the P2TR output an envelope input has to spend.',
  },
  {
    id: 'bundle-binds-envelope',
    section: 'Genealogy bundle',
    title: 'verifiers MUST additionally bind the reveal envelope and its index',
    quote:
      'Verifiers MUST additionally bind the\n' +
      "reveal's envelope and its index as the envelope binding section requires.",
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"additionally" is what this row carries beyond :102: the anchoring list above it ' +
      'is not enough on its own. The test drives a bundle whose four anchoring checks all ' +
      'pass, asserted by verifying the same hop before the tamper, and whose witness was ' +
      'then rewritten under an unchanged txid. A verifier that ran the list and stopped ' +
      'reports a sat for it.',
  },
  {
    id: 'duplicate-transaction',
    section: 'Genealogy bundle',
    title: 'verifiers MUST reject a duplicate transaction among the reveal and the funding steps',
    quote: 'Verifiers MUST reject a duplicate transaction among the reveal and the funding',
    binds: 'verifiers',
    status: unreachable(
      "each funding step is required to hash to the txid the previous step's input " +
        'named, and that check runs above the duplicate test',
    ),
    file: 'core',
    why:
      'a duplicate can only reach the duplicate test if the walk arrives twice at one ' +
      'txid, and the walk follows inputs backward, so arriving twice means a cycle in the ' +
      'transaction graph and therefore a sha256d cycle. The test drives what a bundle ' +
      'repeating a transaction actually gets, which is the chain-order refusal naming ' +
      'both txids, and asserts the duplicate guard is still in the verifier. That the ' +
      'guard is unreachable is a property of the walk rather than of this bundle: the ' +
      'custody verifier walks forward with a server naming each next transaction, where ' +
      'the same rule is reachable, which is why the spec states it.',
  },
  {
    id: 'coinbase-not-a-funding-step',
    section: 'Genealogy bundle',
    title: 'verifiers MUST reject a coinbase appearing as a funding step',
    quote:
      'steps, and MUST reject a coinbase appearing as a funding step rather than as\n' +
      'the terminal element.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'reachable where the duplicate rule beside it is not: the real terminal coinbase is ' +
      'appended to the funding list and named as the terminal element too, so it hashes ' +
      'to exactly the txid the chain expects and every other check on it passes. A ' +
      'verifier without the rule walks through it and numbers the sat off a coinbase it ' +
      'never applied the terminal rules to.',
  },
  {
    id: 'verifier-step-cap',
    section: 'Genealogy bundle',
    title: 'a verifier MUST bound the number of funding steps it reads',
    quote:
      'A verifier MUST\n' +
      "bound the number of funding steps it reads; the reference verifier's cap is\n" +
      '10,000.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'that the cap is there without a caller supplying one, which is what separates ' +
      'this from the row below: that one passes its own cap in. Both sides of the ' +
      'default are driven, 10,001 steps refused and 10,000 admitted, so the number the ' +
      'sentence names is the boundary rather than a figure the message happens to ' +
      'print. The steps are junk, because the bound is read off the array length above ' +
      'every evidence read, which is the property that makes it a guard against a ' +
      'hostile document rather than a limit on honest ones.',
  },
  {
    id: 'step-cap-distinguishable',
    section: 'Genealogy bundle',
    title: 'a verifier refusing a bundle for exceeding its cap MUST report that distinguishably from invalid',
    quote:
      'verifier that refuses a bundle for exceeding its cap MUST report that refusal\n' +
      'distinguishably from a bundle it found invalid, since a bundle deeper than the\n' +
      'cap may be honest and the caller may raise the cap and read it.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the sentence gives its own test: the same bytes are refused under a low cap and ' +
      'read under a raised one, so the refusal cannot have been about the document. The ' +
      'class is asserted rather than the message, since a caller raising the cap ' +
      'discriminates on it, and the message is asserted to carry both numbers so the ' +
      'caller knows what to raise it to.',
  },
  {
    id: 'claimedsat-refolded',
    section: 'Genealogy bundle',
    title: 'verifiers MUST fold the genealogy themselves and reject on mismatch',
    quote:
      '`claimedSat` is a claim. Verifiers MUST fold the genealogy themselves and\n' +
      'reject on mismatch.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the fold is asserted to be the source of the answer and not the claim: the ' +
      'returned sat equals the number the walk implies, a claim one off is refused, and ' +
      'the refusal names what the genealogy folded to rather than only that the claim was ' +
      'wrong. The forms `BigInt` would accept while meaning something else are driven ' +
      'too, since a lenient parse would let the empty string reach the comparison as ' +
      'zero.',
  },

  // -------------------------------------------------------------------------
  // Genealogy bundle: the build loop
  // -------------------------------------------------------------------------
  {
    id: 'refusal-not-terminal',
    section: 'Build loop',
    title: 'a builder MUST NOT treat a build-time refusal as terminal while another backend is configured',
    quote:
      'A builder MUST NOT treat a build-time refusal as terminal while\n' +
      'another backend is configured unless the refusal was derived from data the\n' +
      'reveal txid commits.',
    binds: 'builders',
    status:
      'tested at packages/fetch/test/satbuilder.test.ts: asks the next backend when one serves an unbound envelope',
    file: 'fetch',
    why:
      'which classes rotate is a table rather than a list kept in the loop, so the ' +
      're-assert reads the table: every class the loop records answers false to ' +
      '`committedAtBuild`, and the one class the sentence exempts, an index unprovable ' +
      "from the reveal's own input count, is not recordable and leaves the loop. The " +
      'cited test drives the rotation itself against a backend serving an unbound ' +
      'envelope, and satbuilder.test.ts drives the same rotation for a pointer outside ' +
      'the reveal, a fee tail, an uncommitted tapscript and the step cap.',
  },
  {
    id: 'input-count-refusal-terminal',
    section: 'Build loop',
    title: 'a builder MUST treat a refusal raised on the count of inputs as terminal',
    quote: "reveal's input count is such data, so a builder MUST treat a refusal raised on",
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the named instance of the rule above it, and the only honest thin assertion is a ' +
      'source read of the terminal arm in both loops, which is worth saying plainly ' +
      'rather than dressing up. No builder raises the class today, as the taxonomy ' +
      'comment beside its row records, so neither arm is reachable through a build and ' +
      'satbuilder.test.ts asserts twice that a multi-input build ends at the ' +
      'witness-section class instead. What is driven is the machinery that would have ' +
      'to agree with the arms: the class is the one the table marks committed at build, ' +
      'so the recording path cannot reach it however the loop is entered.',
  },
  {
    id: 'record-cause-and-walk-again',
    section: 'Build loop',
    title: "a builder MUST record the rest as that backend's cause and walk again with the next one",
    quote: 'A builder MUST record the rest as that',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the recording is what the report is assembled from, so the re-assert drives ' +
      '`sharedDomainRefusal` over refusals from named backends and reads each cause back ' +
      'beside the name that produced it. What the loop does with the record is the ' +
      'rotation of the row above; what this row holds is that the cause is kept and ' +
      'attributed rather than folded into a count.',
  },
  {
    id: 'refusal-from-served-data',
    section: 'Build loop',
    title: 'a builder MUST derive each recorded refusal from data the named backend served, having checked the reveal hash first',
    quote:
      'A builder MUST\n' +
      'derive each recorded refusal from reveal bytes and from a coinbase height the\n' +
      "named backend itself served, and MUST have checked the served reveal's\n" +
      "stripped hash against the inscription id's txid before deriving anything from\n" +
      'those bytes.',
    binds: 'builders',
    status:
      'tested at packages/fetch/test/satbuilder.test.ts: never records a refusal derived from wrong-txid reveal bytes',
    file: 'fetch',
    why:
      'two requirements about where a recorded refusal comes from. The cited test drives ' +
      'the ordering half: a lead serving a reveal for another transaction is recorded as ' +
      'producing no usable answer, never as a refusal, because the hash check runs above ' +
      'anything derived from those bytes. The provenance half is driven at ' +
      'satbuilder.test.ts by refusing unanimity over a coinbase height one member alone ' +
      'served, and the re-assert here reads the routing that makes it true: the options ' +
      'the loop passes name one member for the deciding requests, and a refusal recorded ' +
      'under a name has to rest on what that name served.',
  },
  {
    id: 'report-reach-and-other-groups',
    section: 'Build loop',
    title: 'a builder MUST report whether every configured backend reached the refusal and MUST name the other two groups',
    quote:
      'A builder MUST report\n' +
      'whether every configured backend reached that same refusal, and MUST name the\n' +
      'backends that produced no usable answer and the backends that led no attempt',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the reach marker and the two groups are one report, so the test reads all three ' +
      'off one call: a refusal over three backends where one refused, one answered ' +
      'nothing and one never led. Both other groups are named with what ended them, the ' +
      'marker is false, and the arrangement where every backend refused is driven beside ' +
      'it so the marker is shown to vary. The accounting identity that keeps the report ' +
      'honest, the three groups summing to the configured count, is driven at ' +
      'packages/fetch/test/failover.test.ts.',
  },
  {
    id: 'unanimity-needs-two',
    section: 'Build loop',
    title: 'a builder MUST report a refusal as reaching every configured backend only when at least two were configured',
    quote:
      'A builder MUST report a refusal as reaching every\n' +
      'configured backend only when at least two backends were configured',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'one backend agreeing with itself is the case the rule exists for, so it is driven ' +
      'directly: a single configured backend that refused, with the other two groups ' +
      'empty, which satisfies every part of unanimity except the count. The marker is ' +
      'false and the message says what a second backend would add. Two backends in the ' +
      'same arrangement are driven beside it.',
  },
  {
    id: 'unanimity-means-served-data',
    section: 'Build loop',
    title:
      "a builder MUST NOT report a refusal as reaching every configured backend unless each rests on that backend's own served data",
    quote:
      'A builder MUST NOT report a\n' +
      "refusal as reaching every configured backend unless each backend's refusal rests\n" +
      'on reveal bytes and a terminal coinbase height that backend itself served, with\n' +
      "the served reveal's stripped hash checked against the inscription id's txid.",
    binds: 'builders',
    status:
      'tested at packages/fetch/test/satbuilder.test.ts: refuses unanimity over a coinbase height one member alone served',
    file: 'fetch',
    why:
      'the marker read as a claim about provenance, where the two rows above it read it ' +
      'as a count. The cited test builds against members where one alone served the ' +
      'height the refusal turns on and reads the marker false; "keeps unanimity when ' +
      'each member served the fee-tail coinbase status itself" is the other side of it, ' +
      'and the reveal-bytes half of the sentence has the same pair. The re-assert here ' +
      'is the mechanism that keeps the claim true, which is the hash check seen from ' +
      'the marker: a lead serving bytes for another transaction raises a class the loop ' +
      'cannot record as a refusal, so it lands in the group that puts unanimity out of ' +
      'reach instead of joining the count.',
  },
  {
    id: 'caller-must-not-read-partial',
    section: 'Build loop',
    title: 'a caller MUST NOT read a domain refusal short of every configured backend as proof about the chain',
    quote:
      'A caller MUST NOT read a\n' +
      'domain refusal short of every configured backend as proof about the chain.',
    binds: 'callers, this repository included',
    status:
      'tested at packages/cli/test/verifynote.test.ts: reports a refusal only some backends reached as unproven, not as out of scope',
    file: 'fetch',
    why:
      'the sentence binds callers and this repository ships one, so what is asserted is ' +
      'that it obeys: the cited test drives the same class with the marker true and ' +
      'false and reads the exit code apart, out of scope where the refusal reached every ' +
      'backend and unproven where it did not. The re-assert here is the half the library ' +
      'owes a caller, which is that the marker is on the error a caller catches rather ' +
      'than in a message it would have to parse.',
  },
  {
    id: 'builder-not-an-attester',
    section: 'Genealogy bundle',
    title: 'the backend that built the bundle MUST NOT count as an independent attester for it',
    quote:
      'the backend that built the bundle MUST NOT count as an\n' +
      'independent attester for it.',
    binds: 'implementations anchoring headers',
    status:
      'tested at packages/fetch/test/satbuilder.test.ts: bars a lead that served only the deciding requests from attesting',
    file: 'fetch',
    why:
      'a genealogy build reaches its backends three ways, and all three are barred: the ' +
      'pool records what it used, the lead serves the deciding requests without passing ' +
      'through the pool, and the raw-block server is asked outside it. The cited test ' +
      'drives the lead, which is the one that was reachable and unbarred until the ' +
      'fifteenth run; satbuilder.test.ts drives the pool and the raw-block server. The ' +
      're-assert here drives the anchor itself: an attester that also served bytes agrees ' +
      'and the vote still fails for want of an independent one.',
  },

  // -------------------------------------------------------------------------
  // What sat identity proofs cannot say
  // -------------------------------------------------------------------------
  {
    id: 'first-inscription-trusted',
    section: 'What sat identity proofs cannot say',
    title: 'a caller that needs first-inscription status MUST treat it as trusted',
    quote:
      'A caller that needs first-inscription status\n' +
      'MUST treat it as trusted, since no path proof answers a global question over\n' +
      'every inscription ever made.',
    binds: 'callers, this repository included',
    status: 'tested here',
    file: 'core',
    why:
      'a rule about what a caller may read, so what the library owes it is that nothing ' +
      'here offers the status as proven for a caller to over-read. The verified result ' +
      'is read field by field off a bundle that verifies and carries no answer to the ' +
      'question, and neither the verifier nor the builder names one anywhere in its ' +
      'source. What the test cannot reach is a caller obeying the rule, since obeying ' +
      'it means consulting an index this repository does not ship.',
  },
];

/** 1-based line numbers the fragment spans. Throws when it anchors nothing. */
export function anchor(quote: string): { first: number; last: number } {
  const at = SPEC.indexOf(quote);
  if (at === -1) {
    throw new Error(
      `SPEC-SAT.md no longer contains this fragment, so the requirement moved or was ` +
        `reworded and its test speaks for nothing:\n${quote}`,
    );
  }
  if (SPEC.indexOf(quote, at + 1) !== -1) {
    throw new Error(`fragment appears more than once in SPEC-SAT.md, so it anchors nothing:\n${quote}`);
  }
  const first = SPEC.slice(0, at).split('\n').length;
  return { first, last: first + quote.split('\n').length - 1 };
}

export function row(id: string): Requirement {
  const found = TABLE.find((r) => r.id === id);
  if (!found) throw new Error(`no accounting row with id ${id}`);
  return found;
}

/** The ids this spec's rows assign to one of the two files. */
export function idsFor(file: Requirement['file']): string[] {
  return TABLE.filter((r) => r.file === file).map((r) => r.id);
}

/** Rows a file is expected to drive: every row but the reported-finding ones. */
export function drivenIdsFor(file: Requirement['file']): string[] {
  return TABLE.filter((r) => r.file === file && !r.status.startsWith('unimplemented,')).map(
    (r) => r.id,
  );
}
