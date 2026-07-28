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
- **Custody and sat identity verification bind every reveal input up to the
  envelope's input, so the envelope's index is proven and not only its
  content.** The binding above pinned the tapscript of the selected envelope's
  input and left the selection itself unproven: an envelope's index is a
  running count over every input's envelopes in input order, and the witnesses
  of the earlier inputs stayed outside the txid. A bundle supplier could move
  an envelope between inputs sharing a commit script, delete an earlier
  envelope to renumber the survivor, or insert one to fabricate an index,
  without breaking any commitment. Verifiers now bind inputs `0..k` at the
  reveal, requiring each prefix input to be a script-path spend of a P2TR
  prevout verifying at control block depth 0. A prefix commitment that fails
  marks the bundle forged; a prefix input that cannot be bound at all throws
  the new `EnvelopeIndexUnprovenError`, since such a reveal can be honest even
  though the bundle cannot prove its numbering. Bundle formats are unchanged,
  both builders already emit prev txs for inputs `0..k`, and bundles written
  by earlier 0.3.0 development builds verify unchanged. Found in review before
  any release carried this code.
- **`VerifiedCustody` and `VerifiedSatIdentity` report `singleInputReveal`**,
  as `L2Assurances` has since the field existed. The CLI prints it wherever it
  prints `controlBlockDepth` and `singleLeafTree`: the `custody` and `sat`
  commands in JSON and human form, and `verify` for both bundle kinds.
- **L2 finality guidance accounts for multi-input reveals.**
  SPEC-VERIFICATION told consumers to treat L2 with `singleLeafTree` as final
  against third-party gateways. On a multi-input reveal that was wrong: L2
  binds only the envelope input's witness, so a gateway can renumber the
  envelopes without the inscriber's help. A 0.2.x reader on the content path
  should treat L2 as final only with `singleLeafTree` and `singleInputReveal`
  both true, and escalate to L3 when the reveal has more than one input,
  because the wtxid commitment covers every input's witness and commits the
  numbering. The content bundle format is unchanged.
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
  `all backends failed`, naming the wrong cause after re-walking the whole
  ancestry on every backend to reach the same deterministic answer. It is now
  `SatStepLimitError`, a `SatBuildError` so existing catch sites still work,
  and `fetchSatIdentity` rethrows it without trying another backend.

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
  through a pool and keeps its progress across a member failure. `resolver.ts`
  and `custodybuilder.ts` still use per-backend failover, where a failure
  restarts the build on the next backend.
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
