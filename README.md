# ordspv

**Trustless resolution of Bitcoin ordinals inscription content. An `ord:` URI
resolves to bytes verified against Bitcoin proof of work, with no trusted ord
server.**

A token on Ethereum (or anywhere) that wants its metadata to *be* a Bitcoin
inscription currently points at `https://ordinals.com/content/<id>` and inherits one
hosted server's uptime, rate limits, and honesty. This project is the missing
plumbing: a URI scheme profile, a verification protocol that binds inscription bytes
to Bitcoin proof-of-work, a verified-fetch client, and a gateway. `ord:<id>` can then
work the way `ipfs://<cid>` works, except the "CID check" is an SPV proof.

```
tokenURI: ord:6fb976…2799i0/content#integrity=sha256-…
                     │
   ┌─────────────────┴────────────────────┐
   │            @ordspv/fetch              │  ordFetch("ord:…") → Response
   │  parse → proof-build → verify → serve │
   └──────┬──────────────────┬─────────────┘
          │ untrusted        │ untrusted
   esplora/electrum      ord gateways
   (txs, proofs,         (content, recursion;
    headers, blocks)       availability only)
```

## The trick

Inscription content lives in the reveal transaction's **witness**, which the txid does
NOT commit to. "The txid matched" therefore proves nothing about the bytes, and naive
resolvers are forgeable. Two commitments close the gap using only generic Bitcoin data
sources:

- **L2** (BIP-341 tapscript commitment): the reveal's txid-committed input points at
  the commit output, whose taproot key must commit to the served envelope script.
  About 0.9 KB of proof, all of it available from any esplora instance.
- **L3** (BIP-141 witness commitment): the coinbase's `aa21a9ed` commitment pins the
  exact reveal witness via the wtxid tree. This is what a full node enforces.

Levels **L0** (trusted gateway), **L1** (`#integrity=` sha256 pin, checkable with
zero Bitcoin infrastructure), L2, and L3 are formalized in the specs. The L2
inscriber-level caveat is characterized precisely, tested, and surfaced as assurances.

## Custody proofs

Content verification answers what an inscription's bytes are. `ord-resolve
custody <id>` answers where the inscribed sat is. The custody bundle walks the
satpoint from the reveal through each confirmed spend: every hop transaction
is merkle-proven into a PoW-checked header, and the ordinal transfer
arithmetic is recomputed locally from input values proven by the previous
transactions the spending inputs name. Backends only find the path; a lying
backend can withhold a path and cannot fabricate one. v1 refuses fee and
coinbase paths and inscriptions ord treats as unbound; these refusals throw
`CustodyUnsupportedError`. The final outpoint's unspent status is reported as
per-source observations, since no inclusion proof can express a negative. The
bundle format and verification rules are in
[docs/spec/SPEC-CUSTODY.md](docs/spec/SPEC-CUSTODY.md).

## Sat identity

`ord-resolve sat <id>` answers which sat an inscription lives on, with its
ordinal name and rarity, by running the same machinery backward to the coinbase
that mined it. Reversing the walk removes the pathfinder entirely: forward
custody has to ask a backend which transaction spent an outpoint, while
backward every input already names its funding txid, so ancestry is a hash chain
and a backend serving wrong bytes fails the check locally. Intermediate
transactions need no inclusion proofs at all, since each is pinned by the txid
its successor names, and only the reveal and terminal coinbase anchor to
headers. Sat numbers come from the ordinal theory closed forms, and the
coinbase's own BIP34 height is cross-checked against the bundle's claim so the
one figure a server could otherwise choose freely is verified too. Fee-tail
ancestries and unbound inscriptions are refused loudly, as in custody.
`--bundle FILE` writes the genealogy artifact, which re-verifies offline with no
network. Rules are in [docs/spec/SPEC-SAT.md](docs/spec/SPEC-SAT.md).

## Packages

| package | what |
|---|---|
| `@ordspv/core` | zero-IO primitives: tx/header/block parsing, merkle and witness-commitment proofs, BIP-341 checks, ord-exact envelope parser, proof-bundle verifier, custody and sat-genealogy verifiers, gallery decoding, CBOR |
| `@ordspv/fetch` | `ordFetch()` / `OrdResolver`: URI parsing, esplora/ord backends with failover, proof building, header trust (checkpoints, M-of-N, header sync), delegation, integrity pins |
| `@ordspv/gateway` | reference HTTP gateway: ord-parity `/content` and `/r/*`, `/ord/v1/proof` bundles, verify-before-serve mode |
| `@ordspv/cli` | `ord-resolve <uri>`, `proof`, `verify`, `custody`, `sat`, `parse` |
| `@ordspv/proof-sidecar` | proof bundles straight from a Bitcoin Core node (txindex), for L2/L3 without hosting esplora |

## Quick start

```bash
npm install
npm test                                  # 337 tests, incl. real mainnet vectors, offline

# resolve + verify inscription 0 at L2 (live network):
npx tsx packages/cli/src/main.ts ord:6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0 --out skull.png --json

# emit an offline-verifiable proof bundle:
npx tsx packages/cli/src/main.ts proof 6fb976…2799i0 --level L2 > bundle.json
npx tsx packages/cli/src/main.ts verify bundle.json

# prove where the inscribed sat is now (live network):
npx tsx packages/cli/src/main.ts custody 6fb976…2799i0 --json

# prove which sat it is, and keep the artifact:
npx tsx packages/cli/src/main.ts sat 6fb976…2799i0 --bundle genealogy.json

# run a verifying gateway:
GATEWAY_MODE=verify npx tsx packages/gateway/src/index.ts
```

```ts
import { ordFetch } from '@ordspv/fetch';
const res = await ordFetch('ord:<id>/content');   // verified at L2 by default
```

## Try it

- [examples/verify-inscription-0.html](examples/verify-inscription-0.html): open
  the file. Your browser fetches inscription 0, verifies every byte against
  Bitcoin PoW client-side, and renders it. Also
  [hosted on the docs site](https://ordspv.github.io/ordspv/examples/verify-inscription-0.html).
- [examples/evm-nft/](examples/evm-nft/): the cross-chain capstone. An ERC-721
  token document whose `image` is an `ord:` URI with an integrity pin; the page
  pulls the URI out of the token metadata, resolves it, and verifies the image
  against Bitcoin PoW in your browser. Also
  [hosted on the docs site](https://ordspv.github.io/ordspv/examples/evm-nft/index.html).
- [extension/](extension/README.md): MV3 extension with gateway-URL interception,
  `ord:` links, and an in-browser verifying viewer. `chrome://extensions`, Load
  unpacked, `extension/dist-unpacked/`.

## Documents

- [Docs site](https://ordspv.github.io/ordspv/): landing page with the live
  demo and the API reference
- [API reference](https://ordspv.github.io/ordspv/api/): generated from source
  for `@ordspv/core` and `@ordspv/fetch`
- [docs/RESEARCH.md](docs/RESEARCH.md): cited synthesis of protocol facts (verified
  against ord master), verification analysis, ecosystem survey, design decisions
- [docs/spec/SPEC-URI.md](docs/spec/SPEC-URI.md): the `ord:` scheme profile
  (extends the upstream draft, doesn't fork it)
- [docs/spec/SPEC-VERIFICATION.md](docs/spec/SPEC-VERIFICATION.md): levels L0–L3,
  proof bundle format, merkle hardening, header anchoring
- [docs/spec/SPEC-CUSTODY.md](docs/spec/SPEC-CUSTODY.md): verifiable satpoint
  custody paths (bundle format, transfer arithmetic, verification rules, v1
  boundaries)
- [docs/spec/SPEC-SAT.md](docs/spec/SPEC-SAT.md): verifiable sat identity
  (numbering closed forms, backward walk, genealogy bundle format, BIP34
  cross-check)
- [docs/spec/SPEC-GATEWAY.md](docs/spec/SPEC-GATEWAY.md): HTTP surface, personalities,
  attestation, recursion tiers
- [docs/CROSS-CHAIN.md](docs/CROSS-CHAIN.md): how EVM tokens should embed `ord:` URIs
- [ROADMAP.md](ROADMAP.md): state of the work and the prioritized roadmap

## Status

Working initial implementation. The cryptographic core is complete and tested against
real mainnet data: inscription 0 verifies at L2 end-to-end offline from vendored
fixtures, and L3 is verified on consensus-shaped synthetic blocks, including forgery
rejection. Specs are v0.1 drafts. Not production software yet; see ROADMAP.md.
