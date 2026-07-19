# Roadmap: state of the work and what to build next

*Status as of 2026-07-12. Read DEVELOPMENT.md for operational invariants, and
docs/RESEARCH.md for the full technical rationale.*

## What exists and what it proves

- Specs (v0.1 drafts): URI scheme profile extending ord's own `ord:` draft
  (docs/spec/SPEC-URI.md), verification levels L0–L3 plus the proof bundle format
  (SPEC-VERIFICATION.md), gateway HTTP surface (SPEC-GATEWAY.md), and a cross-chain
  embedding guide (docs/CROSS-CHAIN.md). All of it is grounded in the cited research
  synthesis (docs/RESEARCH.md).
- Working code, 246 tests, all offline-runnable. `@ordspv/core` has the consensus
  primitives, the ord-exact envelope parser, and L2/L3 proof verification.
  `@ordspv/fetch` is the verified resolver: failover backends, checkpoint and M-of-N
  header trust, delegation with dual verification, integrity pins, encoding handling.
  `@ordspv/gateway` has the proxy/verify personalities and the proof endpoint.
  `@ordspv/cli` wraps it for the terminal.
- Live-validated: inscription 0 verifies at L2 end-to-end from real mainnet bytes
  (vendored, self-verifying fixtures). The BIP-341 check passes against the real
  commit output, and the esplora merkle proof folds to the real header.
- Adversarially validated on synthetic blocks: a witness-swap forgery accepted by L2
  is rejected by L3. txCount inflation, tampered tapscript, tampered content,
  checkpoint contradiction, and integrity mismatch all fail with the right errors.

## Validation checklist (needs live network)

1. `npm install && npm test && npx tsc --noEmit`: expect 246 green.
2. `npx tsx scripts/fetch-fixtures.ts`: byte-compares vendored fixtures against live
   esplora, then runs LIVE L2 **and L3** resolutions of inscription 0. *(Both ran
   green 2026-07-11, before and after the envelope-parser rewrite.)*
3. Re-verify the 824544 checkpoint hash in `packages/fetch/src/headertrust.ts`
   against your own node or two explorers. *(Confirmed identical on mempool.space,
   blockstream.info, blockchain.info 2026-07-11; still not re-verified in tests.)*
4. ~~Vendor extended vectors~~ **DONE 2026-07-11, extended 2026-07-19.**
   Thirteen mainnet vectors in `fixtures/extended/` (first wave: pushnum
   pre-Jubilee cursed, i>0 with pointer, brotli, gzip with a tag-15 note,
   chunked >520B metadata, delegate with empty body, and the delegate target;
   second wave: recursive `/r/sat` html with a parent, a brotli library with
   a pinned decoded sha256 plus bounded-decode cap test, a child of
   inscription 0 in reveal input 1, application/json at i1, text/css, and
   cbrc-20 tag-7 metaprotocol with CBOR metadata), offline-tested in
   `packages/fetch/test/extended.test.ts`; per-vector provenance and fetch
   URLs in `fixtures/extended/SOURCES.md`.
   `scripts/parity-sweep.ts` additionally cross-checks the parser against a live ord
   instance (existence/index/count via 404-at-i(count), content_type, content_length,
   delegate, body sha256 incl. tag-9 encodings, metadata hex, pre-Jubilee curse
   charm) over a wider corpus incl. a 666-envelope batch and a multi-input reveal.
   142 checks green on 2026-07-11, zero mismatches.

## Known deltas vs ord to reconcile (small, flagged in code)

- ~~Stutter semantics are approximated~~ **RESOLVED 2026-07-11.**
  `parseEnvelopesFromScript` is now an instruction-for-instruction port of ord's
  `from_tapscript`/`from_instructions`/`accept`: consume-on-failure, assign-not-or
  stutter, no reset on success, whole-tapscript discard on script error. The old
  rescanning parser could find envelopes ord never sees. Locked by the full port
  of ord's envelope.rs test corpus plus consume-semantics tests (envelope.test.ts);
  the five divergence tests were verified to fail against the old implementation.
- Parent values: ord's `take_array` keeps invalid encodings in the list. We drop
  non-parsing values when surfacing `parents[]`; raw values remain available via
  `splitPayload`. Decide whether to expose both explicitly.
- ~~`/r/undelegated-content` nuance~~ **CONFIRMED 2026-07-11.** The live sweep shows
  ord 404s `/r/undelegated-content` for a no-body delegate inscription (bare-URI
  failure is correct, `69696d8f…i0`) and serves 0 bytes for an empty-but-present
  body (`0028084b…i0`). Our resolver matches both; the offline test in
  extended.test.ts locks the empty-body case, and the check is a standing part of
  scripts/parity-sweep.ts.

## Prioritized roadmap

**P0: harden the core claim**
1. ~~Live L3 + extended vectors~~ **DONE 2026-07-11.** Live L3 confirmed,
   checkpoint re-verified, seven extended vectors vendored and offline-tested,
   live parity sweep green (checklist above).
2. ~~Port ord's envelope test corpus~~ **DONE 2026-07-11.** All 41 corpus tests
   from envelope.rs `mod tests` ported by name into `envelope.test.ts`, plus 5
   consume-semantics locks beyond the corpus. The parser was rewritten to match
   (see Known deltas).
3. ~~Property/fuzz tests~~ **DONE 2026-07-11.** Seeded, reproducible fuzz.
   `envelope.fuzz.test.ts`: parser total and deterministic over random bytes,
   grammar-biased soup, and mutations of the real vendored tapscripts, with the
   body rule and dense index/offset numbering checked as properties.
   `proofbundle.fuzz.test.ts`: attestation invariance. About 700 seeded mutations
   of 9 real and synthetic bundles must either be rejected or leave the attestation
   byte-identical; also cross-bundle splices, garbage inputs, id re-addressing,
   an explicit lock that height belongs to trustHeader, and a pair showing L2's
   sig-witness gap is real while L3 closes it.

**P1: make it adoptable**
4. ~~Build pipeline~~ **DONE 2026-07-11.** CI (GitHub Actions: test, tsc, build)
   plus scripts/build.ts: tsup ESM with TS7-tsc declarations, the fetch browser
   bundle (decompress swapped), publish staging with pack/publish dry-runs under
   the @ordspv scope, and a consumer-shaped smoke test of the staged dists.
5. ~~Header sync module~~ **DONE 2026-07-11.** `@ordspv/fetch/headersync`
   (node-only subpath): an Electrum-synced, locally validated chain (linkage, PoW,
   exact retarget, MTP, checkpoints), disk persistence with revalidating load,
   cp_height root/branch verification, and a drop-in `trustHeader` resolver option.
   Real 2120-header mainnet fixture crossing the 768096 retarget boundary. The
   browser story is documented in SPEC-VERIFICATION §4.
6. ~~Gateway productionization~~ **DONE 2026-07-11.** Byte-budget LRU (x-cache),
   per-IP token bucket, prometheus /metrics, JSON logs, streaming passthrough
   (verified responses stay buffered: a proof cannot be checked over bytes not yet
   read), graceful shutdown, and deploy/ Dockerfile plus compose
   (bitcoind→electrs→gateway, signet default). SPEC-GATEWAY §7 rewritten. Origin
   isolation (subdomain per id) is still future work.
7. ~~Browser extension~~ **DONE 2026-07-11.** extension/ (MV3): dNR gateway
   interception into a verifying viewer (browser bundle, L2 default with an L3
   toggle), per-site ord: links via just-in-time host permissions, and an omnibox
   keyword. The unpacked-loadable dist is committed; store submission is a later,
   identity-gated step. examples/verify-inscription-0.html is the companion
   self-contained demo (all steps verified live in-browser).

**P2: ecosystem moves** (sequencing rationale in CROSS-CHAIN.md)
8. Upstream coordination. **BUILT 2026-07-11, POSTING PENDING SIGN-OFF.**
   - electrs fork at `../electrs`, branch `witness-merkle-proof` (PR-ready, 1 commit):
     `/tx/:txid/witness-merkle-proof` plus `blockchain.transaction.get_witness_merkle`,
     integration-tested against regtest bitcoind (full BIP-141 commitment loop; whole
     REST suite 25/25), with criterion benches (~5.25ms wtxids, ~1.53ms branch, on a
     ~1000-tx block). The patch is vendored at docs/upstream/patches/. NOTE: the
     electrumd wallet test-harness dev-dep doesn't build on macos-arm64
     (pre-existing), so the electrum protocol test compiles and runs on Linux CI only.
   - `@ordspv/proof-sidecar`: proof bundles over Bitcoin Core RPC (txindex), so
     node operators serve L2/L3 without esplora.
   - Drafts in docs/upstream/ (DRAFT-ONLY, do not post without sign-off): the ord
     URI-extensions discussion (#3780, uris.md, IANA offer), the esplora
     witness-proof PR text with the patch attached, and the CAIP-19 `ordinals`
     namespace profile. All pseudonymous.
9. CAIP-19 namespace profile for inscriptions (none exists; open lane).
10. Rust port of core verification (share test vectors) for wallet embedding.
11. zk wrapper exploration: proof bundles are already the right witness format for a
    circuit (Citrea precedent, RESEARCH.md §3).

## Design decisions already made (don't relitigate casually)

- Canonical `ord:` (upstream), `ord://` accepted alias. The bare-URI referent is
  **undelegated** content (upstream rule); `/content` is delegation-applied.
  ID addressing only: numbers and sats are trusted-index artifacts and are rejected.
- Integrity pins hash **stored body bytes** (a pure on-chain function), not
  transport bytes.
- Proof bundles: JSON v1, mandatory `txCount`, display-order hashes (API-native),
  CBOR reserved for v2.
- L2 ships with named assurances rather than being presented as absolute. The
  multi-leaf gap is real, tested, and documented; L3 is the closure.

## Repo state

TypeScript 7 / Node 22 / vitest 4 / noble 2.x, npm workspaces, git history at
"core → fetch/gateway/cli → docs" milestones. Published to npm as `@ordspv/*`
(0.2.0 security-hardening release; 0.1.x deprecated). All
external claims in docs carry source URLs; uncertainties are listed at the bottom
of RESEARCH.md rather than smoothed over.
