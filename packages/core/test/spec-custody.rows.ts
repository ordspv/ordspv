/**
 * The accounting table for SPEC-CUSTODY.md, shared by the two files that speak
 * for it.
 *
 * Most of the spec binds `@ordspv/core` (`custody.ts`), so the main suite is
 * `packages/core/test/spec-custody.conformance.test.ts`. The rows whose code
 * lives in `@ordspv/fetch` are the builder's witness-section duty, its
 * walk-and-refuse accounting, the two refusals it must treat as terminal, its
 * hop cap, the attester bar and the resolver's tip liveness
 * (`custodybuilder.ts`, `failover.ts`, `headertrust.ts`), driven from
 * `packages/fetch/test/spec-custody.builder.test.ts`. The table itself is one
 * array so the split cannot lose a row: the accounting test in the core file
 * sums the whole spec against every row here, whichever file drives it.
 *
 * Which sentences bind which package does not follow the section headings.
 * `:128` and `:135` sit in the envelope binding section and bind builders, and
 * `:257` sits under "What custody proofs cannot say" and binds the resolver in
 * fetch. Every row is assigned by reading the code it asserts.
 *
 * THE KEYWORD FILTER. Measured on this file: 49 occurrences of MUST over 45
 * lines, 5 of them MUST NOT, and no REQUIRED, SHALL or RECOMMENDED anywhere.
 * The normative set here is therefore every line matching `/\bMUST\b/`, which
 * catches MUST NOT as well. A sixth MUST NOT is split across the `:251`/`:252`
 * line break, so a per-line count sees five; it falls inside the
 * `builder-not-an-attester` row either way, since that row's quote spans both
 * lines and `:251` carries the MUST.
 *
 * Outside the set by that choice, and named in the rows whose sentences carry
 * them so a reader can see they were read rather than missed: five SHOULD
 * lines (`:124`, `:156`, `:157`, `:166`, `:175`) and one OPTIONAL (`:206`, the
 * `witness` field in the bundle-format block). OPTIONAL and SHOULD state no
 * requirement a MUST filter should be catching. This spec has no RFC 2119
 * boilerplate line, so nothing is excluded by name.
 *
 * QUOTES ANCHOR AT LINE BOUNDARIES. The accounting maps each MUST-bearing line
 * to exactly one row, so two requirements that share a line must share a row
 * (`:105`, `:223`), and two requirements on adjacent lines need quotes that
 * split at the newline between them rather than mid-sentence. That is why some
 * fragments begin or end mid-sentence.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SPEC_PATH = join(ROOT, 'docs/spec/SPEC-CUSTODY.md');
export const SPEC = readFileSync(SPEC_PATH, 'utf8');

/**
 * `tested here` and `tested at <path>: <test name>` both mean a test asserts
 * the behaviour, the second naming a test elsewhere that carries the load.
 * The third is for a rule no bundle can present, where a check that runs first
 * decides every reachable case. The fourth is the outcome this suite exists to
 * surface: a requirement with no code behind it, whose test is reported rather
 * than committed green.
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
  // Genesis satpoint
  // -------------------------------------------------------------------------
  {
    id: 'default-genesis-position',
    section: 'Genesis satpoint',
    title:
      'implementations MUST take the absolute input-space position sum(inputValue[0..k-1]) and map it through the outputs in order',
    quote:
      '- default: implementations MUST take the absolute input-space position\n' +
      '  `sum(inputValue[0..k-1])` and map it through the outputs in order;',
    binds: 'implementations deriving a genesis satpoint',
    status: 'tested here',
    file: 'core',
    why:
      'the definition every other rule in the section is stated against, and the two ends ' +
      'of the sum are what a test can separate. It is driven on a two-input reveal whose ' +
      'first input is 700 sats and whose outputs are 500 then 450: the envelope at input 1 ' +
      'lands 200 sats into output 1, and the envelope at input 0 lands at the first sat, ' +
      'which is the empty sum. The two answers a different reading gives are refused rather ' +
      'than accepted from the claim, since the sentence is about which position is taken: a ' +
      'verifier starting at zero says output 0, and one not walking the outputs in order ' +
      'says 700 sats into an output that holds 500.',
  },
  {
    id: 'zero-value-outputs-skipped',
    section: 'Genesis satpoint',
    title: 'implementations MUST skip zero-value outputs when mapping a position through the outputs',
    quote:
      '- zero-value outputs occupy no sat space, so implementations MUST skip them\n' +
      '  when mapping a position through the outputs;',
    binds: 'implementations mapping a position through outputs',
    status: 'tested here',
    file: 'core',
    why:
      'skipping is only visible where an unskipped output would have answered, so a leading ' +
      'zero-value output is the sharp arm: the first sat of the transaction is in output 1, ' +
      'and an implementation indexing outputs by position rather than by sat space names ' +
      'output 0 at offset 0, which is a location holding no sat. An interior one is driven ' +
      'beside it through a pointer landing exactly where it sits, and a later hop is driven ' +
      'too, since the sentence says "a position" and one mapping serves both the reveal and ' +
      'every transfer.',
  },
  {
    id: 'pointer-out-of-range-ignored',
    section: 'Genesis satpoint',
    title: 'a pointer at or past the total output sats MUST be ignored',
    quote:
      '- a pointer strictly less than the total output sats instead indexes the\n' +
      '  output sat space directly; a pointer at or past that total MUST be ignored;',
    binds: 'implementations deriving a genesis satpoint',
    status: 'tested here',
    file: 'core',
    why:
      'ignored means the default position is used, not that the pointer is refused, so a ' +
      'test asserting only a throw would pass against code that refuses. The boundary is ' +
      'driven on one reveal three times: a pointer one below the total lands where it ' +
      'points, the total itself falls back to the default, and one past it falls back too. ' +
      'The fallback is asserted to equal the position the same reveal produces with no ' +
      'pointer at all, since "ignored" is a claim about which of two answers is returned.',
  },
  {
    id: 'unbound-refusal',
    section: 'Genesis satpoint',
    title: 'v1 MUST refuse an unbound inscription',
    quote:
      '- an inscription whose envelope input has zero value, or whose envelope\n' +
      '  carries an unrecognized even field, is UNBOUND: ord assigns it to the\n' +
      '  all-zeros unbound outpoint, not to any output, regardless of pointer or\n' +
      '  position. v1 MUST refuse (`CustodyUnsupportedError`);',
    binds: 'v1 implementations',
    status: 'tested here',
    file: 'core',
    why:
      'the sentence names two conditions and "regardless of pointer or position", so all ' +
      'three clauses are driven: a zero-value envelope input whose default position is ' +
      'inside the outputs, the same reveal carrying a pointer that would otherwise resolve, ' +
      'and an envelope with an unrecognized even field on a funded input. Each is asserted ' +
      'to carry the class callers discriminate on rather than a plain Error, since the ' +
      'failure this guards is naming an output for an inscription that lives at none.',
  },
  {
    id: 'fee-bound-refusal',
    section: 'Genesis satpoint',
    title: 'v1 MUST refuse a genesis position at or past the total output sats',
    quote:
      '- a position at or past the total output sats means the inscription bound to\n' +
      "  fee sats (ord routes it through the block's coinbase); v1 MUST refuse\n" +
      '  (`CustodyUnsupportedError`), not guess.',
    binds: 'v1 implementations',
    status: 'tested here',
    file: 'core',
    why:
      '"not guess" is the half a refusal test cannot see, so the boundary is driven with ' +
      'one sat moved across it: a reveal whose envelope input starts one sat below the ' +
      'total output sats resolves, and the same reveal with its outputs one sat shorter ' +
      'refuses. The refusal carries the reveal block height, since a caller told only that ' +
      'the sat went to fees cannot say which block would have to be accounted for.',
  },
  {
    id: 'values-from-prevtxs',
    section: 'Genesis satpoint',
    title: 'verifiers MUST obtain input values from the prev txs and MUST check each hashes to the txid its input names',
    quote:
      'Verifiers MUST obtain them from the referenced previous transactions and MUST\n' +
      'check each entry they read hashes to the txid the corresponding input names.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the hash rule is driven with a prev tx list holding the right transactions in the ' +
      'wrong order, which is the arrangement a verifier matching by txid rather than by ' +
      'position would accept, and the refusal names the entry. That the values then come ' +
      'from those bytes is driven by editing a funded output value: the edit moves the ' +
      'txid, so a verifier reading values from anywhere else would have to be handed them.',
  },
  {
    id: 'prevtx-past-input-count',
    section: 'Genesis satpoint',
    title: 'verifiers MUST refuse a prev tx entry past the input count',
    quote:
      'Only inputs `0..k` are relevant, so entries within the input count beyond the\n' +
      'last one read are ignored rather than hashed, and verifiers MUST refuse an\n' +
      'entry past the input count, which corresponds to no input.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the sentence draws a line between two surpluses and both sides are driven: an entry ' +
      'inside the input count but past the envelope input is accepted unhashed, asserted ' +
      'with an entry that is not a transaction at all, and one entry more than the input ' +
      'count is refused. A verifier hashing everything supplied fails the first, and one ' +
      'ignoring every surplus fails the second.',
  },

  // -------------------------------------------------------------------------
  // Envelope binding
  // -------------------------------------------------------------------------
  {
    id: 'indexproof-recorded',
    section: 'Envelope binding',
    title: 'the verifier MUST record which of the two ways proved the numbering in indexProof',
    quote:
      'A bundle can prove the numbering in two ways. The verifier MUST record\n' +
      'which one it used in the `indexProof` field of the verified result:',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'a field that never varies would satisfy a thinner test, so both values are read off ' +
      'bundles that verify: the same multi-input reveal reports `wtxid` with its section ' +
      'and a single-input reveal reports `single-input`. The two arms the values stand for ' +
      'are `:73` and the `single-input` bullet, whose own rows drive what each proves.',
  },
  {
    id: 'wtxid-section-verified',
    section: 'Envelope binding',
    title: 'the verifier MUST verify a witness section against the coinbase, the commitment and the folded witness tree',
    quote:
      '  below). The verifier MUST verify it: the coinbase parses, is a coinbase,\n' +
      '  and merkle-proves into the anchored header at position 0 with the correct\n' +
      '  branch depth; the coinbase carries a BIP-141 witness commitment and a\n' +
      '  well-formed reserved value; and the commitment matches the witness tree\n' +
      "  folded from the reveal's wtxid at the proven position, with the zeroed\n" +
      '  coinbase leaf required as the sibling at position 1 and position 0\n' +
      '  refused.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'a list of checks on one section, driven by breaking each in turn on a bundle that ' +
      'verifies otherwise: a coinbase that is not a coinbase, one moved off position 0, a ' +
      'branch of the wrong depth, an absent commitment output, a reserved value of the ' +
      'wrong length, and a wtxid branch that folds to something else. The zeroed-leaf rule ' +
      'is the subtle one and gets both arms, since a verifier that only checked the fold ' +
      'would accept a section presenting the reveal as the coinbase.',
  },
  {
    id: 'no-fallback-past-failing-section',
    section: 'Envelope binding',
    title: 'the verifier MUST NOT fall back past a present witness section that fails',
    quote:
      "  chain's witness. The verifier MUST NOT fall back past a present witness\n" +
      '  section that fails; such a bundle is forged or corrupt.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"no fallback" is only visible where the fallback would have succeeded, so the ' +
      'section is broken on a single-input reveal, which the bullet below needs nothing ' +
      'more from. A verifier falling back reports `single-input` and a satpoint; this one ' +
      'refuses. A section that is present but carries no data is driven beside it, since ' +
      'untrusted JSON can hold `"witness": 0` and presence rather than truth is what the ' +
      'guard reads.',
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
      'that the refusal happens at all, where the two rows after it are about how it reads ' +
      'and when it fires. It is driven at index 0, which is the case a verifier could think ' +
      'it knows without proof: the first envelope it finds is the one the id asks for, ' +
      'whatever the other input carries. The same two-input reveal with a section is read, ' +
      'and so is a single-input reveal with none, so the refusal is the input count meeting ' +
      'the absent proof rather than anything else in the document. SPEC-SAT states the same ' +
      'sentence at its `:114` and this lands the pair.',
  },
  {
    id: 'unproven-index-distinguishable',
    section: 'Envelope binding',
    title: 'the verifier MUST refuse an unprovable index distinguishably from a forgery and the refusal MUST name the count and the index',
    quote:
      'verifier MUST refuse it distinguishably from a forgery\n' +
      '(`EnvelopeIndexUnprovenError` in the reference implementation), since such a\n' +
      'bundle can be perfectly honest and simply unable to prove its numbering, and\n' +
      "the refusal MUST name the reveal's input count and the requested index.",
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'distinguishable is asserted against what it could be confused with rather than only ' +
      'against its own name: a forged bundle is a plain Error and an out-of-domain path is ' +
      '`CustodyUnsupportedError`, and this is neither. Both numbers the sentence asks for ' +
      'are read out of the message. The same bundle with a section attached verifies, so ' +
      'the refusal is the missing proof rather than anything else in the document.',
  },
  {
    id: 'refuse-before-selecting',
    section: 'Envelope binding',
    title: 'the verifier MUST refuse before selecting an envelope',
    quote:
      'verifier MUST refuse before selecting an envelope, because the envelope count\n' +
      'of such a reveal is itself unproven: reporting that the requested index is\n' +
      'absent would assert a count the bundle cannot support.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'ordering, so it is driven with an index no envelope holds: without a section the ' +
      'refusal names the unprovable numbering and never says the index is absent, and with ' +
      'a section the same index reaches the absence message, which is a count the bundle ' +
      'can now support. A verifier selecting first reports absence in both.',
  },
  {
    id: 'section-only-at-reveal',
    section: 'Envelope binding',
    title: 'the verifier MUST accept a witness section only at the reveal and MUST refuse a later hop carrying one',
    quote:
      'The verifier MUST accept a witness section only at the reveal. Later custody\n' +
      'hops read nothing from witnesses, so the verifier MUST refuse a bundle whose\n' +
      'later hop carries one.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the forbidden position is driven with a section copied from the reveal of the same ' +
      'bundle, so the section itself verifies where it came from and the refusal rests on ' +
      'where it now sits. A falsy value is driven beside it, since the guard reads presence ' +
      'and untrusted JSON can carry `"witness": 0`. The accepted position is the same ' +
      "bundle's own reveal, read back as `wtxid`.",
  },
  {
    id: 'bind-envelope-input-k',
    section: 'Envelope binding',
    title: "the verifier MUST bind input k before using the envelope, and its prev tx MUST hash to the named txid and MUST contain the named output",
    quote:
      "In every case, including `wtxid`, the verifier MUST bind the envelope's own\n" +
      'input `k` before using anything read from the envelope: the corresponding\n' +
      'previous transaction MUST hash to the txid input `k` names and MUST contain',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"before using anything read from the envelope" is the load-bearing clause, so the ' +
      'test drives a reveal whose witness was rewritten to carry a pointer naming another ' +
      'output under an unchanged txid: a verifier binding afterwards resolves the forged ' +
      'pointer and only then objects. The two prev-tx clauses are driven on their own ' +
      'bundles, an entry that hashes to something else and one whose output list is too ' +
      'short for the vout the input names. "In every case, including `wtxid`" is driven by ' +
      'running the binding failure under a section that verifies.',
  },
  {
    id: 'input-k-spend-checks',
    section: 'Envelope binding',
    title: 'at input k the verifier MUST reject a key-path spend, MUST reject a non-P2TR prevout, and MUST verify the BIP-341 commitment',
    quote:
      'the named output; the verifier MUST reject a key-path spend at the envelope\n' +
      'input, since a key-path spend commits to no script and cannot carry an\n' +
      'envelope; the verifier MUST reject a prevout scriptPubKey that is not P2TR,\n' +
      'since an envelope is committed in a taproot script path; and the verifier\n' +
      'MUST verify the BIP-341 script-path commitment of the tapscript against that\n' +
      'scriptPubKey, rejecting the bundle when it does not hold.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'three checks on one input, each driven on its own fixture. The non-P2TR arm pays the ' +
      'envelope input from a bare script, and the commitment arm serves a witness the ' +
      'commit output never committed while leaving the txid alone. The key-path arm is ' +
      'driven at `verifyEnvelopeBinding` rather than through a bundle, because an input ' +
      'spent by key path carries no envelope for ord to number and no bundle can present ' +
      'one at input k; the check guards callers of the helper, which the genealogy verifier ' +
      'is.',
  },
  {
    id: 'builder-section-any-reveal',
    section: 'Envelope binding',
    title: 'builders MUST be able to emit the witness section for ANY reveal',
    quote:
      'Builders MUST be able to emit the section for ANY reveal, single-input ones\n' +
      'included, because a consumer holding the inscriber inside its threat model',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      '"ANY reveal" is what separates this from the SHOULD at `:123`: a single-input reveal ' +
      'proves its own numbering, so a builder could reasonably never emit one, and the ' +
      'consumer the sentence names needs `wtxid` there too. The test drives a real build ' +
      'against the mock backend twice on the same single-input reveal, once at the default ' +
      'and once at `witnessSection: always`, and reads `single-input` then `wtxid` off ' +
      'verifying the two bundles. The SHOULD half is the default arm.',
  },
  {
    id: 'builder-section-failure-distinguishable',
    section: 'Envelope binding',
    title: 'a builder asked for a section it cannot fetch MUST fail rather than emit a bundle without it, and MUST report that distinguishably',
    quote:
      'it cannot fetch MUST fail rather than emit a bundle without it, and MUST\n' +
      "report that failure distinguishably from the verifier's refusal above, since\n" +
      'one is availability and the other is not.',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the failure a silent builder would hide is driven directly: a real build at ' +
      '`witnessSection: always` against backends that serve everything except the raw ' +
      'block. The build throws rather than returning a bundle, which is the half a class ' +
      'assertion alone would miss, and the class is `WitnessSectionUnavailableError` rather ' +
      "than the verifier's `EnvelopeIndexUnprovenError`, which the same test asserts the " +
      'two are not.',
  },
  {
    id: 'refusal-not-terminal',
    section: 'Envelope binding',
    title: 'a builder MUST NOT treat a build-time refusal as terminal while another backend is configured',
    quote:
      'derived from. A builder MUST NOT treat a build-time refusal as terminal while\n' +
      'another backend is configured unless the refusal was derived from data the',
    binds: 'builders',
    status:
      'tested at packages/fetch/test/custody.test.ts: asks the next backend when one serves an unbound envelope',
    file: 'fetch',
    why:
      'which classes rotate is a table rather than a list kept in the loop, so the ' +
      're-assert reads the table: every class the custody loop can record answers false to ' +
      "`committedAtBuild`, and the class the sentence's exemption names is not recordable " +
      'and leaves the loop. The cited test drives the rotation itself against a backend ' +
      'serving an unbound envelope, and the same file drives it for an uncommitted ' +
      'tapscript and for a hop the backend places out of order.',
  },
  {
    id: 'record-cause-and-walk-again',
    section: 'Envelope binding',
    title: "a builder MUST record the rest as that backend's cause and build against the next one",
    quote:
      "reveal txid commits; it MUST record the rest as that backend's cause and build\n" +
      'against the next one.',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the recording is what the report is assembled from, so the test drives a real build ' +
      'over two backends where the first serves an unbound envelope: the build completes on ' +
      'the second, the rotation is observed through `onAttempt`, and the cause the first ' +
      'produced is carried on the attempt that followed it rather than folded into a count.',
  },
  {
    id: 'input-count-refusal-terminal',
    section: 'Envelope binding',
    title: 'a builder MUST treat a refusal raised on the count of inputs as terminal',
    quote: "reveal's input count is such data, so a builder MUST treat a refusal raised on",
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the named instance of the exemption in the sentence above it, and no build raises ' +
      'the class, so the arm itself is read rather than driven and that is worth saying ' +
      'plainly. What the read asserts is placement rather than presence: the terminal arm ' +
      'sits above the recording path in the walk loop, so no rotation can reach the class ' +
      'however the loop is entered. The table is asserted to agree, since it is what the ' +
      'recording path consults. Why no build raises it is driven rather than asserted: a ' +
      'real two-input build gets a section under the default mode, and the same routes ' +
      'without the raw block end at the availability class instead. SPEC-SAT states the ' +
      'same sentence at its `:267`.',
  },
  {
    id: 'verifier-refusal-terminal',
    section: 'Envelope binding',
    title: 'a builder MUST treat a refusal as terminal once a verifier raises it',
    quote:
      'the count of inputs as terminal. A builder MUST treat a refusal as terminal once\n' +
      'a verifier raises it, because the bundle a verifier refused had already bound\n' +
      'its witness through the envelope binding above.',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the other half of what a builder may stop on, and unreachable through a build for a ' +
      'reason the test states: the walk computes the same satpoints the verification ' +
      'recomputes, so a bundle the walk completed is one the verifier accepts, and the mode ' +
      'enum has no value that emits a sectionless multi-input reveal. The read asserts both ' +
      'classes leave unwrapped between the verification call and the generic wrap, and what ' +
      'the arms preserve is driven: the wrapper class answers false to both `instanceof` ' +
      'tests, so wrapping would erase the distinction a caller discriminates on.',
  },
  {
    id: 'report-reach-and-no-answer-group',
    section: 'Envelope binding',
    title: 'a builder MUST report whether every configured backend reached the refusal and MUST name the backends that produced no usable answer and those that led no attempt',
    quote:
      'builder MUST report whether every configured backend reached that same\n' +
      'refusal, and MUST name the backends that produced no usable answer and the',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the marker and the groups are one report, so all three are read off one call: a ' +
      'refusal over three backends where one refused, one answered nothing and one never ' +
      'led. The marker is false and both other groups are named with what ended them. The ' +
      'arrangement where every backend refused is driven beside it so the marker is shown ' +
      'to vary. What the custody wrapper itself cannot reach is the `neverLed` group: its ' +
      'loop breaks only on success, so on the failure path every backend has led, which the ' +
      'test asserts by reading the argument the wrapper passes.',
  },
  {
    id: 'unanimity-needs-two',
    section: 'Envelope binding',
    title: 'a builder MUST report a refusal as reaching every configured backend only when at least two were configured',
    quote:
      'backends that led no attempt when they did not. A builder MUST report a\n' +
      'refusal as reaching every configured backend only when at least two backends\n' +
      "were configured, since one backend agreeing with itself is one server's word.",
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'one backend agreeing with itself is the case the rule exists for, so it is driven ' +
      'directly: a single configured backend that refused, with the other two groups empty, ' +
      'which satisfies every part of unanimity except the count. The marker is false and ' +
      'the message says what a second backend would add. Two backends in the same ' +
      'arrangement are driven beside it, and the cited live pair is in custody.test.ts.',
  },
  {
    id: 'caller-must-not-read-partial',
    section: 'Envelope binding',
    title: 'a caller MUST NOT read a domain refusal short of every configured backend as proof about the chain',
    quote:
      'A caller MUST NOT read a domain refusal short of every configured backend as\n' +
      'proof about the chain.',
    binds: 'callers, this repository included',
    status:
      'tested at packages/cli/test/verifynote.test.ts: reports a refusal only some backends reached as unproven, not as out of scope',
    file: 'fetch',
    why:
      'the sentence binds callers and this repository ships one, so what is asserted is ' +
      'that it obeys: the cited test drives the same class with the marker true and false ' +
      'and reads the exit codes apart, out of scope where the refusal reached every backend ' +
      'and unproven where it did not. The re-assert here is the half the library owes a ' +
      'caller, which is that the marker rides on the error a caller catches rather than in ' +
      'a message it would have to parse.',
  },

  // -------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------
  {
    id: 'offset-inside-spent-output',
    section: 'Transfer',
    title: 'the tracked offset MUST be strictly less than the spent output value',
    quote:
      'mapped through the outputs in order. The tracked offset MUST be strictly less\n' +
      "than the spent output's value.",
    binds: 'implementations walking a transfer',
    status: unreachable(
      "the tracked offset is produced by mapping into the very output the next hop's prev " +
        'tx has to hash to, and that mapping only returns an offset strictly inside the ' +
        'value',
    ),
    file: 'core',
    why:
      'the reachable side is driven: an offset at the last sat of the spent output walks. ' +
      'The violating side cannot be built, because a bundle reaching the guard would need a ' +
      'prev tx that both hashes to the tracked txid and states a different value for the ' +
      'tracked output. What that leaves is a helper a caller could misuse, so the test ' +
      'drives `transferSatpoint` with an over-large offset and shows it follows the ' +
      'arithmetic rather than refusing, which is why the verifier carries the check and why ' +
      'dropping it would move the rule onto every caller. `verifyCustodyBundle` keeps it as ' +
      'defence in depth at no cost.',
  },
  {
    id: 'transfer-fee-refusal',
    section: 'Transfer',
    title: 'v1 MUST refuse a transfer position at or past the total output sats rather than follow it through the coinbase',
    quote:
      'means the sat entered fees; v1 MUST refuse rather than follow it through the\n' +
      "coinbase (tracking a fee sat requires the whole block's fee picture and is\n" +
      'deferred).',
    binds: 'v1 implementations',
    status: 'tested here',
    file: 'core',
    why:
      'the genesis rule at `:38` is the same arithmetic one transaction earlier, and this ' +
      'one is driven on a later hop, which is where the two differ: a spend whose outputs ' +
      'pay less than the tracked position sends the sat to the miner. The refusal carries ' +
      'the class and the hop block height, and the same hop paying one sat more walks, so ' +
      'the boundary is the rule rather than the fixture.',
  },

  // -------------------------------------------------------------------------
  // Custody bundle
  // -------------------------------------------------------------------------
  {
    id: 'per-hop-anchoring',
    section: 'Custody bundle',
    title: 'verifiers MUST, per hop, recompute the header hash, check PoW, require a valid txCount and branch depth, fold the branch, and reject 64-byte transactions',
    quote:
      'Hop 0 is the reveal. Verifiers MUST, per hop: recompute the header hash,\n' +
      'check proof of work, require a valid `txCount` and a branch depth equal to\n' +
      '`treeHeight(txCount)` (CVE-2017-12842 hardening, as in SPEC-VERIFICATION),\n' +
      "fold the txid branch to the header's merkle root, and reject 64-byte",
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"per hop" is the clause a reveal-only test would miss, so each of the five checks is ' +
      'broken at hop 0 and again at hop 1 of a two-hop bundle, and the refusal is asserted ' +
      'to name the hop it was broken at. The 64-byte arm is driven in both serializations, ' +
      'legacy and segwit-wrapped, since the rule is about the stripped preimage and a ' +
      'verifier measuring the raw bytes passes the first and fails the second.',
  },
  {
    id: 'hop-order-and-distinctness',
    section: 'Custody bundle',
    title: 'hops MUST be in strict chain order and hop transactions MUST be distinct',
    quote:
      'transactions. Hops MUST be in strict chain order: increasing height, or equal\n' +
      'height with strictly increasing position. Hop transactions MUST be distinct,',
    binds: 'bundles and the verifiers that read them',
    status: 'tested here',
    file: 'core',
    why:
      'the equal-height arm is the one a height comparison alone would miss, so both arms ' +
      'are driven: a hop at a lower height, and a hop at the same height at an equal and ' +
      'then a lower position, with the strictly greater position accepted. Distinctness is ' +
      'driven with one hop repeated, which is reachable here where the genealogy walk ' +
      'cannot reach it, because this walk follows a server naming each next transaction.',
  },
  {
    id: 'no-coinbase-after-reveal-and-bind-at-hop-0',
    section: 'Custody bundle',
    title: 'hops after the reveal MUST NOT be coinbases, and at hop 0 verifiers MUST also bind the envelope and its index',
    quote:
      'and hops after the reveal MUST NOT be coinbases. At hop 0 verifiers MUST also\n' +
      'bind the envelope and its index as the envelope binding section requires.',
    binds: 'bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'two rules on one line, which the accounting maps to one row. The coinbase arm ' +
      'appends a real coinbase as a later hop and asserts the out-of-domain class rather ' +
      'than a plain Error, since a path through a coinbase is a fee path v1 declines rather ' +
      'than a forgery. The binding arm is what "also" carries: a bundle whose four ' +
      'anchoring checks all pass, asserted by verifying it before the tamper, and whose ' +
      'reveal witness is then rewritten under an unchanged txid.',
  },
  {
    id: 'prevtx-alignment',
    section: 'Custody bundle',
    title:
      "a bundle MUST align a hop's prevTxs to its inputs, entry i to input i, and a verifier MUST read them at those positions",
    quote:
      "A bundle MUST align a hop's `prevTxs` list to its transaction's inputs, entry\n" +
      '`i` to input `i`, and a verifier MUST read them at those positions.',
    binds: 'bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'positional rather than matched by txid, which is only visible where the entries ' +
      'differ and where an entry before the tracked input is load-bearing. The hop the row ' +
      'drives spends the tracked outpoint at input 1 behind an unrelated funding input, so ' +
      "the walk reads both entries and input 0's value shifts the answer by its whole " +
      "amount. Swapping them is refused at entry 0, and so is supplying the tracked input's " +
      'entry alone, which is the sharper arm: that entry is the one the answer needs, it is ' +
      'correct, and it is still refused for not sitting at its position. A verifier matching ' +
      'by txid accepts both. That the alignment decides the answer rather than only the ' +
      'hashing is driven beside them, by refusing the satpoint a verifier ignoring input 0 ' +
      'would fold to. SPEC-SAT states the twin at its `:158`.',
  },
  {
    id: 'prevtx-surplus-refused',
    section: 'Custody bundle',
    title: 'a bundle MUST NOT supply more prevTxs entries than the hop has inputs and verifiers MUST refuse one that does',
    quote:
      "MUST NOT supply more `prevTxs` entries than the hop's transaction has inputs,\n" +
      'since an entry past the input count corresponds to no input, and verifiers MUST\n' +
      'refuse a hop that supplies one rather than ignore the surplus.',
    binds: 'bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the surplus entry is a copy of one the bundle already carries, which is the case a ' +
      'verifier ignoring the surplus would accept since every entry it reads hashes ' +
      'correctly. Both hop shapes are driven, the reveal and a later hop, because they ' +
      'reach the count check by different paths.',
  },
  {
    id: 'builder-hop-cap-distinguishable',
    section: 'Custody bundle',
    title: 'a builder that stops at its cap MUST report that distinguishably from a backend failure and as unproven',
    quote:
      'exposes it as `--max-hops`. A builder that stops at its cap MUST report that\n' +
      'refusal distinguishably from a backend failure and as unproven rather than as\n' +
      'a statement about the chain, since the path may honestly be longer and the\n' +
      'caller may raise the cap and walk it.',
    binds: 'builders',
    status: 'tested here',
    file: 'fetch',
    why:
      'the sentence gives its own test: a real build over a chain longer than the cap is ' +
      'refused, and the same routes under a raised cap complete, so the refusal cannot have ' +
      'been about the path. The class is `CustodyHopLimitError` rather than the wrapper ' +
      'error a backend failure produces, it carries the cap so the caller knows what to ' +
      'raise, and the taxonomy reports it as unproven rather than as a chain fact.',
  },
  {
    id: 'finalsatpoint-recomputed',
    section: 'Custody bundle',
    title: 'verifiers MUST recompute the path and reject on a finalSatpoint mismatch',
    quote:
      '`finalSatpoint` is a claim; verifiers MUST recompute the path and reject on\n' +
      'mismatch.',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the recomputation is asserted to be the source of the answer and not the claim: the ' +
      'returned satpoint equals what the walk folds to, and each of the three fields is ' +
      'moved on its own and refused, since a verifier comparing the formatted string alone ' +
      'would pass a claim differing only in a field it never parsed. The refusal names both ' +
      'the claim and the folded path.',
  },
  {
    id: 'builder-not-an-attester',
    section: 'Custody bundle',
    title: 'the backend that built the bundle MUST NOT count as an independent attester for it',
    quote:
      'independent sources (`trustHeader`; the backend that built the bundle MUST\n' +
      'NOT count as an independent attester for it).',
    binds: 'implementations anchoring headers',
    status:
      'tested at packages/fetch/test/custody.test.ts: bars the raw-block server from the header vote, not just the walker',
    file: 'fetch',
    why:
      'a custody build reaches its backends two ways and both are barred: the walker serves ' +
      'the path, and any configured backend may serve the raw block behind a witness ' +
      'section, which is why the wrapper passes the served set rather than the walker ' +
      'alone. The cited test drives the raw-block server, which was the reachable and ' +
      'unbarred one. The re-assert here drives the anchor itself: an attester that also ' +
      'served bytes agrees, and the vote still fails for want of an independent one.',
  },

  // -------------------------------------------------------------------------
  // What custody proofs cannot say
  // -------------------------------------------------------------------------
  {
    id: 'tip-liveness-per-source',
    section: 'What custody proofs cannot say',
    title: 'resolvers MUST surface tip liveness as per-source observations, never as part of the proof',
    quote:
      'no inclusion proof exists for it. Resolvers MUST surface tip liveness as\n' +
      'per-source observations (outspend checks across independent backends, or the\n' +
      "caller's own node), never as part of the proof.",
    binds: 'resolvers, this repository included',
    status: 'tested here',
    file: 'fetch',
    why:
      'both halves are read off one real build. Per-source: every configured backend ' +
      'answers under its own name, and the arrangement that shows it is one backend ' +
      'reporting the outpoint spent while the other cannot be reached, which a resolver ' +
      'folding the answers into one verdict could not report. Never part of the proof: the ' +
      'verified custody result carries no liveness field, and the same bundle re-verified ' +
      'offline returns the same result with no outspend request made at all.',
  },
];

/** 1-based line numbers the fragment spans. Throws when it anchors nothing. */
export function anchor(quote: string): { first: number; last: number } {
  const at = SPEC.indexOf(quote);
  if (at === -1) {
    throw new Error(
      `SPEC-CUSTODY.md no longer contains this fragment, so the requirement moved or was ` +
        `reworded and its test speaks for nothing:\n${quote}`,
    );
  }
  if (SPEC.indexOf(quote, at + 1) !== -1) {
    throw new Error(
      `fragment appears more than once in SPEC-CUSTODY.md, so it anchors nothing:\n${quote}`,
    );
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
