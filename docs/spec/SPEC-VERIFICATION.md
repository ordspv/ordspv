# ORD-VERIFY-1: verification levels and proof bundles

Status: draft v0.1 · 2026-07-11
Companion: [SPEC-URI.md](./SPEC-URI.md), [SPEC-GATEWAY.md](./SPEC-GATEWAY.md)
Reference implementation: `@ordspv/core` (`proof.ts`, tested against mainnet data)

## 1. Threat model

The resolver talks to servers it does not trust: ord gateways may lie about content;
esplora/electrum instances may lie about transactions, proofs, and headers; any of them
may be unavailable. The attacker may also be the *inscriber* (relevant to L2). The only
trust anchors available are: Bitcoin proof-of-work (given a way to recognize the
canonical chain), and, for L1, a digest the consumer already holds through some other
trusted channel (e.g. immutable EVM contract storage).

Central protocol fact: **an inscription ID's txid does not commit to the content.**
Content lives in the witness; txid hashes the stripped serialization (BIP-141). Any
scheme that stops at "txid matched" is forgeable by any gateway. The levels below are
defined by which commitment finally binds the bytes.

## 2. Levels

### L0: trusted gateway
Bytes accepted as served. No integrity property. Availability-only fallback; resolvers
MUST label results so consumers can't mistake L0 for verified content.

### L1: integrity pin
The URI carries `#integrity=sha256-…` (SPEC-URI §4) and the resolver checks it against
the stored body bytes. Content integrity holds even against a malicious gateway,
**provided the pin itself is trusted**. Its natural home is immutable contract storage
on the consuming chain. No chain context (existence, confirmation depth, timestamp) is
established. Cost: hashing only.

### L2: tapscript commitment
Binds content to the Bitcoin chain using only txid-tree artifacts (available from any
esplora/electrum/Core node). Verifier obtains: reveal tx (full, with witness), a txid
merkle proof for it, the block header, the block's `txCount`, and the commit
transaction for the envelope's input. Checks (all MUST):

1. `sha256d(stripped(reveal)) = id.txid`; reject 64-byte transactions.
2. Txid merkle branch folds from `id.txid` at position `pos` to the header's merkle
   root; branch depth = `⌈log₂⌉`-height of `txCount`; position < `txCount`; odd-edge
   self-pair rules enforced (CVE-2012-2459 / CVE-2017-12842 hardening, §5).
3. Header hashes to the claimed block hash and satisfies its own `nBits` target;
   header anchored per §4.
4. Parse envelopes from the reveal witness (ord semantics); envelope at `id.index`
   exists. Its input `j` is the relevant input.
5. `sha256d(stripped(commit)) = reveal.input[j].prevTxid` (commit tx is
   self-authenticating against txid-committed data).
6. BIP-341: commit output `vout` is `OP_1 <32-byte Q>`; with the witness's script `s`
   and control block `c`: leaf/branch/tweak tagged-hash fold and
   `Q = lift_x(p) + t·G` with matching parity. Reject `t ≥ n`.

**What L2 proves:** the served envelope bytes were committed inside the taptree of the
output that the on-chain reveal at `id.txid` actually spent.

**What L2 does not prove:** that the shown leaf was the leaf *executed* on-chain, and,
on a multi-input reveal, which envelope the id's index names. An inscriber can
pre-commit two envelope leaves and serve either (demonstrated in
`proofbundle.test.ts`). A gateway needs no inscriber cooperation for the second gap:
L2 binds the envelope input's witness alone, so rewriting another input's witness
renumbers the envelopes while every L2 check still passes. Verifiers MUST surface the
assurances:

- `controlBlockDepth = 0` ⇒ `singleLeafTree`: the taptree provably committed only the
  observed tapscript. It does not prove that leaf was executed. A single-leaf P2TR
  output is spendable by key path as well as by script path, and the txid commits to
  neither the witness nor the spend path chosen, so the author of the commit output
  can spend it by key path, which reveals no inscription at all, and serve a
  script-path witness that binds at depth 0 afterwards;
- `singleInputReveal`: input count is txid-committed, so no other input can contribute
  an envelope, which pins envelope indexing given the shown script.

Consumers SHOULD treat L2 as final only when the inscriber is outside the threat
model, and SHOULD escalate to L3 whenever the inscriber is inside it, whatever
`singleLeafTree` and `singleInputReveal` say, since both are statements about what
was committed rather than about what was executed. Consumers SHOULD also escalate to
L3 when the reveal has more than one input or the control block has depth > 0. L3 is
what proves the presented witness is the witness the chain saw, because the BIP-141
commitment covers the exact serialization, which closes the numbering gap too.

`VerifiedInscription.allInscriptions` lists envelopes parsed from every input, and L2
binds no input other than the envelope's. A consumer MUST NOT treat that list or its
length as proven at L2 unless `singleInputReveal` is true. At L3 the list is proven.

### L3: witness commitment
Adds the BIP-141 coinbase witness commitment; equivalent to full-node treatment of the
reveal witness. Additional ingredients: coinbase tx (full, with witness), its txid
merkle branch at position 0, and a wtxid-tree branch for the reveal. Checks (beyond
L2's 1–4; the commit-tx/BIP-341 steps become OPTIONAL):

7. Coinbase parses, is a coinbase, and merkle-proves at position 0 (every fold
   left-anchored) with correct depth.
8. Witness commitment output = last output whose scriptPubKey starts `6a24aa21a9ed`;
   reserved value = coinbase witness's single 32-byte item.
9. `sha256d(full(reveal)) = wtxid`; wtxid branch (with the coinbase leaf as 32 zero
   bytes; if `pos = 1` the first sibling MUST be exactly zero) folds to a root with
   `sha256d(root ‖ reserved) =` the committed 32 bytes. Reveal position MUST NOT be 0.
10. Envelope at `id.index` from this now-committed witness is the content.

**What L3 proves:** these exact witness bytes are the ones in the canonical block,
the ones ord indexed. The multi-leaf gap is closed; a forged witness with the same txid is
rejected (test: "detects forged witness content").

## 3. Proof bundle format v1

Media type `application/vnd.ord.proof+json; version=1`. All 32-byte hashes in
display order (reversed) hex, matching every public API; transactions as hex.

```jsonc
{
  "version": 1,
  "inscriptionId": "<txid>i<n>",
  "level": "L2" | "L3",
  "block": {
    "height": 767430,
    "hash": "000000000000000000029730…04f5",
    "header": "<160 hex chars>",
    "txCount": 2332                    // REQUIRED (depth hardening)
  },
  "reveal": {
    "hex": "<raw tx with witness>",
    "pos": 2322,                       // index in block tx list
    "txidBranch": ["<hash>", …]        // bottom-up
  },
  "commit":  { "hex": "…" },           // REQUIRED for L2
  "witness": {                          // REQUIRED for L3
    "coinbaseHex": "…",
    "coinbaseTxidBranch": ["…", …],
    "wtxidBranch": ["…", …]
  }
}
```

The `witness` section's shape is shared beyond this format: custody and genealogy
bundles (SPEC-CUSTODY, SPEC-SAT) accept the same section at their reveal hop, where
it proves envelope indexing on multi-input reveals.

Bundles are self-contained and offline-verifiable (`ord-resolve verify bundle.json`);
they are also immutable and infinitely cacheable. A CBOR twin
(`application/vnd.ord.proof+cbor`) is reserved for v2. JSON came first for
debuggability.

Acquisition without a proof gateway: L2 = 5 small esplora reads; L3 = tx status + one
raw block (~1.6 MB typical), branches built locally (`buildProofBundle` does both).

## 4. Header anchoring

`verifyProofBundle` establishes internal consistency and embedded PoW; it cannot know
the header is on the canonical most-work chain.

A header's embedded target is worth nothing on its own, because the bundle chooses
the target too: a header declaring `nBits` `0x207fffff` satisfies its own PoW check
in milliseconds. Verifiers MUST therefore hold every header in a bundle to the
network's proof-of-work limit: `bitsToTarget(header.bits)` MUST be at or below
`bitsToTarget(powLimitBits)`, checked before the header's own PoW check counts for
anything. The check is local and needs no network. The reference implementation
applies it by default in all three verifiers (`verifyProofBundle`,
`verifyCustodyBundle`, `verifySatGenealogy`) and in `makeHeaderTrust`, with the
mainnet limit `0x1d00ffff`; the `powLimitBits` option overrides it for another
chain, and `null` disables it. A header failing it is fabricated or belongs to
another chain.

The floor is difficulty 1, so its own bar is low: it refuses headers easier than
`0x1d00ffff`, and fabricating a header AT that difficulty costs about 2^32 hashes,
which dedicated hardware does in well under a second. A header at recent mainnet
difficulty costs about 2^78 hashes, and nothing requires a bundle's header to meet
it, since the bundle picks its own height and its own `nBits`. What the floor buys
is the removal of the free case. Verifiers MUST still anchor the hash against their
own view of the chain, because that is what defends against a fabricated header,
and the floor says nothing about which chain a header sits on. Composable
strategies (reference: `makeHeaderTrust`):

- **Checkpoints** (MUST when applicable): compiled-in `height → hash` pairs; a bundle
  contradicting a checkpoint is rejected outright. Ships with genesis, 767430
  (verified cryptographically in-repo), 824544 (Jubilee).
- **M-of-N independent sources** (SHOULD, default 2): hash-at-height agreement across
  operator-diverse esplora/electrum endpoints; optional min-confirmations gate. Any
  endpoint that served bytes for the bundle MUST be excluded from the vote and MUST NOT
  be counted toward the threshold, so the default means two agreeing outsiders. Because
  attesting needs only `/block-height/<n>`, the attesting list is configured separately
  from the proof backends (`DEFAULT_ANCHOR_SOURCES`, `--anchor-source`), and an endpoint
  named in both lists is filtered out of the vote for the bundles it served.
  Endpoints are compared in a canonical form (scheme and host lowercased, a
  single trailing dot on the host dropped, a default port dropped, trailing
  slashes stripped), so a spelling variant of a serving endpoint cannot pass as
  an outside attester, and one endpoint listed twice counts once. Implementations MUST NOT infer more than that: two
  hostnames operated by one party remain two entries, so callers are
  responsible for the operator diversity this bullet asks for.
- **Header sync** (implemented: `@ordspv/fetch/headersync`, node-only subpath):
  a locally validated header chain. Electrum `blockchain.block.headers` batches are
  validated per header (linkage, PoW, exact pow.cpp retarget arithmetic,
  median-time-past, compiled checkpoint crossings), persisted to disk with a fully
  revalidating load, and exposed as a drop-in `trustHeader` anchor
  (`headerSyncTrust`). Chains start from a
  retarget-ALIGNED trusted base; the default base 766080 (period start below
  inscription 0) covers every inscription in ~15 MB, or use genesis for the full
  ~77 MB chain. Optional Electrum `cp_height` root/branch verification is supported
  once roots are pinned (derivable from any fully synced chain via
  `blockHashMerkleRoot`). Browser story: the validation core (`HeaderChain`) is
  IO-free, but raw TCP/TLS sockets and file persistence do not exist in browsers.
  Either keep checkpoint + M-of-N anchoring there, or supply a WebSocket→Electrum
  bridge as a custom `ElectrumTransport` with an in-memory chain; the built-in
  transport/persistence stay node-only and the subpath is excluded from the browser
  bundle.

## 5. Merkle hardening (normative)

- `txCount` is REQUIRED in bundles; branch length MUST equal the tree height for
  `txCount`; positions MUST be `< txCount`.
- At each level, if the node is the last of an odd-width level it MUST equal its
  sibling (self-pair); otherwise an identical sibling at the tree edge MUST be
  rejected (mutation shape, CVE-2012-2459).
- 64-byte transactions MUST be rejected wherever a tx is parsed from a bundle
  (leaf/inner-node confusion, CVE-2017-12842; cf. BIP-54).
- Coinbase proofs MUST be verified at position 0 (all folds left-anchored).

## 6. Delegation and recursion

- `/content`-form resolution with a delegate MUST verify **both** inscriptions at the
  same level (the delegating envelope proves the delegate *pointer*; the delegate's own
  proof binds the *bytes*). One hop only; the delegate's own delegate field is ignored
  (ord parity). Reference: `OrdResolver.resolveVerified`.
- Metadata (`/metadata`) verifies identically to content. It is envelope data.
- Recursive HTML content executing against `/r/*` endpoints is beyond byte-level
  verification (rendering depends on runtime context); SPEC-GATEWAY §6 tiers which
  recursion endpoints can themselves be served trustlessly.

## 7. Galleries (properties tag 17)

An inscription whose properties CBOR carries an Items array is a gallery, and
its member list is envelope data. That places it inside the byte-level model
rather than beside it: an L2 or L3 proof over the gallery inscription settles
membership and completeness together, because the list is part of the bytes the
proof already binds. Children provenance is the opposite case, since a parent's
envelope says nothing about who later claimed it, and enumeration needs an
index.

Two encodings are interchangeable and implementations MUST accept both:

- inline, where each Item carries its serialized inscription id (32 to 36
  bytes: txid followed by a trailing-zero-trimmed little-endian index) under
  Item key 0;
- packed, where properties key 2 holds the concatenated 32-byte txids and each
  Item carries only its index under Item key 2 (absent means 0). The Item at
  array position `i` takes txid slice `i`.

Decoding is lenient, matching ord's treatment of malformed envelope data: an
entry that does not decode is skipped rather than invalidating the list, and
properties with no Items yield a non-gallery result. Implementations SHOULD
report how many entries were skipped, so a caller claiming a *complete* member
list can tell whether it has one.

Properties may declare a `property_encoding` (tag 19). Decompression is subject
to the same bomb limits as content (SPEC-GATEWAY), and a gallery reader given
still-compressed bytes MUST refuse rather than report an empty gallery. The
refusal MUST be distinguishable by the caller from the answer for an
inscription that declares no gallery at all; the reference implementation
throws `GalleryEncodingError`. Reporting absence would let a compressed gallery
read as no gallery, which is the outcome this rule exists to prevent.

Reference: `@ordspv/core` (`gallery.ts`).

## 8. Level selection guidance

| consumer | recommended |
|---|---|
| marketplace thumbnail pipeline | L2 (assurances logged), L0 fallback with labeling |
| wallet rendering user-owned assets | L2; escalate to L3 on `singleLeafTree = false` |
| EVM collection metadata (`image` field) | `ord:<id>/content#integrity=…` ⇒ L1 anywhere, L2+ where infra exists |
| bridge/custody attestation, disputes | L3, always, with header sync or checkpoint |
| archival mirrors | L3 + full block retention |

## 9. Conformance vectors

- Positive: inscription 0 L2 bundle (fixtures in `fixtures/insc0/`; assembled and
  verified in `resolver.test.ts`); synthetic L3 bundles at positions 1 and 2
  (`proofbundle.test.ts`).
- Negative (each MUST fail with the paired reason): tampered content byte
  (`VERIFY_FAILED`: txid mismatch), witness swap (L3 `witness commitment mismatch`),
  absent envelope index, `txCount` inflation (depth mismatch), tampered tapscript
  (BIP-341 mismatch), checkpoint contradiction (`HEADER_TRUST`), integrity pin
  mismatch (`INTEGRITY`).
