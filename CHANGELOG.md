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

### Fixed

- **The 64-byte transaction rejection tests the stripped serialization** in
  proof and custody verification. The txid-tree leaf preimage is the
  stripped encoding, so the raw-length check missed segwit-wrapped
  64-byte-stripped transactions (CVE-2017-12842 hardening).
- **`CustodyUnsupportedError` passes through backend failover** in
  `fetchCustody` unchanged. It previously surfaced as a generic build
  failure.
- **Custody walks complete at exactly `maxHops` transfers.** The cap error
  fires only when a further confirmed spend exists past the cap.

### Changed

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
