# SPEC-CUSTODY: verifiable satpoint custody paths (v1)

Status: draft, implemented in `@ordspv/core` (`custody.ts`) and `@ordspv/fetch`
(`custodybuilder.ts`).

Content verification (SPEC-VERIFICATION) answers *what* an inscription's bytes
are. This spec answers *where* the inscribed sat is, with the same trust
model: servers supply data, clients prove it.

## Model

An inscription's location is a **satpoint** `txid:vout:offset`. Its history is
a path through the transaction graph:

1. the reveal transaction binds the inscription to a **genesis satpoint**;
2. every later transaction that spends the tracked outpoint moves the sat by
   ordinal first-in-first-out arithmetic.

Both steps are locally checkable, so custody is provable as a **path proof**.
The role of an index (ord, esplora) collapses to *finding* the path; nothing
it asserts is trusted.

## Genesis satpoint

Given the reveal transaction, the envelope's input `k`, and an optional
pointer (tag 2):

- default: the absolute input-space position `sum(inputValue[0..k-1])`, mapped
  through the outputs in order;
- a pointer strictly less than the total output sats instead indexes the
  output sat space directly; a pointer at or past that total MUST be ignored;
- zero-value outputs occupy no sat space;
- an inscription whose envelope input has zero value, or whose envelope
  carries an unrecognized even field, is UNBOUND: ord assigns it to the
  all-zeros unbound outpoint, not to any output, regardless of pointer or
  position. v1 MUST refuse (`CustodyUnsupportedError`);
- a position at or past the total output sats means the inscription bound to
  fee sats (ord routes it through the block's coinbase); v1 MUST refuse
  (`CustodyUnsupportedError`), not guess.

Input values are needed for positions, and inputs do not carry values.
Verifiers MUST obtain them from the referenced previous transactions and MUST
check each previous transaction's bytes hash to the txid the input names.
This makes values self-certifying; previous transactions need no inclusion
proofs of their own. Only inputs `0..k` are relevant.

## Transfer

For a transaction spending the tracked satpoint at input `j`:

```
position = sum(inputValue[0..j-1]) + tracked.offset
```

mapped through the outputs in order. The tracked offset MUST be strictly less
than the spent output's value. A position at or past the total output sats
means the sat entered fees; v1 MUST refuse rather than follow it through the
coinbase (tracking a fee sat requires the whole block's fee picture and is
deferred).

## Custody bundle

```jsonc
{
  "version": 1,
  "inscriptionId": "<txid>i<n>",
  "hops": [
    {
      "block": { "height": n, "hash": "…", "header": "<160 hex>", "txCount": n },
      "tx": { "hex": "…", "pos": n, "txidBranch": ["…"] },
      "prevTxs": ["…"]            // aligned to inputs 0..k / 0..j
    }
  ],
  "finalSatpoint": "txid:vout:offset"
}
```

Hop 0 is the reveal. Verifiers MUST, per hop: recompute the header hash,
check proof of work, require a valid `txCount` and a branch depth equal to
`treeHeight(txCount)` (CVE-2017-12842 hardening, as in SPEC-VERIFICATION),
fold the txid branch to the header's merkle root, and reject 64-byte
transactions. Hops MUST be in strict chain order: increasing height, or equal
height with strictly increasing position. Hop transactions MUST be distinct,
and hops after the reveal MUST NOT be coinbases.

`finalSatpoint` is a claim; verifiers MUST recompute the path and reject on
mismatch.

Header anchoring is out of band, exactly as for proof bundles: embedded PoW
alone is cheap, so callers anchor each hop's header against checkpoints and
independent sources (`trustHeader`; the backend that built the bundle MUST
NOT count as an independent attester for it).

## What custody proofs cannot say

Unspentness. "The final outpoint is still unspent" is a negative statement;
no inclusion proof exists for it. Resolvers MUST surface tip liveness as
per-source observations (outspend checks across independent backends, or the
caller's own node), never as part of the proof. A custody proof is therefore
"owned as of its last hop", plus observed-unspent-by listed sources.

## Deferred (v1 boundaries)

- Sats through fees (fee-bound reveals, fee-spillover hops, coinbase
  traversal): requires block-level fee accounting; refused loudly.
- Unbound inscriptions (zero-value envelope input, unrecognized even field):
  ord's unbound outpoint is a bookkeeping location, not a chain location;
  refused loudly.
- Backward sat identity (tracing to a coinbase for rare-sat claims): same
  machinery run in reverse; unimplemented.
- Inscription numbers: global aggregates with no path structure; out of scope
  for any custody proof.
