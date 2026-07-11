# NAMING.md — every touch point a scope/name change hits

`@ord-resolver/*` and the repo name `ord-resolver` are PLACEHOLDERS. Once the
final name is decided, the rename is ONE mechanical commit over the inventory
below, plus the electrs-fork and account-level items at the bottom. Nothing
should be published or posted before this commit lands.

## Mechanical rename (single commit, mostly find/replace)

Two strings to replace, in this order:

1. `@ord-resolver/` → `@<newscope>/` (package scope; exact, with trailing slash)
2. `ord-resolver` → `<newname>` (repo name, prose references, workspace name)

Touch points by kind:

**Package manifests + lock**
- `package.json` (root `name`)
- `packages/{core,fetch,gateway,cli,sidecar}/package.json` (`name` + workspace
  `dependencies` on `@ord-resolver/*`)
- `packages/sidecar/package.json` bin name `ord-proof-sidecar` (decide: keep or
  rename bins `ord-resolve`/`ord-proof-sidecar` — they are user-facing commands)
- `package-lock.json` — do NOT hand-edit; run `npm install` after the manifest
  changes and commit the regenerated lock

**Imports (every `from '@ord-resolver/...'`)**
- `packages/*/src/**` and `packages/*/test/**` (fetch, gateway, cli, sidecar,
  cross-package imports)
- `scripts/*.ts` (build, build-demo, build-extension, fetch-fixtures,
  fetch-header-fixture, parity-sweep)
- `examples/src/demo.ts`, `extension/src/viewer.ts`

**Build/config**
- `tsconfig.json` (`paths` keys)
- `vitest.config.ts` (`resolve.alias` keys)
- `packages/{fetch,gateway,sidecar}/tsconfig.build.json` (`paths` keys)
- `scripts/build.ts` (`EXTERNAL` regex `/^@ord-resolver\//`, staging notes)

**Docs & specs (prose + "Reference implementation" lines)**
- `README.md`, `DEVELOPMENT.md`, `HANDOFF.md`
- `docs/spec/SPEC-URI.md`, `SPEC-VERIFICATION.md`, `SPEC-GATEWAY.md`
- `docs/CROSS-CHAIN.md`, `docs/RESEARCH.md`
- `examples/README.md`, `extension/README.md`
- `docs/upstream/*.md` drafts (incl. PLACEHOLDER repo links — fill with the
  real URLs in the same commit)

**Extension**
- `extension/src/manifest.json` (`name`, `description` — currently marked
  placeholder)
- rebuild `extension/dist-unpacked/` (`npx tsx scripts/build-extension.ts`)

**Generated artifacts to rebuild in the same commit**
- `examples/verify-inscription-0.html` (`npx tsx scripts/build-demo.ts` —
  footer names the repo)
- `npm run build` (staging manifests re-derive from package.json)

**Outside this repo**
- electrs fork: no name references in the patch itself (verify with
  `git -C ../electrs log -p new-index..witness-merkle-proof | grep -i resolver`),
  but the PR text in `docs/upstream/esplora-witness-proof-draft.md` links the
  repo — fill after rename.
- npm scope: register `@<newscope>` (or confirm availability) BEFORE the
  rename commit; scope squatting is unfixable after posts go out.
- GitHub org/user name: same — secure it first.

## Verification after the rename

```
grep -rn "ord-resolver" --include="*.ts" --include="*.json" --include="*.md" \
  --include="*.yml" --include="*.html" . | grep -v node_modules | grep -v Cargo
npm test && npx tsc --noEmit && npm run build
npx tsx scripts/build-demo.ts && npx tsx scripts/build-extension.ts
```

Expect ZERO hits (the electrs clone at `../electrs` is outside the sweep).
