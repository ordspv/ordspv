# DRAFT: do not post without explicit sign-off

Target: `Blockstream/electrs` **Pull Request** (code) + `Blockstream/esplora`
API.md addition (docs commit inside the same PR family).
Authorship: pseudonymous. Patch series: `patches/electrs-witness-merkle-proof/`
(same content as the `witness-merkle-proof` branch of the local fork).
Status: draft v1, 2026-07-11. Bench numbers measured on the branch.

---

## Title: Add `/tx/:txid/witness-merkle-proof` (+ `blockchain.transaction.get_witness_merkle`)

### What

A witness-tree twin of the existing `/tx/:txid/merkle-proof`:

```
GET /tx/:txid/witness-merkle-proof
→ {
    "block_height": 767430,
    "merkle": ["<sha256d hex>", …],   // branch, bottom-up, display order
    "pos": 42,                         // position in the block's tx list
    "witness_root": "<sha256d hex>"    // root of the BIP-141 witness tree
  }
```

and the Electrum-protocol equivalent
`blockchain.transaction.get_witness_merkle(txid, height)` mirroring
`blockchain.transaction.get_merkle`.

The proof is over the block's **witness tree**: leaf `i` is `wtxid(tx_i)`,
except leaf 0 (coinbase), which is the zero hash per BIP-141. That tree's root
is what the coinbase witness commitment (`sha256d(root ‖ reserved)` behind
`6a24aa21a9ed`) commits to.

### Why

A txid merkle proof binds a transaction's *stripped* serialization to a header.
It does **not** bind witness data: two different witnesses for the same inputs
produce the same txid. Any protocol whose payload LIVES in the witness
(ordinals inscription envelopes being the largest today) therefore can't get
SPV-grade assurance from `/tx/:txid/merkle-proof` alone: a lying server can
swap the witness and the txid proof still verifies.

The fix has always been available in consensus data (prove the tx against the
witness tree, prove the coinbase against the txid tree, check the coinbase's
witness commitment), but no public API serves witness-tree branches, so light
clients today must download the entire raw block (~1–2 MB) to verify ~1 KB of
content. This endpoint replaces that with one ~1 KB response. Esplora already
serves every other ingredient (`merkle-proof`, `/block/:hash/header`,
`/tx/:txid/hex`, coinbase txid via `/block/:hash/txid/0`).

Concretely, the consumer flow (implemented in a public verifier library that
motivated this PR, github.com/ordspv/ordspv; a full L3 verification is header PoW,
a txid proof of the coinbase, the witness commitment check, and this endpoint's
branch):

1. `GET /tx/:txid/witness-merkle-proof` → branch, pos, witness_root
2. fold `wtxid(tx)` (or the zero leaf for the coinbase) up the branch → must
   equal `witness_root`
3. `sha256d(witness_root ‖ coinbase.witness[0])` must equal the coinbase's
   `6a24aa21a9ed` commitment; coinbase bound by an ordinary txid proof at pos 0

### Implementation

- `ChainQuery::get_block_wtxids(hash)`: block txids → `lookup_txns` batch →
  per-tx `compute_wtxid()`, coinbase leaf zeroed. Same DB access pattern and
  cost as the existing `GET /block/:hash/raw` reconstruction path.
- `electrum_merkle::get_tx_witness_merkle_proof` reuses the existing
  `create_merkle_branch_and_root` fold (made `pub` for the bench).
- REST + Electrum handlers mirror their txid-proof twins; both are
  `#[cfg(not(feature = "liquid"))]` (witness commitments are bitcoin-specific
  here; elements has its own commitment structure).
- No new index rows, no migration: proofs are computed on demand from data the
  index already stores.

### Tests

- `test_rest_tx_witness_merkle_proof` (regtest, corepc-node): folds the wallet
  tx's wtxid through the returned branch to `witness_root`, folds the ZEROED
  coinbase leaf to the same root, and checks
  `sha256d(root ‖ reserved) == coinbase 6a24aa21a9ed commitment`. That is the
  full BIP-141 loop rather than shape assertions alone; plus 404 for unknown
  txids.
- `test_electrum_get_witness_merkle` (raw socket): result fields + invalid
  height → invalid-params error, mirroring `get_merkle` behavior.

### Benchmarks (criterion, `benches/benches.rs`, real mainnet block 702861, ~1 000 txs)

| step | time |
|---|---|
| wtxid computation, whole block | ~5.25 ms |
| branch construction | ~1.53 ms |

CPU cost ≈ 7 ms per uncached proof on a ~1 000-tx block (Apple M-series;
DB lookups equal the existing raw-block path). Responses are immutable and
CDN-cacheable; a per-block wtxid cache would amortize the first term across
transactions of the same block if needed.

### API.md addition (Blockstream/esplora)

```markdown
### `GET /tx/:txid/witness-merkle-proof`

Returns a merkle inclusion proof of the transaction in its block's BIP-141
witness tree (leaf 0, the coinbase, is the zero hash), as
`{ block_height, merkle[], pos, witness_root }` with hashes in display order.
Unlike `/tx/:txid/merkle-proof`, this binds the complete serialization
including witness data: fold wtxid(tx) up `merkle`, then verify
`witness_root` against the coinbase witness commitment (prove the coinbase
with an ordinary txid proof at position 0). Not available on Liquid.
```

---

## Posting notes (not part of the draft)

- The fork is github.com/ordspv/electrs, branch `witness-merkle-proof`
  (GOING-PUBLIC step 3); `patches/electrs-witness-merkle-proof/*.patch` is
  the format-patch backup. Arrive with code.
- Platform caveat to mention if CI asks: the electrumd wallet test-harness
  dev-dependency doesn't build on macos-arm64 (pre-existing, unrelated);
  everything else validated locally on macOS + expected green on Linux CI.
- The upstream ord discussion draft (ord-uri-extensions-draft.md) links here as
  the "cheap L3 everywhere" companion; post this one FIRST.
