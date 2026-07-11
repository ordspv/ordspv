# ord-resolver

**Trustless resolution of Bitcoin ordinals inscription content — `ord:` URIs with
IPFS-grade (and better) verification, no ord server trust required.**

A token on Ethereum (or anywhere) that wants its metadata to *be* a Bitcoin
inscription currently points at `https://ordinals.com/content/<id>` and inherits one
hosted server's uptime, rate limits, and honesty. This project is the missing
plumbing: a URI scheme profile, a verification protocol that binds inscription bytes
to Bitcoin proof-of-work, a verified-fetch client, and a gateway — so `ord:<id>` can
work the way `ipfs://<cid>` works, except the "CID check" is an SPV proof.

```
tokenURI: ord:6fb976…2799i0/content#integrity=sha256-…
                     │
   ┌─────────────────┴────────────────────┐
   │            @ord-resolver/fetch        │  ordFetch("ord:…") → Response
   │  parse → proof-build → verify → serve │
   └──────┬──────────────────┬─────────────┘
          │ untrusted        │ untrusted
   esplora/electrum      ord gateways
   (txs, proofs,         (content, recursion
    headers, blocks)      — availability only)
```

## The trick

Inscription content lives in the reveal transaction's **witness**, which the txid does
NOT commit to — so "the txid matched" proves nothing about bytes, and naive resolvers
are forgeable. Two commitments close the gap using only generic Bitcoin data sources:

- **L2 — tapscript commitment** (BIP-341): the reveal's txid-committed input points at
  the commit output, whose taproot key must commit to the served envelope script.
  ~0.9 KB of proof, all from any esplora instance.
- **L3 — witness commitment** (BIP-141): the coinbase's `aa21a9ed` commitment pins the
  exact reveal witness via the wtxid tree. What a full node enforces.

Levels **L0** (trusted gateway), **L1** (`#integrity=` sha256 pin — verifiable with
zero Bitcoin infrastructure), L2, L3 are formalized in the specs, with the L2
inscriber-level caveat precisely characterized, tested, and surfaced as assurances.

## Packages

| package | what |
|---|---|
| `@ord-resolver/core` | zero-IO primitives: tx/header/block parsing, merkle + witness-commitment proofs, BIP-341 checks, ord-exact envelope parser, proof-bundle verifier, CBOR |
| `@ord-resolver/fetch` | `ordFetch()` / `OrdResolver`: URI parsing, esplora/ord backends with failover, proof building, header trust (checkpoints + M-of-N), delegation, integrity pins |
| `@ord-resolver/gateway` | reference HTTP gateway: ord-parity `/content` + `/r/*`, `/ord/v1/proof` bundles, verify-before-serve mode |
| `@ord-resolver/cli` | `ord-resolve <uri>`, `proof`, `verify`, `parse` |
| `@ord-resolver/proof-sidecar` | proof bundles straight from a Bitcoin Core node (txindex) — L2/L3 without hosting esplora |

## Quick start

```bash
npm install
npm test                                  # 165 tests, incl. real mainnet vectors, offline

# resolve + verify inscription 0 at L2 (live network):
npx tsx packages/cli/src/main.ts ord:6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0 --out skull.png --json

# emit an offline-verifiable proof bundle:
npx tsx packages/cli/src/main.ts proof 6fb976…2799i0 --level L2 > bundle.json
npx tsx packages/cli/src/main.ts verify bundle.json

# run a verifying gateway:
GATEWAY_MODE=verify npx tsx packages/gateway/src/index.ts
```

```ts
import { ordFetch } from '@ord-resolver/fetch';
const res = await ordFetch('ord:<id>/content');   // verified at L2 by default
```

## Documents

- [docs/RESEARCH.md](docs/RESEARCH.md) — cited synthesis: protocol facts (verified
  against ord master), verification analysis, ecosystem matrix, design decisions
- [docs/spec/SPEC-URI.md](docs/spec/SPEC-URI.md) — the `ord:` scheme profile
  (extends the upstream draft, doesn't fork it)
- [docs/spec/SPEC-VERIFICATION.md](docs/spec/SPEC-VERIFICATION.md) — levels L0–L3,
  proof bundle format, merkle hardening, header anchoring
- [docs/spec/SPEC-GATEWAY.md](docs/spec/SPEC-GATEWAY.md) — HTTP surface, personalities,
  attestation, recursion tiers
- [docs/CROSS-CHAIN.md](docs/CROSS-CHAIN.md) — how EVM tokens should embed `ord:` URIs
- [HANDOFF.md](HANDOFF.md) — state of the work + prioritized roadmap

## Status

Working initial implementation with the cryptographic core complete and tested against
real mainnet data (inscription 0 verifies at L2 end-to-end offline from vendored
fixtures; L3 verified on consensus-shaped synthetic blocks, including forgery
rejection). Specs are v0.1 drafts. Not production software yet — see HANDOFF.md.
