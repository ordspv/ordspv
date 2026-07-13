## What and why

<!-- What does this change, and what problem does it solve? -->

## Invariants

<!-- Tick what applies; see CONTRIBUTING.md. -->

- [ ] Byte-order discipline preserved (internal LE across boundaries, display
      hex only at edges)
- [ ] Envelope parser unchanged, OR change cites the `ordinals/ord` source and
      adds a parity test
- [ ] Proof verification not relaxed (`txCount` + depth checks intact)
- [ ] L2/L3 assurances still surfaced honestly
- [ ] Core stays zero-IO / browser-safe (node APIs only behind dynamic import)

## Testing

- [ ] `npm test` green
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` succeeds
- [ ] Added a regression test for the fix / behavior change
- [ ] For security-relevant changes: an adversarial test asserting the attack is
      rejected or bounded

## Checklist

- [ ] Commits are signed off (`git commit -s`, DCO)
- [ ] No secrets, credentials, or private endpoints added
- [ ] Docs / CHANGELOG updated if user-facing

## Notes for reviewers

<!-- Anything that needs a close look, or context that is not obvious from the diff. -->
