# Contributing

Thanks for your interest in ordspv. This is a small, invariant-heavy codebase:
it resolves Bitcoin ordinals content and proves the bytes against proof-of-work,
so correctness bugs are security bugs. Please read the invariants below before
changing parser or verification code.

## Getting set up

```
npm install
npm test            # vitest, all packages, fully offline (fixtures vendored)
npx tsc --noEmit    # typecheck (TypeScript 7)
npm run build       # tsup ESM + tsc declarations + publish staging + pack dry-run
```

`npm test` needs no network: fixtures are vendored and self-verifying (txids and
header hashes are recomputed in the tests, so a corrupted fixture cannot pass).
CI runs exactly these three commands.

Optional, needs live network:

```
npx tsx scripts/fetch-fixtures.ts   # refresh/extend fixtures + live L2/L3 validation
npx tsx scripts/parity-sweep.ts     # envelope parser parity vs a live ord (ORD_BASE)
```

## Repository layout

```
core    → primitives + proof verification (zero-IO, browser-safe)
fetch   → resolver / backends / header trust (+ node-only /headersync subpath)
gateway → HTTP gateway (proxy + verify personalities, proof endpoint)
cli     → terminal wrapper
sidecar → proof bundles straight from Bitcoin Core RPC
```

See `DEVELOPMENT.md` for commands and gotchas, `ROADMAP.md` for state and
direction, and `docs/spec/` for the wire formats.

## Invariants (do not break)

These are enforced by tests and must stay true. A change that touches them must
cite its source and add a test.

1. **Byte-order discipline.** Every 32-byte hash crosses module boundaries in
   INTERNAL (little-endian, on-the-wire) order. Display hex (byte-reversed) only
   appears at the edges, via `internalToDisplay` / `displayToInternal`. Never
   mix the two; never reverse "to make a test pass."
2. **The envelope parser mirrors ord exactly.** It is an instruction-for-
   instruction port of `ordinals/ord`'s `envelope.rs` (pinned at commit
   `7effaaaf`): tag table, pushnum acceptance, body-separator rule,
   duplicate-before-take, leftover-even ⇒ unbound, and the `from_tapscript`
   scan/stutter semantics. Any change here MUST cite the ord source line and add
   a test; parser divergence from ord is a P0 bug, because it means resolving
   different content than the reference indexer.
3. **Proof bundles carry `txCount`** and depth checks stay mandatory (merkle
   malleability hardening). Never relax verification to "the root matched."
4. **L2 results surface their assurances** (`singleLeafTree`,
   `singleInputReveal`). The multi-leaf gap is real, documented, and tested; L3
   is the closure. Do not present L2 as equivalent to L3.
5. **Core stays zero-IO and browser-safe** (only `@noble/*` dependencies; node
   APIs only behind dynamic import in `fetch/decompress.ts` and the headersync
   subpath).

If you are unsure whether a change affects an invariant, assume it does and add
a test that pins the behavior.

## Tests

- Add a regression test with every bug fix and every behavioral change.
- Prefer self-verifying fixtures (recompute the hash/txid in the test) over
  trusting vendored bytes.
- Security-relevant changes should include an adversarial test: assert the
  attack is rejected or bounded, never that forged content is accepted.

## Commit sign-off (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/).
Sign off every commit to certify you have the right to submit it under the
project's license:

```
git commit -s -m "your message"
```

This appends a `Signed-off-by: Your Name <your@email>` trailer. Commits without
a sign-off will be asked to amend.

## No secrets in the tree

Do not commit credentials, API keys, tokens, private RPC URLs, or personal
endpoints — not in code, tests, fixtures, or commit messages. Backends are
configured at runtime (env vars / options), never hardcoded. If you add an
example URL, use a placeholder.

## Pull requests

- Keep PRs focused; one concern per PR.
- Make sure `npm test`, `npx tsc --noEmit`, and `npm run build` are green.
- Describe what changed and why, and note any invariant you touched and how you
  verified parity.
- Security-sensitive reports should go through the process in `SECURITY.md`
  rather than a public PR.
