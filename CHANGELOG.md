# Changelog

All notable changes to the `@ordspv/*` packages are documented here. This
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  carries no marker and stays proven. A build where nothing was refused reports
  `BUILD_FAILED` with every cause joined. The same class raised by
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
- **A refusal keeps its exit code whichever command raised it.** The refusal
  taxonomy existed on `ord-resolve verify` alone, so a path outside v1's domain
  exited 4 when a bundle was read back and 1 when the same inscription was
  resolved live, and neither `custody --json` nor `sat --json` emitted anything
  at all on the error path. The class-to-code mapping is now one table read by
  all three commands, with only the prefix and the remedy sentence varying, and
  `SatStepLimitError` joins it at exit code 3. On `--json` every command prints
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
