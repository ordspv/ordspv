# GOING-PUBLIC.md — ordered checklist

Everything below is sequenced; do not reorder without thinking about why the
order exists. Identity rule for every step: the pseudonym only — no personal
emails, no real names, no accounts linked to other identities, no reuse of
API keys/sessions tied to them. Steps marked 【identity】 need a human at the
keyboard by their nature (account creation, payments, store listings).

## 0. Preconditions (blockers for everything else)

- [ ] Final name decided; `@<scope>` npm availability + GitHub org availability
      confirmed; then land the NAMING.md rename commit (one commit, includes
      rebuilt demo/extension artifacts and draft-link fills).
- [ ] LICENSE present and identity-neutral (repo root; ISC, holder
      "the <name> contributors"). Verify staged package.json manifests carry
      `license` and NO `author` field: `npm run build` then
      `grep -L '"author"' build/staging/*/package.json` (expect all five).
- [ ] Full green: `npm test`, `npx tsc --noEmit`, `npm run build`,
      `npx tsx scripts/parity-sweep.ts`, `npx tsx scripts/fetch-fixtures.ts`.
- [ ] Sweep for identifying info (expect zero hits outside intentional
      pseudonym mentions):
      `grep -rniE -f private/sweep-terms.txt . | grep -v node_modules`
- [ ] Git history authorship check: `git log --format='%an %ae %cn %ce' | sort -u`
      → only the pseudonymous identity + the tool trailer.

## 1. Accounts 【identity】

- [ ] GitHub account/org under the pseudonym (fresh email; 2FA; no recovery
      paths through personal accounts).
- [ ] npm account under the pseudonym; create the org/scope; enable 2FA and
      granular publish tokens.
- [ ] (optional, for posts) accounts on the forums where the drafts land —
      GitHub covers ord + esplora + CAIPs.

## 2. Repo push (CI goes live here)

- [ ] Create the GitHub repo (public), push `master`.
- [ ] Confirm Actions run green on push (the workflow already runs
      test + tsc + build; it is fully offline).
- [ ] Enable branch protection on the default branch (CI required).
- [ ] Spot-check the rendered README and that `examples/verify-inscription-0.html`
      raw link works (this is the "click and watch" artifact; consider GitHub
      Pages for a clean URL).

## 3. electrs fork push

- [ ] Fork Blockstream/electrs under the pseudonym on GitHub.
- [ ] `git -C ../electrs remote add fork <fork-url>` and push the
      `witness-merkle-proof` branch (1 commit on top of `new-index`).
- [ ] Verify the fork's CI (if any) or at minimum that the branch shows the
      commit cleanly. The format-patch series in
      `docs/upstream/patches/electrs-witness-merkle-proof/` is the backup if
      the PR must be re-rolled.

## 4. npm publish (order matters — dependents after dependencies)

```
core → fetch → gateway, cli, sidecar
```

- [ ] `npm run build` (staging refreshed), then from `build/staging/<pkg>`:
      `npm publish --access public` in the order above.
- [ ] Post-publish smoke: in a scratch dir,
      `npm i @<scope>/fetch` and run the resolver against inscription 0;
      `npx @<scope>/cli ord:<insc0-id> --json`.
- [ ] Tag the repo (`v0.1.0`) at the published commit.

## 5. Posts (each is a draft in this directory — final read before sending)

Order: code-bearing first, then the discussion that links to it.

- [ ] Blockstream/electrs PR: `esplora-witness-proof-draft.md`
      (branch from step 3; bench numbers already in the draft). Include the
      API.md addition for Blockstream/esplora as noted in the draft.
- [ ] ordinals/ord Discussion: `ord-uri-extensions-draft.md` — fill the repo
      and fork links (now real), post referencing #3780.
- [ ] ChainAgnostic/namespaces PR: `caip19-inscriptions.md` (re-derive the
      signet chain id first, per its posting notes).
- [ ] Only AFTER the ord discussion has any traction: IANA provisional
      registration offer per the draft.

## 6. Aftercare

- [ ] Watch the parity sweep weekly against ordinals.com (ord upgrades can
      shift behavior; any mismatch is a P0).
- [ ] Track upstream review feedback; the electrs branch rebases cleanly —
      keep it PR-ready.
- [ ] Browser-extension store submission is deliberately NOT in this list —
      it is a separate 【identity】 workstream (developer accounts, listing
      assets, privacy policy hosting) queued behind adoption signals.

## Explicit non-goals right now

- No mainnet-facing hosted gateway under the project's name (operational
  commitment + abuse surface; revisit with infrastructure).
- No token, no fundraising, no "official" anything — infrastructure only.
