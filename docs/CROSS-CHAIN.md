# Pointing cross-chain tokens at Bitcoin inscriptions with `ord:`

*The consumer-side guide. Normative language lives in the specs; this is how you use
them from EVM/Solana/etc.*

## The pattern

Today a token that "is" an inscription stores `https://ordinals.com/content/<id>` (or a
marketplace URL) and inherits a single operator's uptime, rate limits, and honesty.
See the failure catalog in [RESEARCH.md §1](./RESEARCH.md). The fix is the same one
NFTs already use for IPFS/Arweave: store a **scheme URI**, let resolvers/gateways pick
transport.

```jsonc
// ERC-721 metadata JSON
{
  "name": "…",
  // delegation-following form + integrity pin (both recommended):
  "image": "ord:6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0/content#integrity=sha256-<hex>"
}
```

Recommendations (rationale in SPEC-URI):

1. **Use `/content`** in `image`/`animation_url`: delegation is the dominant pattern
   for collections (one fat inscription, thousands of cheap delegating mints), and
   `/content` is what renders.
2. **Always pin `#integrity=`** with the sha256 of the stored body bytes (the resolver
   reports it as `verification.bodySha256`; the gateway echoes it as
   `x-ord-body-sha256`). The pin rides inside immutable contract storage, so any
   consumer, even one that only trusts a random HTTPS gateway, gets cryptographic
   content integrity (L1) for free. Verified resolvers upgrade it further.
3. **Tolerate both scheme spellings** when parsing (`ord:` canonical, `ord://` alias).
4. For fully on-chain metadata patterns (`data:application/json;base64,…` tokenURIs),
   the `ord:` URI + pin embeds cleanly since it is just a string.

## Rendering paths, by consumer sophistication

| consumer | path | trust achieved |
|---|---|---|
| legacy platform, zero changes | rewrite `ord:<id>/content` → `https://<gw>/content/<id>` (regex in SPEC-URI §7) | L0 |
| platform with one HTTP call spare | fetch from any gateway, hash bytes, compare to the pin | **L1, no Bitcoin infra at all** |
| wallet/marketplace with a resolver | `@ordspv/fetch`: `ordFetch(uri)` (defaults: L2, mempool.space + blockstream.info, checkpointed headers) | L2, assurances surfaced |
| bridges, custody, disputes | `verification: 'L3'` via a proof gateway or raw-block fetch | full witness commitment |

```ts
import { ordFetch } from '@ordspv/fetch';

const res = await ordFetch(tokenMetadata.image);          // Response
res.headers.get('x-ord-verification');                    // "L2"
res.headers.get('x-ord-body-sha256');                     // pin material
```

## Solidity-side notes

- Store the URI string; nothing else changes for ERC-721/1155. The inscription ID is
  already inside the URI, so indexers can extract `<txid>i<n>` without new fields.
- If the collection wants machine-readable linkage beyond the URI (e.g. for on-chain
  games), store `bytes32 revealTxid` + `uint32 index` + `bytes32 bodySha256`, the
  three values every verification level bottoms out in. (This intentionally does *not*
  revive ERC-2477's parallel-field design; the URI remains the source of truth.)
- Teleburn-style provenance (ETH token → inscription and back) is orthogonal: this
  scheme fixes *content resolution*; teleburn addresses *ownership migration*.

## What breaks without this (motivating checklist)

- ordinals.com throttles or blackholes your hotlinking domain (it has) → images die.
- Any single gateway can serve different bytes per requester. Undetectable at L0;
  detectable at L1; impossible below the inscriber at L2-singleLeaf; impossible at L3.
- Marketplace URL rot: `ord:` URIs are transport-independent and survive any provider.

## Adoption sequencing (the ar:// lesson)

Platform acceptance followed a working resolver SDK + wallet integration + provisional
IANA registration. The equivalents here: `@ordspv/fetch` (exists), a wallet/
extension integration (roadmap in HANDOFF.md), and an `ord:` registration coordinated
with upstream (SPEC-URI §7). A CAIP-19 profile for inscriptions is the parallel lane
for chain-agnostic wallet stacks.
