# Research synthesis — trustless resolution of ordinals inscription content

*Compiled 2026-07-11 from three parallel research passes (ord protocol internals verified
against `ordinals/ord` master @ `7effaaaf`; prior art and ecosystem; SPV verification
mechanics) plus empirical verification in this repository's test suite against mainnet
data. Citations inline. Everything protocol-critical here is re-verified in code under
`packages/core/test/`.*

## 1. The problem, concretely

Inscription content lives in the **witness** of a taproot reveal transaction. The only
way anyone serves it today is through an ord-family server (an `ord` instance with a
fully synced index over a `txindex=1` Bitcoin Core node). Cross-chain consumers — an
Ethereum NFT whose `tokenURI`/`image` should be "that inscription" — therefore point at
hosted HTTPS endpoints, and the trust and availability failures are already on record:

- **BRC-721E** (Ordinals Market + Bitcoin Miladys, May 2023): the burn-to-Bitcoin bridge
  standard stores bridged NFT metadata *off-chain on the marketplace's collection page* —
  the bitcoin-side inscription is a ~100-byte JSON pointer, and rendering depends on one
  company's server ([Samara AG](https://www.samara-ag.com/market-insights/what-is-brc721e),
  [CoinDesk](https://www.coindesk.com/web3/2023/05/30/brc-721e-token-standard-bridges-ethereum-nfts-to-bitcoin-ordinals)).
- **Emblem Vault** ordinals trade on OpenSea as wrapped ERC-721s whose previews/metadata
  come from Emblem's hosted API; even its own verification guide bottoms out at
  "check `ordinals.com/inscription/<id>`" ([guide](https://emblem-vault.medium.com/how-to-verify-ordinals-inside-of-an-emblem-vault-5d429b10d184)).
- **ordinals.com is a best-effort community instance.** In
  [ordinals/ord#3873](https://github.com/ordinals/ord/issues/3873) (July 2024) the site
  went down under load; the maintainer found a service hotlinking inscription content and
  **blackholed it**. Third parties building rendering pipelines on ordinals.com are one
  traffic spike — or one operator decision — away from broken images. Performance issues
  tracked in [#2613](https://github.com/ordinals/ord/issues/2613).

Meanwhile `ipfs://` demonstrates the alternative: a scheme + content addressing + a
[trustless gateway spec](https://specs.ipfs.tech/http-gateways/trustless-gateway/) +
[verified-fetch](https://blog.ipfs.tech/verified-fetch/) client, with `ipfs://` and
`ar://` accepted in `tokenURI` by
[OpenSea's metadata standards](https://docs.opensea.io/docs/metadata-standards) and
resolved by major wallets.

**The core insight this project builds on:** an inscription ID (`<txid>i<index>`) is not
a content hash — the txid does *not* commit to witness bytes — but inscription content
IS committed by Bitcoin proof-of-work through two independent paths (§3). So `ord:` URIs
can be resolved with *IPFS-grade or better* trust properties using only generic,
abundant Bitcoin infrastructure (esplora/electrum/Core), with ord servers reduced to an
optional availability layer.

## 2. Protocol facts an implementer must get right (verified against ord master)

Everything in this section was verified against `ordinals/ord` @ `7effaaaf` (2026-06-25,
latest release 0.27.1) and is mirrored by `packages/core/src/envelope.ts` and its tests.

**Envelope extraction.** Envelopes are parsed from the taproot leaf script
(`witness.tapscript()`: last element = annex if it starts `0x50`, else control block;
second-to-last = script). ord does **not** check that the spent prevout is P2TR
([envelope.rs](https://github.com/ordinals/ord/blob/master/src/inscriptions/envelope.rs)).
Grammar: *empty push* (any encoding), `OP_IF`, push of exactly `ord`, then payload
pushes until `OP_ENDIF`. `OP_PUSHNUM_NEG1/1..16` are legal payload (decoded to `[0x81]`,
`[1]..[16]`, flagging `pushnum`); **any other opcode discards the whole envelope**, as
does a missing `OP_ENDIF`.

**Fields.** Payload items pair up `(tag, value)` until the first **even-indexed** empty
push (an empty push in value position is an empty value, not the body separator); the
body is the concatenation of everything after the separator. Odd payload count ⇒
`incomplete_field`. Tag table
([tag.rs](https://github.com/ordinals/ord/blob/master/src/inscriptions/tag.rs),
[docs](https://docs.ordinals.com/inscriptions.html)):

| tag | field | take semantics |
|---|---|---|
| 1 | content_type | first value |
| 2 | pointer | first value; LE u64, zero-padding tolerated, ≥2^64 invalid |
| 3 | parent | **all values** (repeatable) |
| 5 | metadata | **all values concatenated** (chunked CBOR) |
| 7 | metaprotocol | first |
| 9 | content_encoding | first |
| 11 | delegate | first |
| 13 | rune | first |
| 15 | note | reserved no-op |
| 17 | properties | chunked CBOR (added 0.24.0, 2025-11 — *not* 15) |
| 19 | property_encoding | first (`br` only, 4 MB cap, 30:1 ratio cap since 0.26.0) |
| 66 | unbound | never taken ⇒ always unbinds |
| 255 | nop | no-op |

`duplicate_field` is computed **before** take: *any* repeated tag sets it, including
chunked metadata (ord test `metadata_is_parsed_correctly_from_chunks`). After taking,
any leftover field whose key's first byte is **even** sets `unrecognized_even_field` ⇒
the inscription is **unbound** (so a duplicated pointer unbinds; a duplicated
content-type merely curses). Parent/delegate values are 32-byte txid (internal order) +
LE index with trailing zeros stripped; non-canonical encodings are rejected.

**IDs.** `<64-hex txid>i<decimal u32>`; the index counts **every** envelope — cursed or
unbound included — flat across inputs in order
([inscription_updater.rs](https://github.com/ordinals/ord/blob/master/src/index/updater/inscription_updater.rs)).
Content lookup by ID is a pure function of the reveal tx: ord itself re-parses the tx
and takes the nth envelope ([index.rs](https://github.com/ordinals/ord/blob/master/src/index.rs)).
Reinscription/sat history never changes ID-based content. **Unbound and cursed
inscriptions still get IDs and still serve at `/content/<id>`.** Since the Jubilee
(block 824544) all curses are vindicated (positive numbers), but unbound remains live
(`input_value == 0 || unrecognized_even_field`).

**Delegation.** One hop, never chained: `/content/A` with A→B serves B's **body,
content-type, and content-encoding**; B's own delegate field is ignored; missing
delegate ⇒ 404 ([delegate docs](https://docs.ordinals.com/inscriptions/delegate.html),
`content_inner` in server/r.rs). `/r/undelegated-content/<id>` bypasses delegation.

**Content-encoding.** Serving: if the request's `Accept-Encoding` names the
inscription's encoding, raw stored bytes go out with `Content-Encoding`; else, with
`--decompress` and `br`, the server inflates; else **406**. ord only produces brotli at
inscribe time, but any string can appear on-chain.

**Server surface** (for gateway parity): `/content/<id>` sends
`Cache-Control: public, max-age=1209600, immutable`, content-type falling back to
`application/octet-stream`, **two** CSP headers
(`default-src 'self' 'unsafe-eval' 'unsafe-inline' data: blob:` and a
gateway-portability variant `default-src *:*/content/ ... 'unsafe-eval' ...`), HSTS,
CORS `*`, and no `X-Content-Type-Options`. Recursive endpoints
(`/r/blockhash|blockheight|blocktime|blockinfo|children|parents|inscription|metadata|sat|tx|utxo|undelegated-content`)
carry a backwards-compatibility guarantee. `/r/metadata` returns hex-encoded CBOR as a
JSON string; `/r/tx/<txid>` returns hex — an ord server can hand a verifier its own
proof ingredients.

**What needs the full ord index vs raw chain data:** content-by-ID, delegation, and
envelope fields need **only** txid→tx lookup. Inscription *numbers*, sat mappings,
children (reverse edges), parent *validation*, and charms need the index. This boundary
is exactly where trustless resolution is cheap vs expensive, and drives the spec's
addressing decision (IDs canonical; numbers out of scope).

**Running ord in 2026:** requires Bitcoin Core with `txindex=1` (~700+ GB); base ord
index ~61 GB at ~block 880k, `--index-sats` ~1 TB reported
([#4234](https://github.com/ordinals/ord/issues/4234)); community torrent snapshots at
ordstuff.info. Days of sync on NVMe. This cost is why hosted instances are scarce — and
why a resolver that *doesn't* need an ord index matters.

## 3. Verification analysis: binding content to proof-of-work

**The gap.** txid = SHA256d of the *stripped* serialization
([BIP-141](https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki)); witness
bytes — where the envelope lives — are only committed by **wtxid**, and the header's
merkle root commits txids, not wtxids. A server can hand you a reveal tx whose witness
was swapped: the txid (and any txid merkle proof) still checks out. Our test suite
constructs exactly this forgery (`proofbundle.test.ts`, "detects forged witness
content"). No prior writeup of this gateway-forgery framing was found; treat the
analysis as this project's own, pressure-tested in code.

**Two independent commitments close the gap:**

**Path A — BIP-141 witness commitment (level L3).** Every block containing any segwit
transaction (⇒ every block containing an inscription) MUST carry, in a coinbase output
matching `6a24aa21a9ed…`, `SHA256d(witness_merkle_root ‖ witness_reserved_value)` where
the witness tree is the txid-tree construction over wtxids with the coinbase leaf
zeroed, and the reserved value is the coinbase witness's single 32-byte item; if
multiple outputs match, the highest index wins (BIP-141; Core
[merkle.cpp](https://github.com/bitcoin/bitcoin/blob/master/src/consensus/merkle.cpp)).
Proof chain: header PoW → txid-merkle proof of coinbase (position 0, all-left folds) →
commitment → wtxid-merkle proof of reveal → `SHA256d(full tx) = wtxid` and
`SHA256d(stripped tx) = txid = ID's txid` from the *same* buffer → envelope → content.
This is exactly the construction Citrea runs in production inside its zk light client
([docs](https://docs.citrea.xyz/advanced/data-availability)).

**Path B — BIP-341 tapscript commitment (level L2).** The reveal's *stripped* data
commits to its input outpoints; fetch the commit tx (self-authenticating: hash it),
read the spent P2TR output `OP_1 <32-byte Q>`, and verify the witness's control block:
`k₀ = H_TapLeaf(v ‖ compact_size(s) ‖ s)`, fold `H_TapBranch(min‖max)` up the path,
`t = H_TapTweak(p ‖ k_m)` (reject `t ≥ n`), `Q =? lift_x(p) + t·G` with the parity bit
(BIP-341/340 tagged hashes, exact strings `TapLeaf`/`TapBranch`/`TapTweak`). Every
ingredient is served by any esplora/electrum instance.

**L2's precisely-characterized residual gap** (novel analysis, demonstrated in
`proofbundle.test.ts` "documents the L2 gap"): the control block proves *membership* of
the shown script in the committed taptree — not that it was the *executed* leaf. An
inscriber can commit a two-leaf tree (envelopes A and B), reveal A on-chain (ord indexes
A), and later serve B with a valid proof for the same inscription ID. Mitigations:
depth-0 control blocks (33 bytes) make the tree provably single-leaf — the common case
for standard inscribers, surfaced as `singleLeafTree` — and single-input reveals pin the
envelope index (input count is txid-committed). Only the block's witness commitment
(L3) fully closes it. Corollary: **the attack requires the inscriber's cooperation at
inscribe time**; a third-party gateway cannot forge content for an honestly-inscribed
ID at L2, because it cannot produce a control block for a leaf that isn't in the tree.

**Merkle hardening carried into the implementation:**
[CVE-2012-2459](https://bitcoinops.org/en/topics/merkle-tree-vulnerabilities/)
(duplicate-node mutation) — reject identical final siblings when building; enforce
tree-shape consistency (`txCount`, exact branch depth, self-pair rule at odd edges) when
verifying. CVE-2017-12842 (64-byte tx / inner-node confusion) — proof bundles carry a
mandatory `txCount`, branch depths must equal the tree height, and 64-byte transactions
are rejected outright ([BIP-54](https://github.com/bitcoin/bips/blob/master/bip-0054.md)
proposes a consensus ban).

**Header trust.** A bundle's header proves its own PoW; anchoring it to *the* chain
needs either compiled-in checkpoints (most inscriptions are historic), M-of-N agreement
across independent esplora/electrum operators, or (roadmap) real header sync — ~957,585
headers ≈ 76.6 MB as of 2026-07-11, retarget validation is trivial BigInt math
([pow.cpp](https://github.com/bitcoin/bitcoin/blob/master/src/pow.cpp)). Electrum's
`cp_height` checkpoint proofs are useful precedent. zk header proofs
(ZeroSync — PoC, no releases) aren't consumable yet; Citrea is purpose-built.

**Who serves what (July 2026):**

| ingredient | esplora (mempool.space / blockstream.info) | electrum | Core RPC | ord server |
|---|---|---|---|---|
| raw tx + witness | `/tx/:txid/hex` | `transaction.get` | `getrawtransaction` | `/r/tx/:txid` |
| txid merkle proof | `/tx/:txid/merkle-proof` (Electrum format; hashes display-order — verified empirically) | `transaction.get_merkle` | `gettxoutproof` | — |
| header / hash-by-height | `/block/:hash/header`, `/block-height/:h` | `block.header(s)` | `getblockheader` | `/r/blockinfo` (JSON only) |
| **wtxid branch** | **nobody serves one** — fetch `/block/:hash/raw` (~1.6 MB avg) and build it | — | `getblock 2` (wtxids) | — |
| content by ID | — | — | — | `/content`, `/r/undelegated-content` |

That wtxid-proof hole is why this project's gateway spec adds `/ord/v1/proof?level=l3`:
one ~1.3 KB bundle instead of a megabyte block download.

**Cost table** (typical 2026 block: ~1.6 MB, 1.6k–7k txs, branch depth 11–13):

| level | wire cost | trust residue |
|---|---|---|
| L0 (gateway) | content only | full trust in gateway |
| L1 (integrity pin) | content only | none for content bytes, if the pin itself is trusted (e.g. stored in an EVM contract); no chain context |
| L2 | content + ~0.9 KB | inscriber-level multi-leaf gap unless `singleLeafTree`; header anchoring |
| L3 | content + ~1.3 KB (from a proof gateway) or + full block (from esplora) | header anchoring only |

## 4. Prior art and the naming decision

- **ord itself specifies `ord:` — no slashes.**
  [docs.ordinals.com/inscriptions/uris.html](https://docs.ordinals.com/inscriptions/uris.html)
  (draft, not IANA-registered): `ord:<txid>i<index>`, case-insensitive by regex,
  lowercase preferred, *no hierarchical part* (enables QR alphanumeric mode), and —
  critically — **the referent is the original (undelegated) content**, i.e.
  `/r/undelegated-content`. The string `ord://` appears nowhere in the repo.
- **Community demand is for `ord://`**:
  [ordinals/ord discussion #3780](https://github.com/ordinals/ord/discussions/3780)
  proposes `ord://` gateways; maintainer raphjaph called it "reasonable"; casey's
  guidance there: map scheme paths onto the **recursive** endpoints.
- `did:btco` ([DIF Labs spec](https://identity.foundation/labs-ordinals-plus/btco-did-method/))
  addresses *sats*, walks inscription history for DID documents — identity, not content;
  precedent for CBOR-metadata payloads.
- No CAIP-19 asset namespace exists for inscriptions
  ([bip122 namespace](https://namespaces.chainagnostic.org/bip122/README) has none) —
  an open standardization lane.
- Scheme playbook that worked: **ar://** = provisional IANA registration + one good SDK
  ([Wayfinder](https://docs.ar.io/build/access/wayfinder/)) + wallet integration ⇒
  OpenSea acceptance. Scheme playbook that stalled: **web3://**
  (ERC-4804 final, [ERC-6860](https://eips.ethereum.org/EIPS/eip-6860) draft) — heavy
  translation semantics, niche use. `ord:` resolution is static content addressing,
  shaped like the winner. [ERC-2477](https://eips.ethereum.org/EIPS/eip-2477)
  (tokenURIIntegrity) is stagnant — integrity must ride *inside* the URI, not in a
  parallel contract field nobody implements; hence the `#integrity=` fragment.
- IPFS specifics worth copying: trustless-gateway's explicit dual signaling
  (Accept + `?format=`), immutable cache semantics, subdomain-gateway origin isolation
  for active HTML content, verified-fetch's `fetch()`-shaped API.
- **ordpool-parser** ([ordpool-space/ordpool-parser](https://github.com/ordpool-space/ordpool-parser),
  TypeScript, powers ordpool.space) is the closest envelope-parsing prior art: it
  decodes inscriptions (plus runes/atomicals/src-20) straight from transaction hex in
  the browser, and its published test vectors for exotic shapes (multi-input reveals,
  >520-byte chunked metadata, brotli/gzip content-encoding) seeded this repo's
  extended fixture corpus — see `scripts/parity-sweep.ts`. The differentiation is
  scope: ordpool-parser answers *"what does this transaction say?"* (display-grade
  parsing of bytes you already trust), while this repo answers *"prove these bytes
  are the inscription"* — consensus-serialization txid/wtxid recomputation, BIP-341
  commitment checks, merkle inclusion against a PoW-checked header (L2/L3 proof
  bundles), and byte-level ord-corpus parity locks on the parser itself. Parsing is
  the shared substrate; PoW-bound verification is the layer ordpool-parser doesn't
  attempt and this repo exists to provide.

**Decision:** canonical scheme = upstream's `ord:<id>` with upstream's undelegated
referent (don't fork the ecosystem over slashes); accept `ord://` as a compatibility
alias (marketplace URL-detectors expect authority form); add `/content` and `/metadata`
paths and the `#integrity=sha256-…` fragment as documented extensions; recommend
`ord:<id>/content` for EVM `image`/`animation_url` fields since delegation is the
dominant cost-saving pattern for collections.

## 5. What this repository already proves

- The full L2 chain verifies **real mainnet inscription 0** end-to-end offline: header
  767430 (PoW, hash `…983a04f5`), esplora merkle proof (2332-tx tree, pos 2322),
  commit-tx binding, BIP-341 control-block check, envelope → 793-byte PNG
  (`inscription0.test.ts`).
- The L3 construction round-trips on synthetic consensus-shaped blocks, and **catches a
  witness-swap forgery that L2 provably accepts** (`proofbundle.test.ts`).
- Esplora's merkle-proof hashes are display-order (empirically settled).
- ord's exact envelope edge semantics (pushnum, chunked metadata + duplicate flag,
  even-index body separator, canonical ID values, unbound rules) are mirrored and unit
  tested (`envelope.test.ts`).
- A resolver with backend failover, checkpointed header trust, delegate following
  (dual verification), integrity pins, and content-encoding handling passes 67 tests.

## 6. Open questions / roadmap seeds

1. **wtxid-proof availability**: L3 without a proof gateway costs a block download.
   Upstreaming a `/tx/:txid/witness-merkle-proof` endpoint to esplora/electrs (or a
   `blockchain.transaction.get_witness_merkle` Electrum method) would make L3 as cheap
   as L2 everywhere. Until then, `/ord/v1/proof` gateways fill the hole.
2. **Header sync in the resolver** (P2P or Electrum `cp_height`) to drop the M-of-N
   esplora honesty assumption; ~77 MB one-time, checkpointable.
3. **IANA provisional registration** of `ord:` (ar:// precedent shows it matters for
   platform acceptance) — coordinate with upstream, whose draft explicitly contemplates
   registration.
4. **CAIP-19 profile** for inscriptions under bip122 so chain-agnostic wallet stacks
   have a canonical asset form.
5. **Recursive HTML inscriptions**: full fidelity needs `/r/*` context; only
   chain-derivable endpoints (blockhash/height/time/tx) can be served trustlessly
   without an ord index. Tiering is specified in SPEC-GATEWAY.md §6.
6. **Number addressing** (`ord:12345`?) rejected: numbers require a trusted global
   index; IDs are the verifiable primitive.
7. Percolate `properties` (tag 17) galleries once 0.27-era usage stabilizes.

## Known uncertainties

Current ord index sizes are early-2025 figures; ordinals.com's `--decompress` posture is
unknown (gateway spec handles both); the Electrum-format merkle hash byte order was
settled empirically here but isn't documented upstream; the Jubilee-block checkpoint
hash was cross-checked against two public APIs but (unlike heights 0 and 767430) is not
cryptographically re-verified inside this repo's tests; ordinals.com's `/r/blockheight`
lagged other sources by ~13k blocks during research (944811 vs 957585) — worth watching
as a reminder that single-instance reads are untrustworthy even for liveness.
