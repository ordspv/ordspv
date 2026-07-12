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
      names+emails → `ordspv <302645753+ordspv@users.noreply.github.com>`
      (the id-prefixed noreply form, so GitHub attributes every commit to
      the account), all author/committer date offsets normalized to +0000;
      reflogs expired and old objects pruned in both repos; the vendored
      format-patch series regenerated from the rewritten branch. **The
      id-prefixed email is uniform across ALL history in both repos and is
      the standing committer identity (repo-local `git config user.*`, both
      repos).** Conventions going forward: commit with `TZ=UTC` so offsets
      stay +0000.
- [x] **Name decided + rename executed (2026-07-11):** `ordspv`. Scope
      `@ordspv/*`, canonical repo `github.com/ordspv/ordspv`, electrs fork
      `github.com/ordspv/electrs`. NAMING.md inventory applied in one commit
      (manifests+lock, imports, configs, docs, drafts, extension manifest,
      regenerated demo/extension/staging artifacts, repository fields).
      REMAINING in step 1: confirm `@ordspv` npm scope + `ordspv` GitHub
      name availability AT account creation, before anything is pushed.
- [x] LICENSE present and identity-neutral (repo root; ISC, holder
      "the ordspv contributors"). Verify staged package.json manifests carry
      `license` and NO `author` field: `npm run build` then
      `grep -L '"author"' build/staging/*/package.json` (expect all five).
      *(Verified 2026-07-12: all five staged manifests ISC, none carry author.)*
- [ ] Full green: `npm test`, `npx tsc --noEmit`, `npm run build`,
      `npx tsx scripts/parity-sweep.ts`, `npx tsx scripts/fetch-fixtures.ts`.
- [x] Sweep for identifying info (expect zero hits outside intentional
      pseudonym mentions). The term list lives ONLY in the untracked,
      gitignored `private/sweep-terms.txt` (one pattern per line) and is
      read at run time; the terms themselves are never written into
      anything committed:
      `grep -rniE -f private/sweep-terms.txt --exclude-dir=node_modules --exclude-dir=private .`
      *(Run 2026-07-12: zero identifying hits; only incidental English
      substrings of a pattern, reviewed.)*
- [x] Git history authorship check: `git log --format='%an %ae %cn %ce' | sort -u`
      → exactly one line, the pseudonymous identity
      `ordspv <302645753+ordspv@users.noreply.github.com>` as both author
      and committer; nothing else. *(Verified 2026-07-12, both repos.)*
- [ ] **Local-path / machine sweep (STANDING; run with every sweep):**
      grep for the literal `$HOME` path and the machine hostname (`hostname`),
      derived locally and never written down, across BOTH worktrees, packed
      tarball contents
      (`npm pack` each staged package and grep the extraction), the demo
      inline bundle, extension dist-unpacked, all `*.js.map` source maps, and
      the vendored `.patch` files. Zero hits expected everywhere; the only
      permitted exceptions are untracked local tooling directories
      (covered by the machine's global git excludes).
      *(First run 2026-07-11; latest 2026-07-12 incl. fresh staging: zero
      hits in all publishable artifacts.)*

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
- [x] Create the GitHub repo (public), push `master`. *(Pushed 2026-07-12.)*
- [x] Confirm Actions run green on push (the workflow already runs
      test + tsc + build; it is fully offline). *(2026-07-12: run concluded
      success on the pushed head.)*
- [ ] Enable branch protection on the default branch (CI required).
- [ ] Spot-check the rendered README and that `examples/verify-inscription-0.html`
      raw link works (this is the "click and watch" artifact; consider GitHub
      Pages for a clean URL). *(Raw link returns 200 as of 2026-07-12;
      rendered-README and Pages check still pending.)*

## 3. electrs fork push

- [x] Fork Blockstream/electrs under the pseudonym on GitHub. *(Exists;
      received the branch push 2026-07-12.)*
- [x] Fork remote configured (2026-07-11):
      `fork = git@github-ordspv:ordspv/electrs.git` (Blockstream stays
      `origin`).
- [x] Push the `witness-merkle-proof` branch to `fork` (1 commit on top of
      `new-index`). *(Pushed 2026-07-12.)*
- [x] Verify the fork's CI (if any) or at minimum that the branch shows the
      commit cleanly. The format-patch series in
      `docs/upstream/patches/electrs-witness-merkle-proof/` is the backup if
      the PR must be re-rolled. *(2026-07-12: public API shows the branch
      commit with the pseudonymous identity, +0000 dates, clean message.)*

## 4. npm publish (dependents after dependencies)

```
core → fetch → gateway, cli, sidecar
```

- [x] `npm run build` (staging refreshed), then from `build/staging/<pkg>`:
      `npm publish --access public` in the order above. *(2026-07-12: all
      five packages live on the registry at 0.1.0.)*
- [x] Post-publish smoke: in a scratch dir,
      `npm i @ordspv/fetch` and run the resolver against inscription 0;
      `npx @ordspv/cli ord:<insc0-id> --json`. *(2026-07-12: fetch-resolver
      smoke green — L2 verified, body sha256 matches. The 0.1.0 cli bin
      shipped a dev-runner shebang and failed under npx; republished as
      0.1.1 (0.1.0 deprecated) and the npx smoke re-run green from a fresh
      scratch dir.)*
- [x] Tag the repo (`v0.1.0`) at the published commit. *(Pushed 2026-07-12.)*

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
