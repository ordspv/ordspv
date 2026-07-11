# HANDOFF — state of the work and what to build next

*Written 2026-07-11 by the research/spec/initial-implementation pass. Audience: anyone continuing this project. Read DEVELOPMENT.md first for
operational invariants; docs/RESEARCH.md for the full technical rationale.*

## What exists and what it proves

- **Specs (v0.1 drafts)**: URI scheme profile extending ord's own `ord:` draft
  (docs/spec/SPEC-URI.md), verification levels L0–L3 + proof bundle format
  (SPEC-VERIFICATION.md), gateway HTTP surface (SPEC-GATEWAY.md), cross-chain
  embedding guide (docs/CROSS-CHAIN.md), all grounded in the cited research synthesis
  (docs/RESEARCH.md).
- **Working code, 143 tests, all offline-runnable**: `@ord-resolver/core`
  (consensus primitives, ord-exact envelope parser, L2/L3 proof verification),
  `@ord-resolver/fetch` (verified resolver: failover backends, checkpoint + M-of-N
  header trust, delegation with dual verification, integrity pins, encoding handling),
  `@ord-resolver/gateway` (proxy/verify personalities, proof endpoint),
  `@ord-resolver/cli`.
- **Live-validated**: inscription 0 verifies at L2 end-to-end from real mainnet bytes
  (vendored, self-verifying fixtures). The BIP-341 check passes against the real
  commit output; the esplora merkle proof folds to the real header.
- **Adversarially validated (synthetic)**: witness-swap forgery accepted by L2 is
  rejected by L3; txCount inflation, tampered tapscript, tampered content, checkpoint
  contradiction, integrity mismatch all fail with the right errors.

## Validation checklist (needs live network — the build sandbox had none)

1. `npm install && npm test && npx tsc --noEmit` — expect 143 green.
2. `npx tsx scripts/fetch-fixtures.ts` — byte-compares vendored fixtures against live
   esplora, then runs LIVE L2 **and L3** resolutions of inscription 0. *(Both ran
   green 2026-07-11, before and after the envelope-parser rewrite.)*
3. Re-verify the 824544 checkpoint hash in `packages/fetch/src/headertrust.ts`
   against your own node/two explorers. *(Confirmed identical on mempool.space,
   blockstream.info, blockchain.info 2026-07-11; still not re-verified in tests.)*
4. ~~Vendor extended vectors~~ **DONE 2026-07-11** — seven mainnet vectors in
   `fixtures/extended/` (pushnum pre-Jubilee cursed, i>0+pointer batch, brotli,
   gzip+note, chunked >520B metadata, delegate with empty body, delegate target),
   offline-tested in `packages/fetch/test/extended.test.ts`. Additionally
   `scripts/parity-sweep.ts` cross-checks the parser against a live ord instance
   (existence/index/count via 404-at-i(count), content_type, content_length,
   delegate, body sha256 incl. tag-9 encodings, metadata hex, pre-Jubilee curse
   charm) over a wider corpus incl. a 666-envelope batch and a multi-input
   reveal — 142 checks green on 2026-07-11, zero mismatches.

## Known deltas vs ord to reconcile (small, flagged in code)

- ~~**Stutter semantics are approximated**~~ **RESOLVED 2026-07-11**:
  `parseEnvelopesFromScript` is now an instruction-for-instruction port of ord's
  `from_tapscript`/`from_instructions`/`accept` (consume-on-failure, assign-not-or
  stutter, no reset on success, whole-tapscript discard on script error — the old
  rescanning parser could find envelopes ord never sees). Locked by the full port
  of ord's envelope.rs test corpus plus consume-semantics tests (envelope.test.ts);
  the five divergence tests were verified to fail against the old implementation.
- Parent values: ord's `take_array` keeps invalid encodings in the list (we drop
  non-parsing values when surfacing `parents[]`; raw values remain available via
  `splitPayload`). Decide whether to expose both explicitly.
- ~~`/r/undelegated-content` nuance~~ **CONFIRMED 2026-07-11**: live sweep shows
  ord 404s `/r/undelegated-content` for a no-body delegate inscription (bare-URI
  failure is correct, `69696d8f…i0`), and serves 0 bytes for an EMPTY-but-present
  body (`0028084b…i0`) — our resolver matches both (offline test in
  extended.test.ts locks the empty-body case). The check is a standing part of
  scripts/parity-sweep.ts.

## Prioritized roadmap

**P0 — harden the core claim**
1. ~~Live L3 + extended vectors~~ **DONE 2026-07-11** — live L3 confirmed,
   checkpoint re-verified, seven extended vectors vendored + offline-tested,
   live parity sweep green (checklist above).
2. ~~Port ord's envelope test corpus~~ **DONE 2026-07-11** — all 41 corpus tests
   from envelope.rs `mod tests` ported by name into `envelope.test.ts`, plus 5
   consume-semantics locks beyond the corpus; parser rewritten to match (see
   Known deltas).
3. ~~Property/fuzz tests~~ **DONE 2026-07-11** — seeded (reproducible) fuzz:
   `envelope.fuzz.test.ts` (parser total + deterministic over random bytes,
   grammar-biased soup, and mutations of the real vendored tapscripts; body
   rule and dense index/offset numbering as properties) and
   `proofbundle.fuzz.test.ts` (attestation-invariance: ~700 seeded mutations of
   9 real/synthetic bundles must be rejected or leave the attestation
   byte-identical; cross-bundle splices, garbage inputs, id re-addressing;
   explicit locks that height is trustHeader's job and that L2's sig-witness
   gap is real while L3 closes it).

**P1 — make it adoptable**
4. Build pipeline: tsup/tsc dual ESM+types, browser bundle for core+fetch (core is
   already browser-safe; swap `decompress.ts` node path), publish dry-run.
5. Header sync module: Electrum `cp_height`-style checkpointed sync or P2P headers
   (~77 MB), replacing M-of-N hash-at-height as the default anchor. Design sketch in
   SPEC-VERIFICATION §4.
6. Gateway productionization: streaming bodies, LRU + immutable CDN headers (done),
   rate limits, metrics, Docker; subdomain-per-inscription origin isolation option.
7. Browser extension / service-worker resolver ("IPFS Companion for ord:") rewriting
   `ord:` and gateway URLs through `ordFetch`.

**P2 — ecosystem moves** (sequencing rationale in CROSS-CHAIN.md)
8. Coordinate with upstream ord on: the `ord://` alias + path extensions (open a
   discussion referencing #3780 and the uris.md draft), IANA provisional registration,
   and — highest leverage — a `/tx/:txid/witness-merkle-proof` endpoint upstreamed to
   esplora/electrs so L3 gets cheap everywhere (kills the last infrastructure gap).
9. CAIP-19 namespace profile for inscriptions (none exists; open lane).
10. Rust port of core verification (share test vectors) for wallet embedding.
11. zk wrapper exploration: proof bundles are already the right witness format for a
    circuit (Citrea precedent, RESEARCH.md §3).

## Design decisions already made (don't relitigate casually)

- Canonical `ord:` (upstream), `ord://` accepted alias; bare-URI referent =
  **undelegated** content (upstream rule); `/content` = delegation-applied;
  ID addressing only (numbers/sats rejected — trusted-index artifacts).
- Integrity pins hash **stored body bytes** (pure on-chain function), not
  transport bytes.
- Proof bundles: JSON v1, mandatory `txCount`, display-order hashes (API-native),
  CBOR reserved for v2.
- L2 ships with named assurances rather than being presented as absolute — the
  multi-leaf gap is real, tested, and documented; L3 is the closure.

## Repo state

TypeScript 7 / Node 22 / vitest 4 / noble 2.x, npm workspaces, git history at
"core → fetch/gateway/cli → docs" milestones. No CI yet (add vitest + tsc workflow
first). Nothing published to npm. All external claims in docs carry source URLs;
uncertainties are listed at the bottom of RESEARCH.md rather than smoothed over.
