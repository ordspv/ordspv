/**
 * The accounting table for SPEC-VERIFICATION.md, shared by the three files
 * that speak for it.
 *
 * Most of the spec binds `@ordspv/core`, so the main suite is
 * `packages/core/test/spec-verification.conformance.test.ts`. The rows whose
 * code lives in `@ordspv/fetch` (header anchoring in `headertrust.ts`, the
 * resolver's L0 labelling and its delegate hop) are driven from
 * `packages/fetch/test/spec-verification.anchoring.test.ts`. One row is a
 * requirement on the servers this repository ships rather than on a library,
 * and is driven from `packages/sidecar/test/spec-verification.servers.test.ts`,
 * because the sidecar package is the only one that may import both servers.
 * The table itself is one array so the split cannot lose a row: the accounting
 * test in the core file sums the whole spec against every row here, whichever
 * file drives it.
 *
 * Quote-anchored, not line-anchored. Every row carries a verbatim fragment of
 * its normative sentence, asserted to appear exactly once in the spec before
 * the test that reads it runs, so a reworded requirement fails its own test
 * instead of leaving a green test speaking for a rule the spec no longer
 * states.
 *
 * One difference from the SPEC-URI and SPEC-GATEWAY suites: this spec states
 * three requirements with REQUIRED and no MUST (the bundle-format fields at
 * :121, :128 and :129), so the normative set here is every line carrying
 * either keyword. Filtering on MUST alone would have left those three
 * unaccounted for in silence, which is the failure mode the accounting exists
 * to end.
 *
 * THE KEYWORD FILTER. Measured on this file: 37 occurrences of MUST over 35
 * lines, 7 of them MUST NOT, and 4 of REQUIRED, three of which are the lines
 * above and the fourth of which shares :242 with a MUST. That is 38 normative
 * lines, and no SHALL or RECOMMENDED anywhere. The conformance file
 * re-measures all of it, so a keyword the filter does not carry fails a test
 * rather than passing unseen. Outside the set by that choice: six SHOULD, one
 * OPTIONAL and three MAY. This spec has no RFC 2119 boilerplate line, so
 * nothing is excluded by name.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SPEC_PATH = join(ROOT, 'docs/spec/SPEC-VERIFICATION.md');
export const SPEC = readFileSync(SPEC_PATH, 'utf8');

/**
 * `tested here` and `tested at <path>: <test name>` both mean a test asserts
 * the behaviour, the second naming a test elsewhere that carries the load.
 * `binds an external party` means no test in this repository can, because the
 * sentence binds somebody else's software. The fourth is the outcome this
 * suite exists to surface: a requirement with no code behind it, whose test is
 * reported rather than committed green.
 */
export type Status =
  | 'tested here'
  | `tested at ${string}`
  | 'binds an external party, not testable in-repo'
  | `unimplemented, reported as a finding: ${string}`;

/**
 * A requirement with no code behind it. Written as a call rather than as a
 * concatenation, since concatenated literals widen to `string` and would drop
 * out of the `Status` union without a word from `tsc`.
 */
function finding(detail: string): Status {
  return `unimplemented, reported as a finding: ${detail}`;
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
  /** which of the three files drives this row */
  file: 'core' | 'fetch' | 'servers';
  /** why the status is what it is, and what the test does not reach */
  why: string;
}

export const TABLE: Requirement[] = [
  // -------------------------------------------------------------------------
  // §2 Levels
  // -------------------------------------------------------------------------
  {
    id: 'l0-label',
    section: '§2',
    title: 'resolvers MUST label results so L0 cannot be mistaken for verified content',
    quote: "MUST label results so consumers can't mistake L0 for verified content.",
    binds: 'resolvers',
    status: 'tested here',
    file: 'fetch',
    why:
      'the label is a field on every result, so what is asserted is that the L0 answer ' +
      'carries its own level and none of the chain context a verified level carries. ' +
      'The same resolver at L2 is driven beside it, so a label that stopped varying ' +
      'would fail here rather than pass on one arm.',
  },
  {
    id: 'l2-checks',
    section: '§2',
    title: 'the six L2 checks are all MUST',
    quote: 'Checks (all MUST):',
    binds: 'verifiers reporting L2',
    status: 'tested here',
    file: 'core',
    why:
      'the sentence introduces a numbered block and carries the only RFC 2119 keyword ' +
      'in it, so the row cites the block as one requirement and the test drives each ' +
      'numbered check on its own bundle, all six end to end through verifyProofBundle. ' +
      'What the test does not reach is check 6\'s "reject t >= n" clause, which needs ' +
      'an internal key whose tweak lands past the curve order and which no construction ' +
      'in this repository produces, so the arm driven there is the output-key ' +
      'comparison. Checks 1 and 2 also carry rules of their own at :243 and :238-241, ' +
      'which have their own rows.',
  },
  {
    id: 'l2-assurances',
    section: '§2',
    title: 'verifiers MUST surface the L2 assurances',
    quote: 'Verifiers MUST surface the\nassurances:',
    binds: 'verifiers reporting L2',
    status: 'tested here',
    file: 'core',
    why:
      'both bullets under the sentence are driven against bundles that make them ' +
      'differ: a depth-0 single-input reveal, a two-leaf taptree, and a two-input ' +
      'reveal. The L3 arm is asserted beside them, where the report carries no such ' +
      'block, since the assurances are statements about what L2 left open.',
  },
  {
    id: 'l2-list-unproven',
    section: '§2',
    title: 'a consumer MUST NOT treat allInscriptions as proven at L2 without singleInputReveal',
    quote:
      'A consumer MUST NOT treat that list or its\n' +
      'length as proven at L2 unless `singleInputReveal` is true.',
    binds: 'consumers of a verification result, this repository included',
    status: 'tested here',
    file: 'core',
    why:
      'the sentence binds consumers and this repository ships several, so what is ' +
      'asserted is that the fact they need to obey it reaches them: the same ' +
      'multi-input reveal is verified at L2 and at L3, the L2 report lists envelopes ' +
      'from an input it does not bind while singleInputReveal is false, and the L3 ' +
      'report carries no such flag because the list is proven there. The sentence the ' +
      'CLI and the extension viewer print for the L2 case is asserted to be the one ' +
      'core states, and packages/cli/test/verifynote.test.ts drives it on the real ' +
      'command.',
  },
  {
    id: 'l3-checks',
    section: '§2',
    title: 'the four L3 checks are all MUST for a verifier reporting L3',
    quote: 'A verifier\nreporting L3 MUST apply all of the checks below',
    binds: 'verifiers reporting L3',
    status: 'tested here',
    file: 'core',
    why:
      'the L2 list carried "all MUST" and this one carried nothing until 0.3.4, so a ' +
      'verifier could report L3 having skipped the coinbase or the commitment output ' +
      'and point at the spec. Each of the four is driven on its own bundle: a coinbase ' +
      'that is not one, a coinbase branch built for another position, a commitment ' +
      'output whose reserved value the coinbase witness does not carry, the wtxid fold ' +
      'itself, and an envelope index the committed witness does not hold. The OPTIONAL ' +
      'half is driven beside them, since a bundle with no commit section still reports ' +
      'L3, which is what makes the list a different requirement from L2\'s.',
  },
  {
    id: 'l3-wtxid',
    section: '§2',
    title: 'the wtxid fold MUST self-pair the zeroed coinbase at pos 1 and MUST NOT accept position 0',
    quote:
      '   bytes; if `pos = 1` the first sibling MUST be exactly zero) folds to a root with\n' +
      '   `sha256d(root ‖ reserved) =` the committed 32 bytes. Reveal position MUST NOT be 0.',
    binds: 'verifiers reporting L3',
    status: 'tested here',
    file: 'core',
    why:
      'the pos-1 rule is driven through a whole L3 bundle in the minimal block that ' +
      'makes it reachable, and again with the sibling replaced by a hash that is not ' +
      'the zeroed leaf. The fold the rule guards is driven on the same bundle with a ' +
      'rewritten witness under an unchanged txid, which is §9\'s witness-swap vector. ' +
      'The position-0 rule is driven at verifyWitnessAnchoring, which is where it ' +
      'lives and the only way to present it, since a reveal at position 0 is the ' +
      'coinbase and cannot fold to its own claimed position through a bundle.',
  },

  // -------------------------------------------------------------------------
  // §3 Proof bundle format v1
  // -------------------------------------------------------------------------
  {
    id: 'wire-byte-order',
    section: '§3',
    title: 'a bundle MUST carry every 32-byte hash in display order and every transaction as hex',
    quote:
      'A bundle MUST carry every\n' +
      '32-byte hash in display order (reversed) hex, matching every public API, and every\n' +
      'transaction as hex.',
    binds: 'proof bundles and the verifiers that read them',
    status: 'tested here',
    file: 'core',
    why:
      'a keywordless "reversed hex" invites a producer to write the internal order it ' +
      'already holds, and every field would then verify against nothing. The test reads ' +
      'the direction off a bundle that verifies, on all four hash-carrying fields at ' +
      'once, and reverses each in turn to show the verifier is reading the order the ' +
      'sentence states rather than accepting either. What it does not reach is a bundle ' +
      'whose reversal happens to be a valid hash of its own, which no construction ' +
      'produces.',
  },
  {
    id: 'txcount-required',
    section: '§3',
    title: 'block.txCount is REQUIRED in a proof bundle',
    quote: '// REQUIRED (depth hardening)',
    binds: 'proof bundles and the verifiers that read them',
    status: 'tested here',
    file: 'core',
    why:
      'absent, non-integer and out-of-range counts are each refused by name rather ' +
      'than reaching the fold, since the count is what the depth hardening of §5 ' +
      'compares against. The same field on custody and genealogy hops is :238-239.',
  },
  {
    id: 'commit-required',
    section: '§3',
    title: 'the commit section is REQUIRED for L2',
    quote: '// REQUIRED for L2',
    binds: 'proof bundles and the verifiers that read them',
    status: 'tested here',
    file: 'core',
    why:
      'an L2 bundle with no commit section is refused, and the same bundle with it is ' +
      'accepted, so the requirement is read as a refusal and not as a field the ' +
      'verifier happens to look at.',
  },
  {
    id: 'witness-required',
    section: '§3',
    title: 'the witness section is REQUIRED for L3',
    quote: '// REQUIRED for L3',
    binds: 'proof bundles and the verifiers that read them',
    status: 'tested here',
    file: 'core',
    why:
      'an L3 bundle with the section removed is refused by name. The same section is ' +
      'what :135 forbids on an L2 bundle, so the two rows are the two directions of ' +
      'one field.',
  },
  {
    id: 'l2-no-witness',
    section: '§3',
    title: 'an L2 bundle MUST NOT carry a witness section and verifiers MUST refuse one that does',
    quote:
      'An L2 bundle MUST NOT carry a `witness` section, and verifiers MUST refuse an L2\n' +
      'bundle that does:',
    binds: 'proof bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'a section that would verify at L3 is attached to the same bundle at L2 and ' +
      'refused, so the refusal rests on presence rather than on the section being ' +
      'wrong. A null section is refused too, which is the shape a hand-edited bundle ' +
      'reaches for, and the bundle without one verifies.',
  },

  // -------------------------------------------------------------------------
  // §4 Header anchoring
  // -------------------------------------------------------------------------
  {
    id: 'pow-floor',
    section: '§4',
    title: 'verifiers MUST hold every header in a bundle to the network proof-of-work limit',
    quote:
      'Verifiers MUST therefore hold every header in a bundle to the\n' +
      "network's proof-of-work limit: `bitsToTarget(header.bits)` MUST be at or below",
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"every header in a bundle" is the load-bearing clause, so all three verifiers ' +
      'are driven on a header mined at regtest difficulty, and each is driven again ' +
      'with the floor disabled so the refusal is shown to be the floor and not the ' +
      'rest of the document. The genealogy arm refuses at its reveal hop, which is the ' +
      'first header that verifier reads.',
  },
  {
    id: 'checkpoint-consult',
    section: '§4',
    title: 'verifiers MUST consult a compiled-in checkpoint where one applies',
    quote:
      'what verifiers MUST do is consult a compiled-in checkpoint\n' +
      'where one applies (the first strategy below)',
    binds: 'verifiers',
    status: 'tested here',
    file: 'servers',
    why:
      'the two shipped servers are what this drives, because they are the surfaces ' +
      'that verified without consulting anything until 0.3.4: the gateway proof ' +
      'endpoint and the sidecar each refuse a bundle whose claimed height contradicts ' +
      'their checkpoint set, on the mainnet set they hold by default, and each serves ' +
      'the same bundle when an operator configures the set the chain in front of them ' +
      'needs. The other two surfaces are covered elsewhere: `ord-resolve verify` ' +
      'passes `checkpointTrustHeader()` to all three verifiers ' +
      '(packages/cli/test/checkpoint.test.ts), and `OrdResolver` anchors through ' +
      '`makeHeaderTrust` with the same set, which the checkpoint-refuse row drives. ' +
      'What no test here reaches, because no code does it: a library caller of ' +
      '`verifyProofBundle`, `verifyCustodyBundle` or `verifySatGenealogy` that ' +
      'supplies no hook still consults no checkpoint, since MAINNET_CHECKPOINTS lives ' +
      'in @ordspv/fetch and core cannot import it. Moving the set into core so the ' +
      'three verifiers apply it by default is the deferred structural option in ' +
      'private/DEFERRED.md, and until it lands this sentence binds more verifiers ' +
      'than the reference implementation obliges.',
  },
  {
    id: 'unanchored-note',
    section: '§4',
    title: 'a verifier that anchored nothing MAY report a result and MUST say so',
    quote:
      'A verifier that anchored nothing MAY still report a result, and MUST say that\n' +
      'no header in the bundle was anchored',
    binds: 'verifiers',
    status:
      'tested at packages/cli/test/verifynote.test.ts: says an offline verification anchored no header, on both channels',
    file: 'core',
    why:
      'the reader-facing surface is the command, which prints the sentence on stderr ' +
      'and the same fact as a field on stdout for all three bundle kinds. The core ' +
      'verifiers carry the sentence and assert no anchoring of their own, and that is ' +
      'what is re-asserted here: the constant states the fact and the report object ' +
      'claims nothing about anchoring that a consumer could read as a yes.',
  },
  {
    id: 'no-uncheckable-fact',
    section: '§4',
    title: 'a verifier MUST NOT report a fact the reader cannot check against a chain view',
    quote:
      'A verifier MUST NOT report a fact\n' +
      'the reader cannot check that way, which is why a terminal coinbase height below\n' +
      'the BIP34 boundary is refused outright rather than noted (SPEC-SAT)',
    binds: 'verifiers',
    status:
      'tested at packages/core/test/satnumber.test.ts: refuses a sub-BIP34 coinbase height with no trust hook to attest it',
    file: 'core',
    why:
      'the sentence names one case and the case is the whole observable: a genealogy ' +
      'bundle whose terminal coinbase claims a height below 230000 is refused with ' +
      'CoinbaseHeightUnprovenError unless the hook returns the hash-at-height marker. ' +
      'Driving it needs a genealogy bundle built from a coinbase, a funding chain and ' +
      'a reveal, which satnumber.test.ts builds and exercises on both arms; a copy ' +
      'here would be the same fixture with a thinner assertion.',
  },
  {
    id: 'checkpoint-refuse',
    section: '§4',
    title: 'checkpoints are MUST when applicable and a contradicting bundle is rejected outright',
    quote:
      '- **Checkpoints** (MUST when applicable): compiled-in `height → hash` pairs; a bundle\n' +
      '  contradicting a checkpoint is rejected outright.',
    binds: 'implementations anchoring headers',
    status:
      'tested at packages/fetch/test/headertrust.test.ts: refuses a header that contradicts the checkpoint at its claimed height',
    file: 'fetch',
    why:
      'both anchors that ship a checkpoint set are re-asserted here on the same pair ' +
      'of heights: the async `makeHeaderTrust` and the synchronous ' +
      '`checkpointTrustHeader` the CLI passes. What the compiled-in set is, and that ' +
      'it names the block holding inscription 0, is asserted too, since a checkpoint ' +
      'map that lost its entries would satisfy every behavioural test in the file. ' +
      'Whether a verifier reaches for one of these anchors at all is :177.',
  },
  {
    id: 'serving-excluded',
    section: '§4',
    title: 'a serving endpoint MUST be excluded from the vote and MUST NOT count toward the threshold',
    quote:
      'endpoint that served bytes for the bundle MUST be excluded from the vote and MUST NOT\n' +
      '  be counted toward the threshold',
    binds: 'implementations anchoring headers',
    status:
      'tested at packages/fetch/test/headertrust.test.ts: a compromised proof builder among N cannot self-satisfy the vote',
    file: 'fetch',
    why:
      'both MUSTs on the line are one behaviour and the thin re-assert drives it in ' +
      'the arrangement that separates them: the serving endpoint agrees, and the ' +
      'anchor still refuses because the count that met the threshold was its own. ' +
      'headertrust.test.ts drives the spelling variants, the FQDN form and the ' +
      'multi-backend pool.',
  },
  {
    id: 'operator-diversity',
    section: '§4',
    title: 'implementations MUST NOT infer more than the canonical form gives them',
    quote:
      'Implementations MUST NOT infer more than that: two\n' +
      '  hostnames operated by one party remain two entries',
    binds: 'implementations anchoring headers',
    status:
      'tested at packages/fetch/test/headertrust.test.ts: counts one endpoint once however many times it is listed',
    file: 'fetch',
    why:
      'the MUST NOT is a bound on the folding rather than a behaviour to add, so the ' +
      're-assert drives both sides of the bound: two distinct hostnames count twice ' +
      'even when one party plainly runs both, and two spellings of one host count ' +
      'once. The responsibility the sentence hands to callers cannot be tested at all, ' +
      'since nothing in a hostname states who operates it.',
  },
  {
    id: 'buckets-distinguish',
    section: '§4',
    title: 'an implementation MUST distinguish a silent attester from a disagreeing one and MUST report the counts separately',
    quote:
      '  An implementation MUST distinguish an attester that did not answer from one\n' +
      "  that answered a well-formed block hash which is not the header's at the\n" +
      '  proven height, and MUST report the two counts separately, because an',
    binds: 'implementations anchoring headers',
    status:
      'tested at packages/fetch/test/headertrust.test.ts: reports every source it queried in exactly one bucket',
    file: 'fetch',
    why:
      'the re-assert drives one call with one attester in each state and reads the two ' +
      'counts the sentence names apart from each other, with the accounting identity ' +
      'that keeps them honest. headertrust.test.ts covers the malformed bucket, the ' +
      'arms that query nobody, and the identity on every arm.',
  },
  {
    id: 'disagreement-refuse',
    section: '§4',
    title: 'an implementation MUST refuse by default when any attester answers a competing hash',
    quote:
      'An implementation MUST refuse by default when any\n' +
      '  attester answers a well-formed competing hash, whatever the agreeing count\n' +
      '  is:',
    binds: 'implementations anchoring headers',
    status:
      'tested at packages/fetch/test/headertrust.test.ts: refuses a single disagreement while the threshold is met',
    file: 'fetch',
    why:
      '"whatever the agreeing count is" is the clause that decides the order of two ' +
      'checks, so the re-assert puts two agreeing attesters beside one disagreeing one ' +
      'and asserts the refusal names the contested height rather than the threshold.',
  },
  {
    id: 'flag-no-attestation',
    section: '§4',
    title: 'an implementation offering the opt-out MUST NOT assert hash-at-height at a flagged height',
    quote:
      'an implementation that does so MUST NOT assert hash-at-height for a height\n' +
      '  it recorded a disagreement at.',
    binds: 'implementations anchoring headers',
    status:
      'tested at packages/fetch/test/headertrust.test.ts: flags a disagreement, keeps anchored, and withholds the attestation',
    file: 'fetch',
    why:
      'the MUST NOT is about one field, so the re-assert reads that field on the ' +
      'flagged arm and on the clean arm of the same anchor. What withholding it costs ' +
      'downstream is the sub-BIP34 refusal of :184.',
  },

  // -------------------------------------------------------------------------
  // §5 Merkle hardening
  // -------------------------------------------------------------------------
  {
    id: 'merkle-depth-position',
    section: '§5',
    title: 'txCount is REQUIRED, branch length MUST equal the tree height, positions MUST be < txCount',
    quote:
      '- `txCount` is REQUIRED in bundles; branch length MUST equal the tree height for\n' +
      '  `txCount`; positions MUST be `< txCount`.',
    binds: 'bundles and verifiers',
    status: 'tested here',
    file: 'core',
    why:
      '"in bundles" is plural, so the REQUIRED half is driven on the custody hop here ' +
      'and on the proof bundle by the txcount-required row, which are the two shapes ' +
      'carrying the field. The length and position halves are driven at ' +
      'verifyMerkleBranch, where both rules live, and again through a bundle whose ' +
      'txCount is inflated to the next tree height, which is the shape the depth ' +
      'hardening exists to refuse.',
  },
  {
    id: 'merkle-selfpair',
    section: '§5',
    title: 'an odd-width final node MUST self-pair and an identical sibling at the edge MUST be rejected',
    quote:
      '- At each level, if the node is the last of an odd-width level it MUST equal its\n' +
      '  sibling (self-pair); otherwise an identical sibling at the tree edge MUST be\n' +
      '  rejected (mutation shape, CVE-2012-2459).',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the two clauses are one rule with a condition, so the test drives an honest ' +
      'odd-width self-pair, the same position with a sibling that is not the self-pair, ' +
      'and both members of a duplicated final pair in an even-width level. The last of ' +
      'those is the mutation the CVE names, and refusing it on either member is what ' +
      'stops the mutated block from proving the same root.',
  },
  {
    id: 'sixty-four-byte',
    section: '§5',
    title: 'verifiers MUST reject a 64-byte stripped serialization wherever it folds through a txid branch',
    quote:
      '- Verifiers MUST reject a transaction whose stripped serialization is 64 bytes\n' +
      "  wherever a transaction parsed from a bundle has that serialization's hash\n" +
      '  folded through a txid merkle branch',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'the sentence enumerates its sites, so one 64-byte transaction built for the ' +
      'purpose is put through four of them: the reveal of a proof bundle, a custody ' +
      'hop, the reveal endpoint of a genealogy bundle, and the coinbase of a witness ' +
      'section. The two remaining sites, the terminal coinbase of a genealogy bundle ' +
      'and a genealogy funding step, need a whole funding chain to arrive at and are ' +
      'driven by the SPEC-SAT suite (sixty-four-byte-endpoints), which builds one. ' +
      'The prev-tx exemption the sentence states is not driven anywhere: a 64-byte ' +
      'transaction has no room for a P2TR output, so no reveal can spend one, and the ' +
      'exemption is reachable only on the funding walk.',
  },
  {
    id: 'coinbase-position-0',
    section: '§5',
    title: 'coinbase proofs MUST be verified at position 0',
    quote: '- Coinbase proofs MUST be verified at position 0 (all folds left-anchored).',
    binds: 'verifiers',
    status: 'tested here',
    file: 'core',
    why:
      'both sites are driven. verifyWitnessAnchoring folds the coinbase branch at 0, ' +
      'which is not a field the caller supplies, and refuses a branch built for any ' +
      'other position. verifySatGenealogy reads the position off the bundle, so it is ' +
      'driven on a chain that walks to the coinbase it names, moved to position 1 and ' +
      'refused there. That half was a source-text assertion until the SPEC-SAT session ' +
      'moved the chain builders into helpers.ts; the SPEC-SAT row for the same rule is ' +
      'format-coinbase-pos-and-prevtxs, which drives it against the format block that ' +
      'states it.',
  },

  // -------------------------------------------------------------------------
  // §6 Delegation and recursion
  // -------------------------------------------------------------------------
  {
    id: 'delegate-both',
    section: '§6',
    title: 'delegate resolution MUST verify both inscriptions at the same level',
    quote:
      '- `/content`-form resolution with a delegate MUST verify **both** inscriptions at the\n' +
      '  same level',
    binds: 'resolvers',
    status: 'tested here',
    file: 'fetch',
    why:
      'the existing resolver test drives two honest inscriptions, where a resolver ' +
      'that verified only the delegating envelope would still pass. This one breaks ' +
      "the delegate's own proof and asserts the resolution fails while the delegating " +
      "inscription's bare referent still resolves, so the failure is the delegate's " +
      'proof and not the document. Both levels are driven, and the level reported is ' +
      'asserted to be the one asked for, which is the "same level" half.',
  },

  {
    id: 'metadata-level',
    section: '§6',
    title: 'a resolver MUST verify /metadata at the same level as content',
    quote: '- A resolver MUST verify `/metadata` at the same level as content',
    binds: 'resolvers',
    status: 'tested here',
    file: 'fetch',
    why:
      'the sentence said metadata "verifies identically to content" and named no party ' +
      'until 0.3.4, which left room to serve the CBOR off a gateway while the content ' +
      'path verified. The test resolves the metadata referent at L2 and at L3, asserts ' +
      'the level and the block reported are the ones the content path reports, and ' +
      'breaks the same evidence to show the metadata path refuses where the content ' +
      'path refuses. The bytes are asserted to be the raw CBOR of the tag-5 chunks, ' +
      'since a resolver that verified the right inscription and returned the body ' +
      'would pass a thinner test.',
  },

  // -------------------------------------------------------------------------
  // §7 Galleries
  // -------------------------------------------------------------------------
  {
    id: 'gallery-encodings',
    section: '§7',
    title: 'implementations MUST accept both gallery encodings',
    quote: 'Two encodings are interchangeable and implementations MUST accept both:',
    binds: 'implementations reading galleries',
    status: 'tested here',
    file: 'core',
    why:
      '"interchangeable" is the testable half: one member list is encoded both ways ' +
      'and both decode to the same ids in the same order. Three details from the ' +
      'bullets are driven beside it, since a reader that accepted only the shapes it ' +
      'emits would pass a weaker test: the trailing-zero-trimmed serialization at its ' +
      '32-byte end, the absent packed index defaulting to 0, and the txid slice taken ' +
      'at the item position. The 36-byte end of the serialization is driven at ' +
      'packages/core/test/gallery.test.ts.',
  },
  {
    id: 'gallery-lenient',
    section: '§7',
    title: 'an undecodable entry MUST be skipped and empty Items MUST yield a non-gallery result',
    quote:
      'implementation MUST skip an entry that does not decode rather than invalidating\n' +
      'the list, and MUST yield a non-gallery result for properties carrying no Items\n' +
      'array, where an Items array that is empty is a gallery with no members.',
    binds: 'implementations reading galleries',
    status: 'tested here',
    file: 'core',
    why:
      'both clauses are one leniency rule and both are driven, in the arrangement that ' +
      'separates skipping from failing: a list whose middle entry is a truncated id ' +
      'decodes to the entries around it, in order, with the skipped count stating what ' +
      'was dropped. The second clause gained its trailing condition when the test went ' +
      'red on the promoted sentence: `parseGallery` reads an Items array that is empty ' +
      'as a gallery with no members, and reserves the non-gallery answer for properties ' +
      'that carry no Items array at all. The old wording said "properties with no ' +
      'Items", which reads either way, and promoting it without measuring would have ' +
      'made a MUST out of the reading the code does not take. Both are driven here.',
  },
  {
    id: 'gallery-compressed',
    section: '§7',
    title: 'a still-compressed gallery MUST be refused and the refusal MUST be distinguishable',
    quote:
      'still-compressed bytes MUST refuse rather than report an empty gallery. The\n' +
      'refusal MUST be distinguishable by the caller from the answer for an\n' +
      'inscription that declares no gallery at all',
    binds: 'implementations reading galleries',
    status: 'tested here',
    file: 'core',
    why:
      'the two sentences are one requirement about one pair of answers, so the test ' +
      'puts them side by side: the same properties bytes with and without a declared ' +
      'encoding, then an inscription declaring no gallery at all, and asserts the ' +
      'refusal is a class a caller can catch rather than a value it has to compare. ' +
      'The decompressed path is driven too, so the refusal is shown to be about the ' +
      'encoding and not about the bytes.',
  },

  // -------------------------------------------------------------------------
  // §9 Conformance vectors
  // -------------------------------------------------------------------------
  {
    id: 'negative-vectors',
    section: '§9',
    title: 'each negative vector MUST fail with the paired reason',
    quote: '- Negative (each MUST fail with the paired reason): tampered content byte',
    binds: 'implementations claiming conformance',
    status: 'tested here',
    file: 'fetch',
    why:
      'all seven vectors are read out of the spec paragraph rather than retyped, so a ' +
      'vector added to the line is driven without anybody remembering to copy it, and ' +
      'each is failed with the reason paired with it there. The row sits in the fetch ' +
      'file because two of the seven name codes only a resolver assigns ' +
      '(`HEADER_TRUST` and `INTEGRITY`); the other five are bundle-level and would run ' +
      'in either file. The first vector was a finding until 0.3.4: it paired "tampered ' +
      'content byte" with a txid mismatch, and §1 of this same spec says the txid does ' +
      'not commit to the content, so no implementation could give that reason. ' +
      'Measured on inscription 0, a flipped content byte leaves the txid identical, ' +
      'moves the wtxid, and fails the BIP-341 fold at L2 and the witness commitment at ' +
      'L3, which is what the corrected parenthetical now says and what this test ' +
      'drives on both levels.',
  },
];

/** 1-based line numbers the fragment spans. Throws when it anchors nothing. */
export function anchor(quote: string): { first: number; last: number } {
  const at = SPEC.indexOf(quote);
  if (at === -1) {
    throw new Error(
      `SPEC-VERIFICATION.md no longer contains this fragment, so the requirement moved ` +
        `or was reworded and its test speaks for nothing:\n${quote}`,
    );
  }
  if (SPEC.indexOf(quote, at + 1) !== -1) {
    throw new Error(
      `fragment appears more than once in SPEC-VERIFICATION.md, so it anchors nothing:\n${quote}`,
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

/** The ids this spec's rows assign to one of the three files. */
export function idsFor(file: Requirement['file']): string[] {
  return TABLE.filter((r) => r.file === file).map((r) => r.id);
}

/** Rows a file is expected to drive: everything but the two untestable statuses. */
export function drivenIdsFor(file: Requirement['file']): string[] {
  return TABLE.filter(
    (r) =>
      r.file === file &&
      r.status !== 'binds an external party, not testable in-repo' &&
      !r.status.startsWith('unimplemented,'),
  ).map((r) => r.id);
}
