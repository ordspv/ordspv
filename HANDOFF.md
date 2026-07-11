# HANDOFF — state of the work and what to build next

*Written 2026-07-11 by the research/spec/initial-implementation pass. Audience: anyone continuing this project. Read DEVELOPMENT.md first for
operational invariants; docs/RESEARCH.md for the full technical rationale.*

## What exists and what it proves

- **Specs (v0.1 drafts)**: URI scheme profile extending ord's own `ord:` draft
  (docs/spec/SPEC-URI.md), verification levels L0–L3 + proof bundle format
  (SPEC-VERIFICATION.md), gateway HTTP surface (SPEC-GATEWAY.md), cross-chain
  embedding guide (docs/CROSS-CHAIN.md), all grounded in the cited research synthesis
  (docs/RESEARCH.md).
- **Working code, 67 tests, all offline-runnable**: `@ord-resolver/core`
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

1. `npm install && npm test && npx tsc --noEmit` — expect 67 green.
2. `npx tsx scripts/fetch-fixtures.ts` — byte-compares vendored fixtures against live
   esplora, then runs LIVE L2 **and L3** resolutions of inscription 0. L3-over-live
   (raw block download → wtxid tree) is the one flow the sandbox could not run;
   synthetic coverage says it works, live confirmation is step one.
3. Re-verify the 824544 checkpoint hash in `packages/fetch/src/headertrust.ts`
   against your own node/two explorers (it was cross-checked via two public APIs but
   is not cryptographically re-verified in tests, unlike 0 and 767430).
4. Vendor extended vectors: `npx tsx scripts/fetch-fixtures.ts <ids…>` with a
   delegate-using, a brotli-encoded, an `i>0`, and a chunked-metadata inscription;
   turn the emitted bundles into offline tests mirroring `resolver.test.ts`.

## Known deltas vs ord to reconcile (small, flagged in code)

- **Stutter semantics are approximated** (`envelope.ts parseEnvelopesFromScript`):
  ord's exact resume/stutter propagation in `envelope.rs` should be mirrored
  instruction-for-instruction and locked with ports of ord's own envelope tests.
  Affects only curse-flag fidelity on pathological pre-Jubilee scripts, never content.
- Parent values: ord's `take_array` keeps invalid encodings in the list (we drop
  non-parsing values when surfacing `parents[]`; raw values remain available via
  `splitPayload`). Decide whether to expose both explicitly.
- `/r/undelegated-content` nuance: for an inscription with NO body but a delegate,
  bare-URI resolution correctly fails — add a live conformance check against ordinals.com
  behavior when extending vectors.

## Prioritized roadmap

**P0 — harden the core claim**
1. Live L3 + extended vectors (above).
2. Port ord's envelope test corpus (envelope.rs `#[cfg(test)]`) into
   `envelope.test.ts` for byte-level parity confidence.
3. Property/fuzz tests: random scripts through the envelope parser (never panic,
   never mis-index); malformed bundle fuzzing on `verifyProofBundle`.

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
