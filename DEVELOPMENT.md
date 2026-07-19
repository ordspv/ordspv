# Development guide

## Commands

- `npm test`: vitest, all packages, fully offline (fixtures vendored)
- `npx tsc --noEmit`: typecheck (TypeScript 7: no `baseUrl`, relative `paths` only)
- `npx tsx packages/cli/src/main.ts …`: the CLI (needs live network for resolve/proof)
- `npx tsx scripts/fetch-fixtures.ts`: refresh/extend fixtures and run LIVE
  end-to-end validation. Run this first when network access is available. Pass
  inscription ids to vendor extended fixtures into `fixtures/extended/`
  (per-vector provenance notes live in `fixtures/extended/SOURCES.md`; add new
  ids to the parity-sweep corpus too).
- `npx tsx scripts/parity-sweep.ts`: envelope-parser parity against a live ord
  instance (`ORD_BASE` to point at your own) over a curated corpus of eras and
  features. ANY mismatch is a P0 bug per invariant 2.
- `npx tsx scripts/build-demo.ts` / `scripts/build-extension.ts`: regenerate the
  committed demo page (examples/) and extension dist-unpacked/
- `npm run build`: tsup ESM, tsc declarations, browser bundle (fetch), then
  publish staging plus pack dry-run into `build/staging/`. The repo package.json
  keeps exporting src/*.ts, so dev always runs live sources; staging is the
  publish shape. Scope `@ordspv/*`, canonical repo github.com/ordspv/ordspv.

## Invariants (do not break)

1. **Byte order discipline**: all 32-byte hashes cross module boundaries in INTERNAL
   (little-endian wire) order; display hex only at edges via
   `internalToDisplay`/`displayToInternal` (`packages/core/src/bytes.ts` doc comment).
2. **Envelope parser mirrors ord exactly** (`ordinals/ord` master @ 7effaaaf):
   tag table incl. 17=properties (NOT 15), pushnum acceptance, even-indexed empty push
   = body separator, duplicate-before-take, leftover-even ⇒ unbound, and
   `from_tapscript` scan semantics (consume-on-failure/no rescan; stutter ASSIGNED
   after failures, never reset by success; script error ⇒ whole tapscript discarded).
   Locked by the ported envelope.rs test corpus in `envelope.test.ts`. Any change
   must cite ord source and add a test.
3. **Proof bundles carry `txCount`** and depth checks stay mandatory
   (CVE-2012-2459/2017-12842 hardening). Never relax to "root matched".
4. **L2 results must surface assurances** (`singleLeafTree`, `singleInputReveal`);
   the multi-leaf gap is documented and tested (`proofbundle.test.ts` "L2 gap").
   Do not silently treat L2 as equivalent to L3.
5. Core stays zero-IO and browser-safe (only `@noble/*` deps; node APIs only behind
   dynamic import in `fetch/decompress.ts`).

## Layout

core (primitives+proof) → fetch (resolver/backends/trust incl. `/headersync`
node-only subpath) → gateway, cli, sidecar (proof bundles over Core RPC).
Specs are in docs/spec/, the research synthesis in docs/RESEARCH.md, the roadmap
in ROADMAP.md, and upstream drafts (DRAFT-ONLY, pseudonymous) in docs/upstream/.
The electrs fork lives at `../electrs`, branch `witness-merkle-proof`. Building
it on this machine needs
`SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk` and
`CXXFLAGS="-isystem $SDKROOT/usr/include/c++/v1"` because CLT is missing the
toolchain libc++ headers. The electrumd dev-dep does not build on macos-arm64,
so `cargo test --test rest` works but `--test electrum` is Linux-only.

## Gotchas encountered

- noble v2: `Point.fromBytes(bytes)` (fromHex is string-only); `sha256` from
  `@noble/hashes/sha2.js`.
- Esplora merkle-proof hashes are display-order (settled empirically, test-locked).
- undici fetch transparently decodes `content-encoding`. Integrity pins hash STORED
  bytes, hence the `INTEGRITY_INDETERMINATE` path in the resolver.
- Vendored fixtures self-verify cryptographically in tests (txids and header
  hashes are recomputed), so a corrupted fixture cannot pass silently.
