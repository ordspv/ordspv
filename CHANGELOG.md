# Changelog

All notable changes to the `@ordspv/*` packages are documented here. This
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`--timeout-ms N`: the transport deadline now has a way in from the
  command line.** `BackendLimits` carries a 20-second whole-request deadline,
  and `fetchCustody`, `fetchSatIdentity` and `OrdResolver` have accepted a
  `limits` option since the caps existed, but the CLI never constructed one,
  so on a slow link `custody <id> --witness-section always` fetched a raw
  block of up to about 4 MB against a deadline the link could not meet, and
  the remedies on the resulting note did not address the deadline. The flag
  applies to every command that opens a socket, which is `proof`, `custody`,
  `sat` and `resolve`; it is validated the way the other numeric flags are
  and refused at exit 2 on `parse` and `verify`, which read no network. The
  witness-section note now names it beside `--esplora`. The byte caps and
  the retry policy stay library-only, deliberately: they bound what an
  untrusted backend can spend of the caller's memory and time, and raising
  them from the command line in response to a backend's behaviour weakens a
  safety property in the wrong direction.

### Fixed

- **The genealogy verifier accepted prev tx bytes on the terminal coinbase
  that nothing examined.** `SatGenealogyBundleJson` requires `prevTxs` on
  every hop, and the terminal coinbase's list was never read, so a bundle
  padding it with arbitrary strings verified at exit 0 carrying bytes no
  check had seen, against SPEC-SAT's rule that verifiers use every prev tx
  supplied. The count check is not the remedy here: it admits one entry on a
  one-input transaction, and a coinbase's single input is the null prevout,
  which no prev tx can fund, so the only satisfiable form of the rule at
  this hop is an empty list. `verifySatGenealogy` now refuses a coinbase hop
  whose `prevTxs` is missing, is not an array, or is nonempty. This is a
  verifier tightening: the reference builder has always written an empty
  list there, so no bundle it built is affected. SPEC-SAT states the rule
  and the bundle sketch says `prevTxs MUST be empty` beside `tx.pos MUST
  be 0`.

- **A custody path longer than 64 confirmed transfers reported INCOMPLETE at
  exit 5, with a remedy naming other backends for a fact no backend can
  change.** The walk's cap raised `CustodyBuildError`, which the build loop
  records as one backend's failure, so every backend walked to the same wall
  and the caller got `BUILD_FAILED` with a note ending in `--esplora` naming
  others. The path length is chain truth; the only remedy is the cap, and
  nothing supplied it: `fetchCustody` accepted `maxHops` and no flag passed it
  through. The walk now raises `CustodyHopLimitError`, carrying the cap and
  the hop count reached, recordable in the taxonomy the way
  `SatStepLimitError` is, so the refusal rotates and a wall every configured
  backend reached reports as a shared, unanimous refusal. The CLI reports it
  UNPROVEN at exit 3 with a note naming `--max-hops N`, the new `custody`
  flag, validated the way `--max-steps` is and refused at exit 2 on any other
  command. The default stays at 64; raising it is a separate decision that
  needs a measurement of how many confirmed transfers real inscriptions
  accumulate, and none exists. SPEC-CUSTODY now states the builder cap and
  that the custody verifier has no cap of its own, since every forged hop
  costs a header that clears the proof-of-work floor.
- **A fee-tail refusal on a terminal coinbase below the BIP34 boundary
  claimed more than the build had established.** `coinbaseSatAt` decides the
  subsidy boundary from the height the leading backend served. At or above
  230,000 that height is checked against the coinbase's own BIP34 push; below
  it nothing in the bundle binds the pair, and the refusal path never reaches
  anchoring, which runs after a successful build. So a unanimous fee-tail
  refusal on a pre-230,000 coinbase reported OUT OF SCOPE at exit 4, a claim
  about the chain resting on nothing but the configured backends agreeing,
  reachable only when the whole configured set colludes and exposed on the
  refusal direction alone, since the answer direction is closed by anchoring
  live and by `CoinbaseHeightUnprovenError` offline. On that arm the build now
  raises `CoinbaseHeightUnprovenError` itself, whose row already reports
  UNPROVEN at exit 3 on both channels; at or above the boundary
  `CustodyUnsupportedError` passes through unchanged. Anchoring the assembled
  coinbase header inside the build loop before recording the refusal was
  rejected because it moves a request relative to the machinery that records
  who served it, the shape of defect the last two rounds closed. The class's
  live note now states the rule it turns on, true of both arms that reach it,
  and SPEC-SAT states the MUST NOT beside the boundary it covers.
- **`sat` answered where `custody` refuses: an inscription whose start
  position is in the reveal's fee region got a sat number, a name and a
  rarity at exit 0, while `custody` refuses the same inscription at exit 4.**
  The number was not forgeable and it was wrong. The condition is a real
  on-chain one rather than a served lie: the reveal's own proven input values
  and its own outputs decide it, so every honest backend produced the same
  answer, and the sat ord actually assigns depends on block-level fee
  accounting the walk never does. SPEC-CUSTODY has always made the refusal a
  MUST on the custody side, and SPEC-SAT deferred to it by cross-reference
  without restating the fee rule, which is how the gap survived: the
  genealogy verifier computed the start position and never compared it to the
  reveal's total output sats. `verifySatGenealogy` and the genealogy builder
  now refuse a start position at or past the total output sats with
  `CustodyUnsupportedError`, the class the custody side raises for the same
  inscription. The check sits after the position branch, because the pointer
  branch cannot reach it: a pointer at or past the total output sats is
  ignored, so the rule bites on the default position summed from the inputs
  ahead of the envelope. At build the refusal is recorded under the leading
  member's name and the loop rotates, since the envelope's input index comes
  from a reveal witness the txid does not commit to, so one backend can reach
  this refusal where another does not. SPEC-SAT's start-position section now
  states the fee rule itself.
- **The member that served the raw block behind the reveal's witness section
  can no longer vote to anchor the bundle's headers.** A regression from the
  previous round, which handed the section loop the rotated members by name
  instead of the pool. That was the right fix for the reason it gave, and it
  moved the raw block request outside the pool: `PooledEsploraBackend`'s
  `getBlockRaw` goes through `run`, which records every member that serves
  bytes into `usedBaseUrls`, so the recording moved with the request and the
  raw-block server landed in neither term of the barred set. The build now
  reports the section's server by name, `witnessServer` on
  `BuildSatGenealogyResult`, the shape the custody builder already uses, and
  `fetchSatIdentity` adds it to the sources barred from attesting.
  Reachability is narrow: it needs a member that serves the raw block while
  contributing nothing the pool recorded, on a reveal that gets a witness
  section at all. Narrow is not the same as closed, and both specs state the
  bar as a MUST NOT.
- **The live note for an unprovable sub-BIP34 coinbase height told the reader
  to add anchor sources, and on that path the flag cannot change the
  outcome.** `CoinbaseHeightUnprovenError` is raised inside the per-attempt
  build and rethrown once the refusal set is unanimous, before any anchoring
  machinery is constructed, and anchoring is the only machinery
  `--anchor-source` feeds. A reader who followed the note and reran got the
  byte-identical exit-3 refusal. The note now says what stands: below the
  BIP34 boundary only an attestation of the block hash at that height binds
  the claimed height to the block, and no flag supplies one because the
  refusal precedes anchoring. A library caller can supply the attestation
  through the `trustHeader` hook. Every other note in both tables was swept
  for the same defect, a named flag the producing path cannot reach or whose
  change cannot change the outcome, and no other note fails the test.
- **Two flag mistakes the CLI accepted in silence.** `--max-hops` outside
  `custody` has been a usage error since the flag existed, and its mirror
  image was not: `custody <id> --max-steps 10` exited 0 having ignored the
  flag, since only `sat` and `verify` consult it. The same guard now covers
  `--max-steps`. Separately, a value flag followed by another flag was read
  as boolean `true`, which downstream code treats as the flag being absent,
  so `sat <id> --max-steps --json` ran at the default cap the caller
  believed they had raised, and `custody <id> --witness-section --json` ran
  at `when-needed`, changing what the build fetches; both exited 0 and
  neither said anything. The parser now refuses any value flag left without
  a value, at exit 2 with `--<flag> needs a value`. Unknown flags stay
  accepted, deliberately: rejecting them can break a caller passing a flag
  an older version ignored, which is a larger behaviour change than this
  round covers.
- **SPEC-SAT's "verifiers MUST use every prev tx supplied" was a MUST the
  code did not keep.** Both verifiers truncated a prev tx list to the
  transaction's input count, so a bundle padded with entries past it
  verified with the surplus read by nothing, while the builder refuses the
  same surplus before writing a bundle. No value either verifier uses was
  affected. The sentence is now literal rather than narrowed: a shared
  `checkPrevTxCount` beside `provenInputValues` refuses a list longer than
  the input count, at the reveal and each funding step on the genealogy side
  and at the reveal and each later hop on the custody side. A bundle the
  reference builder never writes is now refused rather than ignored. Both
  specs state the rule normatively: a bundle MUST NOT supply more prev txs
  than the transaction has inputs, and verifiers MUST refuse one that does.
  Entries within the input count beyond what a custody position needs stay
  legitimately ignored, since SPEC-SAT allows a bundle to supply more than
  the floor.

### Changed

- **The coinbase hop's self-check names the attempt, lead leading pool, the
  way the reveal hop's already does.** The shim the terminal coinbase is
  anchored through carried the pool's name while its status request went to
  the member leading the attempt, so a mismatch on lead-served data was
  attributed to the pool, and both BIP34 messages said a height came from the
  pool when the lead had served it. The shim's name and both messages now read
  `<lead> leading pool(...)`. This is message text and not a provenance fix:
  inside the lead-derived span the failure was already wrapped into
  `RevealSourceError` and recorded under the member leading the attempt, so
  the accounting is unchanged.
- **The genealogy loop stopped treating the pool's failover as if it covered
  checks that run outside it.** One defect at two sites. A pooled request
  returns the first member's answer that does not throw, so bytes for the
  wrong transaction are an answer the pool accepts and a check after it
  rejects: the walk's txid test, the 64-byte test beside it and
  `provenInputValues` all raise outside the pool. The loop read any such throw
  as pool exhaustion, recorded it, marked every remaining member as never
  having led and ended the build, so one member serving garbage for one
  mid-walk request cost the whole build with the other configured members
  never asked. `PooledEsploraBackend.run` now raises an exported
  `PoolExhaustedError`, which means every member failed that one request, and
  the loop breaks on that class alone. Everything else is one attempt's bad
  bytes, recorded as that member producing no usable answer, and the next
  member leads. It is never recorded as a refusal, because the bytes came from
  whichever member the pool's cursor reached rather than from the member
  leading the attempt. At the second site the loop passed the pool itself as
  the whole witness-backend list, on the reasoning that the pool rotates every
  member for the raw block request. It does, for the request; the four content
  checks the section loop applies to the served block run outside it, and with
  one entry in the list there was no next backend, so a member serving a block
  whose witness does not fold ended the section with one cause naming
  `pool(...)` rather than the member that served the bytes. The rotated
  members go in by name, lead first, so each is asked in turn and each cause
  names the member it belongs to.
- **A caller whose backends all answered is no longer told that none of them
  did.** Both build loops reach `BUILD_FAILED` when the refusals they recorded
  are of unlike classes, and the note beside that code said no configured
  backend produced a usable answer. A refusal is a usable answer, and the
  causes printed above the note said so. The note now says that no configured
  backend produced an answer the build could stand on, that the causes above
  name what each one did, and that `--esplora` names others. The code and the
  category are unchanged, because two backends refusing for different reasons
  is a case where a third may well succeed. Four changelog entries that stated
  a class-to-code mapping without the condition it carries, which is that
  every configured attempt ended in that same class, are narrowed to say so.
- **Smaller items on the same surface.** A custody hop's prev-tx hex is
  trimmed where it is read, so a bundle this builder writes carries the bytes
  a verifier reads back. The genealogy reveal hop's self-check reported
  against the pool's name while its status and merkle proof came from the lead
  alone, and neither name covers every check the function runs; the shim now
  names the attempt, in the form `<lead> leading pool(...)`.
  `CoinbaseHeightUnprovenError`'s taxonomy row records that no CLI path
  reaches it today and why the row stays.
- **The last member of that defect: the genealogy builder checks the terminal
  coinbase's height against the coinbase's own BIP34 push.** From block
  230,000 on a coinbase states its height in its scriptSig, and
  `verifySatGenealogy` binds the claimed height to that push. No builder read
  it, so a backend that served one wrong height across its status, its merkle
  proof and its block info moved the subsidy boundary, numbered the sat wrong
  by that block's subsidy, and the caller was told its own bundle was invalid
  at exit 1 with the other configured backends never asked. The build holds
  the coinbase's bytes, pinned by the txid the funding chain already names,
  and it holds the height the leading backend served, so the comparison needs
  no view of the chain beyond the bundle. It sits above `coinbaseSatAt`,
  which reads the served height to decide the subsidy boundary, because a
  wrong height there can turn an honest output position into a fee-tail case
  and raise `CustodyUnsupportedError`, a refusal recorded under the backend's
  own name. Both arms the verifier distinguishes are raised separately, a push
  that does not parse and a push that disagrees, each as `HopConsistencyError`
  naming the backend, the transaction and the heights, which is one backend
  producing no usable answer and never a refusal, so the next configured
  member leads the next attempt. Below block 230,000 no push is required, and that
  arm still rests on the caller's `trustHeader` hook after the loop.
- **Another member of that defect: the genealogy builder checks that the
  terminal coinbase sits at position 0 of its block.** `verifySatGenealogy`
  refuses a bundle whose terminal coinbase is anywhere else, and
  SPEC-VERIFICATION states it as a MUST, because a coinbase is its block's
  first transaction and every fold is left-anchored. The position came from
  whichever backend served the merkle proof, and a block that places the
  coinbase elsewhere contradicts nothing else the hop carries, so the walk ran
  to the end and the caller was told its own bundle was invalid at exit 1 with
  the other configured backends never asked. The check sits beside the
  coinbase hop's assembly rather than inside `assembleAnchoredHop`, which
  anchors ordinary hops too, where a nonzero position is correct. A violation
  is `HopConsistencyError` naming the backend, the transaction and the
  position it served, which is one backend producing no usable answer and
  never a refusal, so the next configured member leads the next attempt.
- **Three more verifier checks now have a build-time equivalent, so one
  backend's wrong answer costs one attempt.** The same defect at three sites:
  a check the verifier runs had nothing behind it in either builder, so a
  backend serving an answer that was well formed and wrong bought the whole
  walk, and the caller was told its own bundle was invalid at exit 1 with the
  other configured backends never asked. The 64-byte transaction rule now runs
  at build on every transaction a bundle will carry in a proven position: the
  reveal in both builders, each custody hop, each genealogy funding step, the
  terminal coinbase, and the coinbase the reveal's witness section is built
  from. The custody walk tests each hop it appends against the one before it
  for strict chain order, increasing height or equal height with strictly
  increasing position, which is what `verifyCustodyBundle` requires and what
  SPEC-CUSTODY states as a MUST on verifiers. And `AnchorBackend.getBlockInfo`
  returns the whole block summary rather than the transaction count alone, so
  the block's own `id`, `height` and `merkle_root` are checked against the
  status and the header the same backend served, at no extra request. Each
  failure is `HopConsistencyError`, which is one backend producing no usable
  answer and never a refusal. What the block info checks do not catch is a
  backend that lies consistently: a real block hash presented at a wrong
  height, with that backend's status, merkle proof and block info all agreeing
  on it, is indistinguishable from an honest answer inside the build, because
  a header commits to no height above the BIP34 coinbase push. That case is
  settled after the loop by `makeHeaderTrust`'s hash-at-height anchoring and by
  `verifySatGenealogy`'s BIP34 test on the terminal coinbase.
- **The reveal's witness section is folded against the block's own commitment
  before it is attached.** The builder tested two things about the raw block a
  backend served, that its header hashed to the hop's block hash and that the
  reveal sat at the hop's position, and neither constrains a witness, since a
  txid commits to no witness byte. Every transaction in the served block could
  carry a rewritten witness and both tests still passed, so the section was
  built from the rewritten wtxid list and attached to a bundle the verifier
  then refused after the build loop had been left, with the remaining backends
  never asked. Each candidate section now runs through
  `verifyWitnessAnchoring`, the function the verifier runs on it, and is
  attached only after it returns. A failure is that backend's bad answer: the
  cause is recorded and the next backend is asked, so a backend serving a
  rewritten witness rotates instead of ending the build at verification, and
  the terminal class stays `WitnessSectionUnavailableError`, which reports
  UNPROVEN with a remedy when every configured backend led an attempt that
  ended in that same class. A build whose backends refused for unlike reasons
  reports INCOMPLETE at exit 5 with every cause named, since a third backend
  may well answer. The served block's transaction count is checked
  against the hop's block info first, with its own cause, since a disagreement
  there folds as a branch depth and that message names the wrong thing.
- **Each hop's build-time self-check covers every check the verifier runs on
  the same answers, including proof of work.** The self-check ran the header
  hash match, the proof height match and the fold, and the proof-of-work pair
  and the `txCount` validity test had no build-time equivalent anywhere. A
  backend that fabricated a block outright, with a header hashing to the hash
  its own status named under an easy `nBits` and a branch folding to that
  header's root, was internally consistent, so the build accepted it, the walk
  completed, and the verifier refused the bundle after the loop with no
  rotation. `checkPowLimit`, `checkProofOfWork` and the `txCount` test are now
  part of the self-check, in the order `verifyAnchoredHop` runs them, so a hop
  that fails at build fails where it would have failed at verification. Both
  builders take `powLimitBits` and pass it down, in the convention
  `makeHeaderTrust` uses: `undefined` is the mainnet limit and `null` disables
  the floor. `makeHeaderTrust`'s own `minAgreement` guard is tightened in the
  same spirit, to require a whole number of agreeing sources: `NaN < 1` is
  false, so `NaN` passed a bare lower bound and the anchor reported a header
  as anchored at a height with no attester agreeing at all.
- **The envelope's binding to the reveal is checked at build time.** Neither
  builder called `verifyEnvelopeBinding`, which both verifiers run and which
  needs only the reveal, the envelope and the reveal hop's prev txs, all three
  in scope where the builders went straight to the arithmetic. A backend
  serving a reveal whose witness was rewritten under a matching txid therefore
  built a whole bundle and died at exit 1 with no rotation. Both builders now
  bind the envelope as soon as the envelope and the reveal hop's prev txs are
  in hand. At build the reveal's witness is unbound, so a binding failure
  cannot be attributed to the chain: it is recorded as that backend producing
  no usable answer and the loop leads the next attempt, and a build where
  every backend fails this way reports the build failure with each cause
  named.
- **A build-time position refusal reports UNPROVEN with its remedy instead
  of INVALID.** The mapping is what the caller reads when every configured
  backend led an attempt that ended in this same class; a build whose
  backends refused for unlike reasons reports INCOMPLETE at exit 5 with every
  cause named. Both build loops rotate on `SatPositionError`, and the loop
  that exhausted every configured backend rethrew it to a CLI table with no
  row for the class, so the caller got exit 1, the code that means a
  document failed verification, with no remedy sentence and nothing in the
  JSON body to act on. Nothing had been verified. A build loop reads the
  pointer and the envelope input out of a served reveal witness, and the
  reveal's txid commits to no witness byte, so the position it derives is
  unproven and stays unproven however many backends read the same unbound
  witness. A verifier raising the class is reading a bundle that bound its
  own pointer, which is a forgery and keeps exit 1. Each refusal row's
  category is therefore keyed by output context, the way its remedy sentence
  already was, so a row missing a context fails to compile and a class that
  means different things in different phases needs no special case.
- **Each hop's own answers are checked against each other at build time.** A
  hop is assembled from a transaction's status, its merkle proof, the
  block's header and the block's transaction count, and nothing makes a
  backend keep the four consistent. The bundle verifier proves they are, and
  it runs after the build loop has been left, so one backend's well formed
  wrong answer used to cost the whole walk and then report the bundle
  invalid with the other configured backends never asked. `fetchCustody` and
  `fetchSatIdentity` now fold each hop against itself as it is assembled,
  through the same primitives the verifier uses: the header must hash to the
  block hash the status named, the merkle branch must fold from the
  transaction's txid to that header's merkle root, and the proof's height
  must be the status's height. A disagreement is that backend producing no
  usable answer, never a domain refusal, so the build leads the next attempt
  with another backend, and a build where every backend answers this way
  reports the build failure with each cause named.
- **Every recorded refusal rests on data the named backend served for the
  requested transaction.** `fetchSatIdentity` fetches the reveal's tx hex,
  its status, its merkle proof and the terminal coinbase's status from the
  member leading the attempt rather than through the pool, which could fall
  over to another member on a request whose answer decides a domain refusal:
  the reveal's bytes decide every refusal the walk can raise from the
  reveal, and the coinbase's claimed height decides the subsidy boundary and
  with it the fee-tail refusal. Both builders check the served reveal's
  stripped hash against the inscription id's txid immediately after parsing,
  so a refusal can never be recorded, or upgraded to unanimity, on bytes
  that hash to some other transaction. A refusal recorded under a backend's
  name is now that backend's word, and `unanimous` is computed over members
  that each served their own deciding data. Any failure raised while the
  build assembles from lead-served data, from the reveal fetch through the
  reveal hop's assembly, prev-tx coverage and start-position derivation, and
  again through the terminal coinbase hop's assembly, is one member's
  failure whether the request failed or the value it returned did: it is
  recorded as producing no usable answer and the build leads the next
  attempt with the next member, the same rotation the custody loop already
  ran on identical conditions. The successful attempt's lead is barred from
  attesting to the bundle's headers by name, since the deciding requests do
  not pass through the pool that records which members served bytes. Pool
  exhaustion on a pooled request outside the lead-derived span still ends
  the build. SPEC-SAT states the rule.
- **The refusal taxonomy is one table that every command and both output
  channels read.** The refusal classes, whether a build rotates on each, and
  the exit-code category each reports live in two `Record`s keyed on unions
  of the class names and the wrapper code strings (`@ordspv/fetch`
  `taxonomy.ts` for the build-time facts, `@ordspv/cli` `taxonomy.ts` for the
  presentation), so a class added without a row is a compile-time error
  rather than a gap. Both build loops read one rotate predicate from the
  table, the reporter renders the prefix and the exit code from one category
  per class, and the `--json` channel is a typed projection of the same
  report object the human channel prints. A coverage test walks every error
  class both packages export and requires each to appear in a table or in an
  explicitly reasoned excluded list. One live-channel sentence changed: the
  witness-section remedy now names `--esplora`, since the table requires
  every remedy to name the flag that changes the outcome where one exists.
  Exit codes, `verify` output, and rotation behavior for everything a caller
  can reach are unchanged. Presentation fixes on the same reporting
  surface: a `"witness": null` section in a custody or genealogy bundle is
  refused as a bad section instead of surfacing as a raw TypeError,
  `ord-resolve verify` reports a file it cannot read as one usage line at
  exit 2 and bytes that do not parse as JSON as one document line at exit 1,
  with no stack trace on either, and every command's uncaught failure now
  exits through one final catch as one line on stderr at exit 1, with each
  command's classified paths untouched. `verifySatGenealogy` reads
  `claimedSat` as a nonempty all-decimal string and refuses other forms
  before conversion, closing `BigInt`'s empty-string and hex leniencies,
  which recompute-and-check had made harmless.

## [0.3.0] - 2026-07-26

Sat provenance in both directions, on the same fail-closed trust model as
content verification. Forward, custody proofs give an inscription's satpoint
history from its reveal to its current location. Backward, sat identity proves
which sat it lives on, traced to the coinbase that mined it. Galleries decode
from the envelope, which puts membership inside the bytes a content proof
already binds.

### Added

- **`@ordspv/core`: custody bundle verification.** `verifyCustodyBundle`
  recomputes an inscription's satpoint path from chain data alone: the
  genesis satpoint from the reveal (pointer aware, matching ord's assignment
  rules) plus one ordinal transfer step per spending transaction. Each hop is
  merkle-proven into a PoW-checked header with the txCount depth hardening
  from SPEC-VERIFICATION. Input values are proven by the previous
  transactions the spending inputs name, and the claimed final satpoint is
  recomputed and checked. Paths that cross fees or a coinbase raise
  `CustodyUnsupportedError`, as do inscriptions ord treats as unbound
  (zero-value envelope input or unrecognized even field).
- **`@ordspv/fetch`: custody path building.** `buildCustodyBundle` walks
  confirmed outspends from the reveal; the backend acts as a pathfinder and
  nothing it asserts is trusted. `fetchCustody` builds with failover,
  verifies the bundle, anchors every hop header through the existing
  header-trust machinery with the building backend excluded from attesting,
  and reports tip liveness as per-source outspend observations.
- **`@ordspv/cli`: `ord-resolve custody <inscription-id> [--json]`** prints
  the proven satpoint with hop count and per-source tip state. A pending
  unconfirmed spend of the tip is surfaced when present.
- **`@ordspv/core`: sat identity.** `verifySatGenealogy` proves which sat an
  inscription lives on, with its ordinal name and rarity, by folding a chain
  of funding transactions back to the coinbase that mined the sat. Reversing
  the walk removes the pathfinder: every input names its funding txid, so
  ancestry is a hash chain and a backend serving wrong bytes fails locally.
  Intermediate transactions therefore need no inclusion proofs, and only the
  reveal and terminal coinbase anchor to headers. Sat numbers come from the
  ordinal theory closed forms, with the coinbase's BIP34 height cross-checked
  against the bundle's claim from height 230,000 on. Also exported:
  `subsidySats`, `firstSatOfBlock`, `satToHeight`, `satName`, `satRarity`.
- **`@ordspv/fetch`: sat genealogy building.** `buildSatGenealogyBundle` walks
  funding transactions backward from the reveal, fetching previous
  transactions one input at a time and only until their cumulative value
  covers the traced position, so a consolidation with hundreds of inputs costs
  one request when the sat sits in the first. `fetchSatIdentity` builds with
  failover, verifies offline, and anchors both endpoint headers.
- **`@ordspv/cli`: `ord-resolve sat <inscription-id> [--json] [--bundle FILE]`**
  prints the sat number with its name, rarity, mining block, and walk depth.
  `--bundle` writes the genealogy artifact for later offline re-verification.
- **`@ordspv/core`: gallery member lists.** `parseGallery` and
  `inscriptionGallery` decode the properties field (tag 17) in both the inline
  and packed encodings. Because the member list is envelope data, an L2 or L3
  proof over the gallery inscription settles membership and completeness with
  no indexer, unlike children provenance where enumeration needs one. Decoding
  is lenient in ord's style and reports a `skipped` count, so a caller
  claiming a complete list can tell whether it has one.
- **SPEC-CUSTODY** specifies the custody bundle format and the verification
  rules; a deferred section states the v1 boundaries. **SPEC-SAT** does the
  same for sat identity, and **SPEC-VERIFICATION §7** covers galleries.
- **`@ordspv/fetch`: `DEFAULT_ANCHOR_SOURCES` and the `anchorSources` option**
  on the resolver, custody, sat identity and the gateway, with
  `--anchor-source url[,url]` on the CLI and `ANCHOR_SOURCES` on the gateway.
  Attesting a header needs one cheap endpoint, `/block-height/<n>`, while
  serving proofs needs the whole esplora surface, so the two lists have
  different membership requirements. The default holds five operator-diverse
  bases, each checked against block 767430 for three consecutive tries.
  `HeaderTrustOptions.proofSources` takes a set of serving base URLs for
  builds spread across several backends; `proofSource` still takes one.
- **`@ordspv/fetch`: bounded retry inside every esplora request.** HTTP 429,
  HTTP 503 and thrown network errors are retried up to 4 attempts with
  exponential backoff from 250 ms under full jitter, capped at 8 s, honoring
  `Retry-After` when it asks for 30 s or less. Other non-2xx statuses and
  byte-cap violations are not retried, since repeating them changes nothing.
  Configurable through `BackendLimits.retry`, with an injectable `sleep` on
  the backend constructor so tests never wait on a real backoff.
- **`@ordspv/fetch`: `PooledEsploraBackend`.** N backends behind one
  backend-shaped surface, rotating the starting member per request and moving
  a failed request to the next member. `fetchSatIdentity` now builds through
  a pool, so a rate limit at step 400 of a genealogy walk costs one request
  rather than 400 steps of work. The pool records which members served bytes,
  and all of them are excluded from header attesting.
- **`@ordspv/cli`: `--max-steps N`** on `sat`, threaded to the builder.

### Fixed

- **Security: all three verifiers floor a bundle's proof of work, and this
  also affects 0.2.x users on the content path.** `checkProofOfWork` compares
  a header's hash against the target the header itself declares, and nothing
  in `verifyProofBundle` constrained that target, so a bundle could carry
  headers mined at `0x207fffff` in under a second each and verify offline
  with `ok: true`. The `powLimitBits` floor existed only in
  `makeHeaderTrust`, which the CLI's `verify` command does not use at all, so
  the offline path accepted headers costing a few hashes each, about 30 bits
  of work below the difficulty-1 floor. `verifyProofBundle`,
  `verifyCustodyBundle` and
  `verifySatGenealogy` now require every header's target to be at or below
  the network proof-of-work limit before its own PoW check counts for
  anything, defaulting to the mainnet limit `0x1d00ffff`. Each takes
  `powLimitBits` with the same meaning `makeHeaderTrust` gives it: a number
  overrides, `null` disables, undefined means mainnet. The check is local and
  costs no request. `@ordspv/sidecar` gained the same option for operators
  fronting a non-mainnet node. Bundles built from real chain data are
  unaffected.
- **A terminal coinbase below the BIP34 boundary needs its height attested.**
  `verifySatGenealogy` cross-checked the claimed height against the coinbase's
  own BIP34 push only from height 230,000 on. Below that the claim was the
  server's word, and it flows straight into the sat arithmetic, so a hostile
  bundle could choose the sat number, the ordinal name and the rarity,
  including sat 0 at mythic. Such a coinbase is now refused with the new
  `CoinbaseHeightUnprovenError` unless the caller's `trustHeader` hook
  attested this header at this height, which is what binds the height to the
  header. The hook says so by returning `'hash-at-height'`; the core hook's
  return type is `void | 'hash-at-height'`, and returning nothing keeps a hook
  rejection-only as before. Acceptance rested on the hook's presence during
  development, which enforced the rule against a convention nothing checked,
  and a consumer copying the reference caller's no-op hook without its
  anchoring would have got a server-chosen sat number, name and rarity. The
  anchors in `@ordspv/fetch` report what they attested in the new
  `HeaderTrustReport.attests` field, and `fetchSatIdentity` passes the
  coinbase anchor's own verdict to the verifier. Relatedly,
  `makeHeaderTrust` now throws at construction for `minAgreement` below 1,
  which reported a header as anchored with no agreeing source at all.
  The class is separate from `CustodyUnsupportedError`
  because the bundle may be honest and merely unprovable offline.
  `ord-resolve verify` has no anchor to consult, so it reports the bundle as
  unproven offline and exits nonzero rather than printing a sat and a rarity.
  `fetchSatIdentity` anchors both endpoint headers before the offline
  verification now, instead of after it, so the attestation is in hand when
  the rule asks for it. Heights at or above 230,000 are unchanged.
- **Custody and sat identity verification bind the envelope to the taproot
  commitment.** Both anchored the reveal by its txid and then read the
  pointer and the envelope's input index out of the reveal's witness, which
  BIP-141 excludes from the txid. A server could rewrite those fields, keep
  every byte the txid hashes, and produce a bundle that verified offline
  while naming a different sat or a different genesis satpoint. Both
  verifiers now check the BIP-341 script-path commitment of the envelope
  input against the scriptPubKey of the prevout that input names, taken from
  the previous transaction the bundle already carries and pinned by the
  txid-committed outpoint. A key-path spend and a non-P2TR prevout are
  refused by name. `controlBlockDepth` and `singleLeafTree` join
  `VerifiedCustody` and `VerifiedSatIdentity` with the same multi-leaf
  residual the L2 content path carries. The bundle formats are unchanged and
  bundles written by earlier 0.3.0 development builds verify unchanged. Found
  in review before any release carried this code.
- **Multi-input reveals are proven by the block's witness commitment, or
  refused.** The binding above pinned the tapscript of the selected
  envelope's input and left the selection itself unproven: an envelope's
  index is a running count over every input's envelopes in input order, and
  the witnesses of the earlier inputs stay outside the txid. A bundle
  supplier could move an envelope between inputs sharing a commit script,
  delete an earlier envelope to renumber the survivor, or insert one to
  fabricate an index, without breaking any commitment. Development builds
  answered this by binding every input before the envelope's at control
  block depth 0. That rule was withdrawn before release, because depth 0
  proves that the prevout's author committed the observed tapscript and not
  that the tapscript was executed: a single-leaf P2TR output is spendable by
  key path as well as by script path, the txid commits to neither the
  witness nor the spend path chosen, and an input spent by key path reveals
  no envelope at all, so the author of an earlier prevout could commit an
  envelope leaf, spend by key path, and serve the script-path witness
  afterwards. Custody and genealogy bundles instead accept an optional
  witness section at the reveal hop, the L3 content bundle's exact shape,
  and the verifier proves the reveal's whole witness through the coinbase's
  BIP-141 witness commitment: every input's witness is pinned at once, so
  the envelope's index and its bytes are proven with no residual. The shared
  checks moved out of `verifyProofBundle` into `verifyWitnessAnchoring`,
  called by all three verifiers. Results report how the index was proven in
  a new `indexProof` field (`'wtxid'` or `'single-input'`), printed by the
  CLI beside the other assurance fields. A present section that fails is a
  hard error with no fallback, a section anywhere except the reveal is
  refused on presence rather than on truth (a bundle is untrusted JSON, and
  `"witness": 0` used to slip the check on a later custody hop and on the
  terminal coinbase), and a multi-input reveal with no section throws the new
  `EnvelopeIndexUnprovenError`, naming the reveal's input count and the
  requested index, since such a bundle can be honest and merely unable to
  prove its numbering. Both verifiers refuse before selecting the envelope:
  the lookup used to run first, so a multi-input reveal with no section whose
  requested index was absent reported "index N not present", a plain Error
  asserting an envelope count the bundle cannot support. With a witness
  section the count is proven and that message stands. Builders emit the section for multi-input reveals at
  the cost of one raw block request; single-input bundles are byte-identical
  to before. Found in review before any release carried this code.
- **`EnvelopeIndexUnprovenError` passes through `fetchCustody` and
  `fetchSatIdentity`** the way `CustodyUnsupportedError` does, instead of
  arriving wrapped as `VERIFY_FAILED`. A bundle can be honest and still
  unprovable, and callers have to tell that apart from a forgery.
- **The builder says why it produced no witness section, in a class of its
  own.** It used to return silently on every failure, so a rate limit, a
  timeout, a 404, and a backend serving no raw blocks were indistinguishable
  from a reveal whose numbering cannot be proven, and the caller was told the
  bundle was unprovable when the real cause was availability. The builder now
  tries the raw block on each configured backend in the order the caller
  supplied them, and when every one fails it throws the new
  `WitnessSectionUnavailableError` naming each backend and its cause rather
  than emitting a bundle the verifier will refuse. That class means "no
  backend served the block, and retrying may work";
  `EnvelopeIndexUnprovenError` keeps its one verifier-side meaning, "this
  bundle cannot prove its numbering, whoever serves it". `fetchCustody` and
  `fetchSatIdentity` pass the new class through unwrapped, as they do the
  other refusal classes. Reveals that need no section attempt nothing and
  their bundles are unchanged.
- **Builders can emit the witness section for any reveal.** The builder
  returned immediately on a single-input reveal, so nothing in this release
  could produce `indexProof: 'wtxid'` for the majority of inscriptions, while
  SPEC-CUSTODY tells a consumer holding the inscriber inside its threat model
  to require exactly that. `buildCustodyBundle`, `buildSatGenealogyBundle`,
  `fetchCustody` and `fetchSatIdentity` take `witnessSection: 'always' |
  'when-needed'`, and `ord-resolve custody` and `ord-resolve sat` take
  `--witness-section`. The default `'when-needed'` preserves today's behavior
  byte for byte; `'always'` pays one raw block request so the reveal carries
  its wtxid proof and the bundle verifies with no executed-leaf residual.
- **`VerifiedCustody` and `VerifiedSatIdentity` report `singleInputReveal`**,
  as `L2Assurances` has since the field existed. The CLI prints it wherever it
  prints `controlBlockDepth` and `singleLeafTree`: the `custody` and `sat`
  commands in JSON and human form, and `verify` for both bundle kinds.
- **The L2 residual is stated as commitment rather than execution.**
  SPEC-VERIFICATION told consumers to treat L2 with `singleLeafTree` as final
  against third-party gateways, and described that flag as closing the
  substitution gap. A 0.2.x reader on the content path should know the limit:
  `singleLeafTree` proves the taptree committed only the observed tapscript,
  and it does not prove that leaf was executed, because a single-leaf P2TR
  output is spendable by key path too and the txid commits to neither the
  witness nor the spend path chosen. The same holds for `singleInputReveal`,
  which pins how many inputs could contribute an envelope and nothing about
  the script that ran. Consumers should treat L2 as final only when the
  inscriber is outside the threat model, and escalate to L3 whenever the
  inscriber is inside it, since the BIP-141 commitment covers the exact
  serialization and is what shows the witness the chain saw. On a multi-input
  reveal a gateway can also renumber the envelopes without the inscriber's
  help, which is a second reason to escalate. The content bundle format is
  unchanged.
- **A compressed gallery is refused rather than reported as absent.**
  `inscriptionGallery` returned the ordinary non-gallery value when
  properties declared a `property_encoding` and the caller had not decoded
  them, which is byte for byte the answer for an inscription with no
  properties, so a caller could not tell a gallery it had failed to
  decompress from an inscription that declares none. It throws
  `GalleryEncodingError` now, naming the encoding.
- **Attester identity is compared in canonical form.** The exclusion of
  backends that served a bundle compared base URLs as raw strings, so a
  case variant of a serving endpoint passed as an independent attester and
  voted for the header it had just served. `normalizeBaseUrl` lowercases
  scheme and host, folds a single trailing dot on the host, drops a default
  port and strips trailing slashes; attesters are also deduplicated on that
  form, so one endpoint listed several times counts once toward the
  threshold.
- **The 64-byte transaction rejection tests the stripped serialization** in
  proof and custody verification. The txid-tree leaf preimage is the
  stripped encoding, so the raw-length check missed segwit-wrapped
  64-byte-stripped transactions (CVE-2017-12842 hardening).
- **`CustodyUnsupportedError` passes through backend failover** in
  `fetchCustody` unchanged. It previously surfaced as a generic build
  failure.
- **Custody walks complete at exactly `maxHops` transfers.** The cap error
  fires only when a further confirmed spend exists past the cap.
- **`ord-resolve verify` reads all three bundle shapes.** It cast every file
  to a proof bundle, so the genealogy bundle its own `sat --bundle` writes
  died as `Cannot read properties of undefined (reading 'header')`. It now
  routes on top-level keys, since `version` is 1 in all three, and an
  unrecognized file is reported with the keys it actually has.
- **The genealogy builder's step cap is raised to 4,096 and is no longer
  fixed.** 512 refused real mainnet inscriptions;
  `9d0bebfa4a41f65a73a2a964e191479dc6c68251c4c2b2bef5268fa5b6ff7fe2i0` needs
  803 steps. The cap now raises through `--max-steps` and stays under the
  verifier-side cap of 10,000 that SPEC-SAT sets.
- **Hitting the step cap reports the cap.** It surfaced as
  `all backends failed`, naming the wrong cause. It is now
  `SatStepLimitError` and the message names `--max-steps`.
- **Security: a build-time domain refusal is one backend's word, and both
  wrappers now treat it that way.** The builders read the envelope out of the
  served reveal witness, which the txid does not commit to, and then made
  domain decisions from it: an inscription unbound by an unrecognized even
  field or a zero-value envelope input, a fee-tail ancestry, and the walk
  depth that reached the step cap. Both wrappers rethrew those refusals out of
  the build loop at once, on the reasoning that the condition belongs to the
  path rather than to the backend. That reasoning holds for a verified bundle
  and not for a served one. One hostile backend could rewrite the reveal's
  witness, keep the txid, and make `ord-resolve custody <id>` report an
  inscription as unbound at reveal while every other configured backend went
  unasked, and the envelope binding that would have refused the rewritten
  tapscript never ran because the builder gave up first. `fetchCustody` and
  `fetchSatIdentity` now record `CustodyUnsupportedError` and
  `SatStepLimitError` raised during a build as that backend's cause and build
  against the next one. When every configured backend led an attempt that ended
  in the same class the refusal is rethrown in that class, with its message
  extended to say so and to name them, so a caller still discriminates on the
  class it discriminated on before. That is what the loop establishes, and on
  the sat side the attempt runs through a pool whose deciding bytes may have
  come from another member. A build in which some backends refused this way and
  the rest could not be reached at all reports the refusal too, since no
  backend answered with a bundle and the refusal is the most informative thing
  the build has. The rethrown error carries `unanimous`, false in that case,
  and its message says how many backends reached the refusal and names the ones
  it could not reach. A `CustodyUnsupportedError` marked that way reports as
  `UNPROVEN` at exit code 3 rather than as `OUT OF SCOPE` at exit code 4,
  because a path leaving what v1 proves is a claim about the chain that the
  backends that answered cannot settle; the other refusal classes assert
  nothing about the chain and keep their codes. A verifier's own refusal
  carries no marker and stays proven. A build where nothing was refused, and a
  build whose refusals were of unlike classes, report `BUILD_FAILED` with every
  cause joined. The same class raised by
  `verifyCustodyBundle` or `verifySatGenealogy` stays terminal and now passes
  through `fetchCustody`
  unwrapped as it already did through `fetchSatIdentity`, because a bundle a
  verifier refused had already bound its witness.
  `EnvelopeIndexUnprovenError` keeps its immediate rethrow, because it is
  raised on the reveal's input count, which the txid commits. On the genealogy
  side each attempt leads with a different pool member and pays for the whole
  walk again, which is the cost of the fix on deep ancestries, so both wrappers
  take an `onAttempt` callback that reports each attempt with the backend
  leading it and the cause that ended the one before. The CLI writes one stderr
  line per rotation, and the library emits nothing when no callback is given.
- **`fetchSatIdentity` passes an unproven coinbase height through unwrapped.**
  `CoinbaseHeightUnprovenError` from `verifySatGenealogy` became
  `SatIdentityError('VERIFY_FAILED')`, which is the class conflation the
  refusal exists to avoid: the bundle may be honest and merely unanchored. It
  now passes through beside `CustodyUnsupportedError` and
  `EnvelopeIndexUnprovenError`.
- **The header marker answers per header.** The hook `fetchSatIdentity` hands
  the core verifier ignored its arguments and answered the coinbase anchor's
  verdict for every hop asked about, discarding the reveal anchor's. It was
  safe only because one call site reads the marker, and any later rule reading
  an attestation at the reveal hop would have inherited the wrong header's
  answer silently. The hook now matches on the header's hash and answers that
  endpoint's own verdict, and throws for a header the build anchored neither
  endpoint for.
- **`ord-resolve verify` distinguishes three refusals from a forgery, with
  exit codes.** Everything but an unproven coinbase height was reported as
  `bundle INVALID`, so an honest multi-input reveal carrying no witness
  section, and a true fee-bound path outside what v1 proves, both read as
  forgeries. The command now reports `bundle UNPROVEN offline:` at exit code 3
  for an unproven coinbase height or an unprovable envelope numbering, naming
  `--witness-section always` in the second case, and `bundle OUT OF SCOPE:` at
  exit code 4 for a path outside v1's sat domain. Everything else keeps
  `bundle INVALID:` at exit code 1, and usage errors keep exit code 2. The
  four codes are listed in the usage text. Classification is by error class
  rather than by the error's name string.
- **The L2 numbering residual reaches the two surfaces that render bytes.**
  `ord-resolve resolve` printed `[L2] <type> <n> bytes block=<hash>` with no
  residual at all and emitted `verification.l2` as bare booleans, while the
  extension viewer's headline said `verified at L2 ... rendered from proven
  bytes` for a multi-input reveal that a gateway alone can renumber. The
  resolve command's human line and its JSON now carry the same residual
  sentences `verify` carries, built by one shared function, and the viewer's
  headline states the open numbering in place of the stronger claim. The
  viewer also drops an unreachable `(+witness commitment)` string, which could
  never fire because the assurances it sat in are populated at L2 only.
- **The CLI says what it did not prove, on every command that prints a
  result.** `ord-resolve verify` carried the executed-leaf residual for
  custody and genealogy bundles and left the proof-bundle branch with the bare
  anchor note, so the one path a gateway alone can renumber, a multi-input
  reveal at L2, printed the least warning. That branch now carries the same
  residual whenever the level is below L3, and adds that the envelope
  numbering is unproven at L2 when the reveal spends several inputs. The
  anchor note gained a clause saying block heights are the serving backend's
  claim until the caller anchors the hash at that height, since `verify`
  prints heights that nothing offline binds, apart from a genealogy coinbase
  height bound by BIP34 or an attestation. `custody --json` and `sat --json`
  carry the note their human-readable branches print, which is where a
  scripted caller reads it. The sentences moved into `@ordspv/core` so the
  CLI and the extension viewer state the same residual in the same words, and
  the viewer prints it below L3.
- **`fetchCustody` excludes every backend that served bytes from the header
  vote.** It passed all configured backends as candidates to serve the raw
  block behind a witness section, and then named only the backend that walked
  the path as the proof source, so a second backend could serve bytes for the
  bundle and vote for its header. SPEC-VERIFICATION requires every serving
  endpoint to be excluded, which `fetchSatIdentity` already did through the
  pool's record of used base URLs. `buildCustodyBundle` now returns
  `servedBaseUrls`, the walker plus whichever backend served the raw block,
  and `fetchCustody` passes all of them as `proofSources`.
- **Security: a witness section the builder could not build is one backend's
  word too.** `WitnessSectionUnavailableError` was exempted from failover on
  the grounds that the class is not derived from unbound witness data. That
  holds of the class and not of its trigger. The builder rejects a served block
  when the block's hash or the reveal's position in it disagrees with the hop,
  and both of those came from the walking backend's own `getTxStatus` and
  `getMerkleProof`. A hostile backend naming a real but wrong block for the
  reveal therefore made the raw block unusable at every backend, and both
  wrappers gave up before an honest backend was asked to walk, which is a
  denial of service any single configured backend could impose on a
  multi-input reveal. Both build loops now record the class as that backend's
  cause and move on, and it is rethrown in its own class once every configured
  backend led an attempt that ended in it, which is the availability case the
  class was always meant to report. The rule the specs now state is that a
  builder MUST NOT treat a build-time refusal as terminal while another backend
  is configured unless the refusal was derived from data the reveal txid
  commits. The CLI maps the class to `UNPROVEN` at exit code 3, since a block
  no backend served is availability and says nothing about the reveal.
- **The verifier's own step cap read as a forgery.** `verifySatGenealogy`
  threw a plain `Error` when a bundle carried more funding steps than its cap,
  so a genealogy built with a raised builder cap over a genuinely deep ancestry
  verified to `bundle INVALID`. The bundle is well formed and the verifier
  simply declined to read it, so the cap now throws `SatStepLimitError`, which
  moves into `@ordspv/core` because the builder and the verifier refuse on the
  same ground and a caller discriminating on the class has to see one class
  from both. `@ordspv/fetch` re-exports it, which costs it its former
  `SatBuildError` parentage. `ord-resolve verify` takes `--max-steps` so a
  caller who built a deep bundle deliberately can read it back, and rejects the
  flag on other bundle kinds. The default cap of 10,000 is unchanged.
  `verifyCustodyBundle` still has no hop cap of its own; the asymmetry is known
  and tolerable because each forged hop costs a header meeting the mainnet
  proof-of-work floor, where a forged funding step costs nothing.
- **The class-to-code mapping is one table every command reads, with rows keyed
  by output context.** The refusal
  taxonomy existed on `ord-resolve verify` alone, so a path outside v1's domain
  exited 4 when a bundle was read back and 1 when the same inscription was
  resolved live, and neither `custody --json` nor `sat --json` emitted anything
  at all on the error path. The class-to-code mapping is now one table read by
  all three commands, and a class that means one thing to a verifier and
  another to a build loop carries a row per output context, which is what
  `SatPositionError` needs. `SatStepLimitError` joins the table at exit code 3. On `--json` every command prints
  one JSON object carrying `ok: false`, the error class, the message and the
  remedy, and exits on the same code, with the same shape for a failure the
  table does not recognize.
- **`--max-steps` is the bound the verifier reads under on the live path
  too.** `fetchSatIdentity` passed the caller's cap to the walk and then ran
  the verification at the verifier's own default of 10,000, so
  `ord-resolve sat <id> --max-steps 20000` on an ancestry deeper than 10,000
  built the bundle and then refused it, reporting `INVALID` at exit code 1 for
  a document its own walk had just produced. The option is forwarded to
  `verifySatGenealogy`, and `SatStepLimitError` joins the classes the wrapper
  rethrows unwrapped, so a cap reached at either phase reaches the caller as
  itself.
- **A start position outside the reveal's sat space rotates to the next
  backend.** The position is derived from the pointer and the envelope input,
  both read out of a reveal witness the txid does not commit to, and the two
  functions that reject it threw a plain `Error`, which the genealogy build
  loop treats as a transport failure and stops on. One backend serving a
  rewritten pointer therefore ended the whole build at the first attempt with
  every other backend unasked. The new `SatPositionError` (`@ordspv/core`,
  re-exported by `@ordspv/fetch`) carries that refusal, and both build loops
  record it as that backend's cause and lead the next attempt with another
  backend. Raised by a verifier it means the bundle's own pointer misses the
  sat space of a transaction whose witness is already bound, which is a bundle
  that failed verification and keeps exit code 1.
- **A partial refusal names what each backend actually did.** Backends whose
  attempt ended in anything other than a recognized refusal were described as
  unreachable, when many of them answered and simply produced nothing usable,
  and their causes were dropped from the message entirely. They are now
  reported as having produced no usable answer, each with its own cause, on
  the rethrown error and in the CLI's remedy sentence, and the word unreachable
  is gone from this path. The genealogy loop stops at a pool-wide transport
  failure, and the members it skipped were dropped from the count, so the
  accounting did not add up and a refusal already recorded fell back to a build
  failure carrying no class at all; those members are now counted as never
  having led an attempt. The three groups therefore account for every
  configured backend in every arrangement, and a refusal reported over a set
  containing a member that led nothing is marked as reaching less than all of
  them, so `custody` and `sat` report one class and one exit code for the same
  inscription where they used to differ.
- **One configured backend is not unanimity.** A refusal rethrown over a single
  configured backend said that each configured backend had led an attempt
  ending that way, so it is not one server's word, when it was exactly one
  server's word, and a `CustodyUnsupportedError` on that strength carried exit
  code 4 as a proven statement about the chain, which SPEC-CUSTODY forbids a
  caller from reading it as. A refusal now reaches every configured backend
  only when at least two were configured and all of them stood behind it. With
  one, the message names it and says a second backend is what would make it
  more, and the existing non-unanimous routing carries the refusal to exit code
  3.
- **Exit code 5, `INCOMPLETE`, for a build no backend completed.** A total
  outage, an anchoring shortfall and a genuinely forged bundle were one report
  at exit code 1, which the usage text documents as `INVALID`.
  `CustodyError('BUILD_FAILED')` and `SatIdentityError('BUILD_FAILED')` now
  exit 5 and say that no configured backend produced an answer the build could
  stand on, with the causes above the sentence naming what each one did, the two
  `HEADER_TRUST` codes exit 3 and name `--anchor-source`, and exit code 1 keeps
  meaning a document that failed verification. On `--json` a failure the table
  does not recognize reports the error's own class name rather than the literal
  `Error`. All six codes are listed in the usage text.
- **`ord-resolve verify` says that it anchored no header.** A bundle verified
  offline rests every header it carries on the proof-of-work floor alone, and
  the result said nothing about that. The JSON carries `anchored`, false on
  every bundle today, and the human channel carries one line saying the
  result holds only against the reader's own chain view. All three kinds the
  command accepts carry both, the proof bundle included, so a caller keying
  on the field never reads undefined. SPEC-VERIFICATION section 4 now states why that is a complete remedy
  here while a terminal coinbase height below the BIP34 boundary is refused
  outright: a header hash is something any reader can check against any chain
  view, and a sub-BIP34 height appears in no header at all.
- **The header attestation marker keys on hash and height together.** The hook
  `fetchSatIdentity` hands the core verifier carries a hash-at-height verdict
  but matched on the hash alone, so the same hash presented at another height
  would have been answered with an attestation of a pair nobody attested to.
  Nothing read it that way; the key is now the pair.
- **The reveal's own witness guard tested truth, not presence.** Both
  verifiers read `revealHop.witness` for truth while the three guards beside
  them read `!== undefined`, so a JSON `"witness": 0` at the reveal was
  downgraded to the single-input rule rather than refused. Nothing unsound
  followed, since the fallback rule is the sound one and a multi-input reveal
  still refuses, and all five positions spell one rule one way now.
- **Documentation correction: the proof-of-work floor's arithmetic.**
  SPEC-VERIFICATION said that with the floor in place a fabricated low-height
  header costs ~2^77 work, which overstated the floor by about 45 bits. The
  floor is difficulty 1, a header at difficulty 1 costs about 2^32 hashes, and
  ~2^78 is the cost at recent mainnet difficulty, which nothing requires a
  bundle's header to meet, since the bundle picks its own height and its own
  `nBits`. The passage now states both numbers and what each one is, and keeps
  the rule that verifiers MUST still anchor the hash against their own chain
  view. The floor's value and behavior are unchanged.

### Changed

- **Behavior change: a backend that serves a bundle no longer counts as an
  independent attester for its own header.** `makeHeaderTrust` credited the
  proof-building backend with one independent source, so the two-backend
  default anchored non-checkpoint heights on a single outside vote, which
  contradicts SPEC-CUSTODY, SPEC-SAT and SPEC-VERIFICATION §4.
  `independentSources` is now the count of agreeing attesters that served
  nothing, the default `minAgreement` of 2 therefore means two outside
  sources, and the new `HeaderTrustReport.builderIsSource` carries the
  excluded fact. A caller running two backends where one builds the bundle
  will start failing to anchor at non-checkpoint heights until a third source
  is configured; the built-in `DEFAULT_ANCHOR_SOURCES` covers the default
  configuration, and `--anchor-source` covers custom ones. Heights under a
  compiled checkpoint are unaffected.
- **Mid-walk failover is asymmetric for now.** `fetchSatIdentity` builds
  through a pool and keeps its progress across a member failure; only a domain
  refusal starts a fresh walk, leading with the next member. `resolver.ts` and
  `custodybuilder.ts` still use per-backend failover, where a failure restarts
  the build on the next backend.
- All five packages move to 0.3.0; inter-package pins updated to match.

## [0.2.1] - 2026-07-14

Operational hardening in the gateway proxy and header-anchoring layers. The
verification core is unchanged; `@ordspv/core` stays at 0.2.0.

### Fixed

- **Gateway proxy caching is limited to immutable content.** Only
  `/content/<id>` responses enter the LRU; chain-tip endpoints
  (`/blockheight`, `/blocktime`, `/blockhash*`, `/r/*`, `/preview/*`) always
  pass through to the upstream and are marked `x-cache: BYPASS`, so the cache
  can no longer serve stale chain-tip data. Upstream
  `no-store`/`no-cache`/`max-age=0`/`private` responses are honored and kept
  out of the LRU.
- **Gateway upstream fetches carry a deadline.** Each proxied request is
  aborted after a configurable timeout (`GatewayOptions.upstreamTimeoutMs` /
  `UPSTREAM_TIMEOUT_MS`, default 20 s) and when the client disconnects, so a
  hung upstream fails over quickly instead of pinning sockets.
- **Gateway proxy requests fixed `Accept-Encoding: identity` upstream** and
  no longer forwards the client's encoding preference or copies upstream
  `Content-Encoding`, so cached bodies are one canonical byte sequence
  regardless of which client populated the cache.
- **Header anchoring separates agreement from confirmation-depth queries.**
  An attester's hash-at-height vote now counts even when its tip-height
  endpoint fails; tip heights are queried only when `minConfirmations` is
  set.
- **Byte-cap violations are reported as such.** `fetchCapped` no longer
  labels an oversized-body abort as a timeout; the descriptive cap error
  surfaces instead.
- **`syncHeaders` reports net tip growth.** The `added` counter no longer
  double-counts batches re-requested across reorg rewinds.

### Changed

- `@ordspv/fetch`, `@ordspv/gateway`, `@ordspv/cli`, and
  `@ordspv/proof-sidecar` bumped to 0.2.1; inter-package pins updated to
  match. `@ordspv/core` is unchanged at 0.2.0.

## [0.2.0] - 2026-07-13

Security-hardening release across all five packages. Upgrading from 0.1.x is
recommended; the 0.1.x line is deprecated.

### Security & robustness

- **Header anchoring is now fail-closed.** A block that cannot be tied to a
  checkpoint, a locally synced header chain, or enough independent sources is
  rejected rather than served. The backend that builds a proof is excluded from
  the independent-agreement vote so it cannot attest to its own header, and
  `HeaderTrustReport` now reports `independentSources` and `anchored`.
- **Proof-of-work floor on mainnet resolution.** Headers whose difficulty target
  is easier than the network proof-of-work limit are rejected. Configurable
  (`powLimitBits`) for non-mainnet chains.
- **Bounded response bodies.** Every backend read enforces a per-endpoint size
  cap, checked against `Content-Length` and re-checked against actually-received
  bytes while streaming (a declared length is not trusted).
- **Request timeouts.** Every backend request carries a deadline, so a hung or
  slow backend fails over to the next one instead of stalling. Configurable via
  `ResolverOptions` and applied to esplora, ord gateway, gateway upstream, and
  sidecar RPC calls.
- **Bounded decompression.** Auto-decoding of tag-9 content encodings enforces a
  maximum output size; a decompression bomb is refused (the stored encoded bytes
  are served) instead of exhausting memory. Configurable via
  `maxDecompressedBytes`.
- **Parser correctness for the fixed-width inscription-id index.** A 32-byte
  txid followed by a 4-byte little-endian index with a high zero byte is now
  accepted, matching the reference indexer; only variable-width encodings with a
  trailing zero index byte are rejected. This affects which delegate/parent an
  inscription resolves to.
- **Linear block parsing.** Full-block parsing consumes transactions from a
  single advancing offset (no per-transaction copy) and bounds the input size
  and claimed transaction count up front, so a hostile block cannot force
  quadratic work.
- **Header-sync most-work reorgs.** A competing branch is adopted only when its
  cumulative work strictly exceeds the current chain's (most-work, not tallest);
  reorg rewinds are staged in memory and persisted once. Only a genuine tip
  linkage break triggers a rewind. Proof-of-work, difficulty, median-time-past,
  and checkpoint failures abort without truncating. Header timestamps are bounded
  against the local clock.
- **Electrum TLS verification.** The Electrum transport verifies server
  certificates by default, with support for a custom CA bundle or a pinned
  certificate fingerprint; accepting a self-signed certificate now requires an
  explicit opt-in. The receive buffer is capped so an unterminated stream cannot
  grow without bound. TLS is transport hygiene; header validation remains the
  trust anchor.
- **Gateway client-IP extraction.** Behind a trusted proxy, the client IP is
  taken from the right of `X-Forwarded-For` (the entries a trusted proxy
  appends) with a configurable trusted-hop count and IP validation, so a spoofed
  left-hand entry cannot mint fresh rate-limit buckets. The tracked-key count is
  capped.
- **Gateway cache keys** are derived from canonicalized route inputs rather than
  the raw query string, so unknown query parameters can no longer bust the cache.
- **Sidecar hardening.** The proof sidecar now applies per-IP rate limiting
  (429 + `retry-after`), caches immutable proof bundles, and binds to
  `127.0.0.1` by default unless an explicit `BIND` host is set.

### Added

- Adversarial failure-injection test suite driving the real resolver, gateway,
  and sidecar against hostile backends (forged low-difficulty headers,
  witness-swap forgeries, wrong transaction counts, oversized bodies, hung
  connections, decompression bombs, spoofed forwarding headers, cache busters).
- `@ordspv/fetch` exports bounded HTTP helpers (`fetchCapped`, `readBodyCapped`)
  and bounded decompressor factories.
- Project security furniture: `SECURITY.md`, `CONTRIBUTING.md`, issue and pull
  request templates.

### Changed

- All five packages bumped to `0.2.0`; inter-package dependencies updated to
  match.

## [0.1.x]

Initial published releases. Deprecated in favor of 0.2.0.
