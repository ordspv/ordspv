---
name: Bug report
about: Something resolves wrong, fails to verify, or crashes
title: ''
labels: bug
assignees: ''
---

<!--
SECURITY: if this is a way to make forged content verify, to bypass header
anchoring, or to exhaust resources, DO NOT file it here. Report it privately —
see SECURITY.md.
-->

## What happened

A clear description of the bug.

## Reproduction

Steps or a minimal script. Include the exact input where possible:

- Package + version (`@ordspv/core|fetch|gateway|cli|proof-sidecar` `0.2.x`)
- Inscription id / URI, or the proof bundle JSON
- Verification level (none / L1 / L2 / L3)
- Backends used (esplora / ord gateway / Electrum / Core RPC), or "defaults"

```
# command or code
```

## Expected vs actual

- Expected:
- Actual (include the exact error message / stack if any):

## Environment

- Node version:
- OS:
- Network: mainnet / signet / regtest / other

## Notes

Anything else — is it reproducible, intermittent, tied to one backend, etc.
