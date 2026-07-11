# GOING-PUBLIC.md: ordered checklist

Everything below is sequenced; do not reorder without thinking about why the
order exists. Identity rule for every step: the pseudonym only. No personal
emails, no real names, no accounts linked to other identities, no reuse of
API keys/sessions tied to them. Steps marked 【identity】 need a human at the
keyboard by their nature (account creation, payments, store listings).

## 0. Preconditions (blockers for everything else)

- [x] **Identity rewrite (completed 2026-07-11).** Full history of this repo
      and the electrs branch commits (`new-index..witness-merkle-proof` only;
      upstream Blockstream history untouched so the fork still shares commit
      ids with upstream) rewritten via git-filter-repo: all author/committer
      names+emails → `ordspv <ordspv@users.noreply.github.com>`, all
      author/committer date offsets normalized to +0000; reflogs expired and
      old objects pruned in both repos; the vendored format-patch series
      regenerated from the rewritten branch. Local `git config user.*` set in
      both repos. Conventions going forward: commit with `TZ=UTC` so offsets
      stay +0000. **Standing committer identity (set 2026-07-11, both repos,
      repo-local config): `ordspv <302645753+ordspv@users.noreply.github.com>`**,
      the id-prefixed noreply form, now that the GitHub account exists. All
      future commits use it.
- [x] **Name decided + rename executed (2026-07-11):** `ordspv`. Scope
      `@ordspv/*`, canonical repo `github.com/ordspv/ordspv`, electrs fork
      `github.com/ordspv/electrs`. NAMING.md inventory applied in one commit
      (manifests+lock, imports, configs, docs, drafts, extension manifest,
      regenerated demo/extension/staging artifacts, repository fields).
      REMAINING in step 1: confirm `@ordspv` npm scope + `ordspv` GitHub
      name availability AT account creation, before anything is pushed.
- [ ] LICENSE present and identity-neutral (repo root; ISC, holder
      "the ordspv contributors"). Verify staged package.json manifests carry
      `license` and NO `author` field: `npm run build` then
      `grep -L '"author"' build/staging/*/package.json` (expect all five).
- [ ] Full green: `npm test`, `npx tsc --noEmit`, `npm run build`,
      `npx tsx scripts/parity-sweep.ts`, `npx tsx scripts/fetch-fixtures.ts`.
- [ ] Sweep for identifying info (expect zero hits outside intentional
      pseudonym mentions):
      `grep -rniE -f private/sweep-terms.txt . | grep -v node_modules`
- [ ] Git history authorship check: `git log --format='%an %ae %cn %ce' | sort -u`
      → only the pseudonymous identity + the tool trailer.
- [ ] **Local-path / machine sweep (STANDING; run with every sweep):**
      grep for the literal `$HOME` path and the machine hostname (`hostname`),
      derived locally and never written down, across BOTH worktrees, packed
      tarball contents
      (`npm pack` each staged package and grep the extraction), the demo
      inline bundle, extension dist-unpacked, all `*.js.map` source maps, and
      the vendored `.patch` files. Zero hits expected everywhere; the only
      permitted exception is the untracked, gitignored
      `private/settings.local.json` (local harness config, never pushed).
      *(First run 2026-07-11: zero hits in all publishable artifacts.)*

## 1. Accounts 【identity】

- [ ] GitHub account/org under the pseudonym (fresh email; 2FA; no recovery
      paths through personal accounts).
- [ ] npm account under the pseudonym; create the org/scope; enable 2FA and
      granular publish tokens.
- [ ] (optional, for posts) accounts on the forums where the drafts land.
      GitHub covers ord, esplora, and CAIPs.

## 2. Repo push (CI goes live here)

- [x] Remote configured (2026-07-11): `origin = git@github-ordspv:ordspv/ordspv.git`
      (SSH alias `github-ordspv` present in ~/.ssh/config). NOTHING pushed yet.
- [ ] Create the GitHub repo (public), push `master`.
- [ ] Confirm Actions run green on push (the workflow already runs
      test + tsc + build; it is fully offline).
- [ ] Enable branch protection on the default branch (CI required).
- [ ] Spot-check the rendered README and that `examples/verify-inscription-0.html`
      raw link works (this is the "click and watch" artifact; consider GitHub
      Pages for a clean URL).

## 3. electrs fork push

- [ ] Fork Blockstream/electrs under the pseudonym on GitHub (fork repo does
      NOT exist yet).
- [x] Fork remote configured (2026-07-11):
      `fork = git@github-ordspv:ordspv/electrs.git` (Blockstream stays
      `origin`). NOTHING pushed yet.
- [ ] Push the `witness-merkle-proof` branch to `fork` (1 commit on top of
      `new-index`).
- [ ] Verify the fork's CI (if any) or at minimum that the branch shows the
      commit cleanly. The format-patch series in
      `docs/upstream/patches/electrs-witness-merkle-proof/` is the backup if
      the PR must be re-rolled.

## 4. npm publish (dependents after dependencies)

```
core → fetch → gateway, cli, sidecar
```

- [ ] `npm run build` (staging refreshed), then from `build/staging/<pkg>`:
      `npm publish --access public` in the order above.
- [ ] Post-publish smoke: in a scratch dir,
      `npm i @ordspv/fetch` and run the resolver against inscription 0;
      `npx @ordspv/cli ord:<insc0-id> --json`.
- [ ] Tag the repo (`v0.1.0`) at the published commit.

## 5. Posts (each is a draft in this directory; final read before sending)

Order: code-bearing first, then the discussion that links to it.

- [ ] Blockstream/electrs PR: `esplora-witness-proof-draft.md`
      (branch from step 3; bench numbers already in the draft). Include the
      API.md addition for Blockstream/esplora as noted in the draft.
- [ ] ordinals/ord Discussion: `ord-uri-extensions-draft.md`. Links are
      concrete (github.com/ordspv/…); post referencing #3780.
- [ ] ChainAgnostic/namespaces PR: `caip19-inscriptions.md` (re-derive the
      signet chain id first, per its posting notes).
- [ ] Only AFTER the ord discussion has any traction: IANA provisional
      registration offer per the draft.

## 6. Aftercare

- [ ] Watch the parity sweep weekly against ordinals.com (ord upgrades can
      shift behavior; any mismatch is a P0).
- [ ] Track upstream review feedback. The electrs branch rebases cleanly;
      keep it PR-ready.
- [ ] Browser-extension store submission is deliberately NOT in this list.
      It is a separate 【identity】 workstream (developer accounts, listing
      assets, privacy policy hosting) queued behind adoption signals.

## Explicit non-goals right now

- No mainnet-facing hosted gateway under the project's name (operational
  commitment + abuse surface; revisit with infrastructure).
- No token, no fundraising, no "official" anything. Infrastructure only.
