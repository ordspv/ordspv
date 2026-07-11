# DEVELOPMENT.md — operational guide for this repo

## Commands

- `npm test` — vitest, all packages, fully offline (fixtures vendored)
- `npx tsc --noEmit` — typecheck (TypeScript 7: no `baseUrl`, relative `paths` only)
- `npx tsx packages/cli/src/main.ts …` — CLI (needs live network for resolve/proof)
- `npx tsx scripts/fetch-fixtures.ts` — refresh/extend fixtures + LIVE end-to-end
  validation (run this first in any network-enabled session; it was written in a
  sandbox without direct API egress)

## Invariants — do not break

1. **Byte order discipline**: all 32-byte hashes cross module boundaries in INTERNAL
   (little-endian wire) order; display hex only at edges via
   `internalToDisplay`/`displayToInternal` (`packages/core/src/bytes.ts` doc comment).
2. **Envelope parser mirrors ord exactly** (`ordinals/ord` master @ 7effaaaf):
   tag table incl. 17=properties (NOT 15), pushnum acceptance, even-indexed empty push
   = body separator, duplicate-before-take, leftover-even ⇒ unbound. Any change must
   cite ord source and add a test.
3. **Proof bundles carry `txCount`** and depth checks stay mandatory
   (CVE-2012-2459/2017-12842 hardening) — never relax to "root matched".
4. **L2 results must surface assurances** (`singleLeafTree`, `singleInputReveal`);
   the multi-leaf gap is documented and tested (`proofbundle.test.ts` "L2 gap") — do
   not silently treat L2 as equivalent to L3.
5. Core stays zero-IO and browser-safe (only `@noble/*` deps; node APIs only behind
   dynamic import in `fetch/decompress.ts`).

## Layout

core (primitives+proof) → fetch (resolver/backends/trust) → gateway, cli
specs in docs/spec/; research synthesis in docs/RESEARCH.md; roadmap in HANDOFF.md.

## Gotchas encountered

- noble v2: `Point.fromBytes(bytes)` (fromHex is string-only); `sha256` from
  `@noble/hashes/sha2.js`.
- Esplora merkle-proof hashes are display-order (settled empirically, test-locked).
- undici fetch transparently decodes `content-encoding` — integrity pins hash STORED
  bytes, hence the `INTEGRITY_INDETERMINATE` path in the resolver.
- Vendored fixtures self-verify cryptographically in tests (txids and header
  hashes are recomputed), so a corrupted fixture cannot pass silently.
