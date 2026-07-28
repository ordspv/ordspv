# SPEC-SAT: verifiable sat identity (v1)

Status: draft, implemented in `@ordspv/core` (`satnumber.ts`) and `@ordspv/fetch`
(`satbuilder.ts`).

SPEC-VERIFICATION answers *what* an inscription's bytes are. SPEC-CUSTODY
answers *where* the inscribed sat is now. This spec answers *which sat it is*:
its ordinal number, its name, and its rarity, proven from chain data with no
index trusted for any of it.

## Model

Sat identity is the custody path run backward, and the reversal removes the
weakest part of the forward construction. Forward custody has to ask a server
which transaction spent an outpoint, because a transaction does not name its
spender; the answer is an untrusted hint that the proof then has to survive.
Backward, every input already names the txid of its funding transaction, so
ancestry is a hash chain and the walk is document retrieval. A server that
serves the wrong bytes fails the txid check locally. A server that serves
nothing has withheld data, which is visible, rather than forged a lineage.

One consequence is that intermediate transactions need no inclusion proofs at
all. Each one's bytes are pinned by the txid its successor's input names, and
that successor's bytes are pinned the same way, back to a transaction that is
anchored. Only two elements anchor to headers:

- the **reveal**, so the transaction carrying the envelope is pinned to a
  block, exactly as custody hop 0 is. Pinning the transaction is not by itself
  pinning the envelope or its index, because a txid does not commit to any
  witness; the envelope binding section below is what covers both;
- the **terminal coinbase**, because its height is what numbers the sat.

## Sat numbering

From the ordinal theory BIP. A block's coinbase has an implicit input stream of
subsidy sats followed by the block's fee sats:

```
subsidy(h)      = 50e8 >> floor(h / 210000),  zero from epoch 33
firstSat(h)     = sum over g < h of subsidy(g)
TOTAL_SATS      = firstSat(33 * 210000) = 2099999997690000
```

Numbering follows the *theoretical* subsidy. An underpaid or unclaimed subsidy
does not shift the numbers of later blocks, because ordinals depend on how many
sats could have been mined rather than on how many were.

Derived attributes are functions of the number alone:

- `satToHeight(sat)` inverts `firstSat`, giving the mining block and the offset
  within its subsidy;
- rarity is `mythic` for sat 0, then for offset 0: `legendary` every 1,260,000
  blocks, `epic` every 210,000, `rare` every 2,016, `uncommon` otherwise; any
  nonzero offset is `common`;
- the name is bijective base 26 over `LAST_SAT - sat + 1`, so the final sat is
  `a` and sat 0 is `nvtdijuwxlp`.

## Start position in the reveal

Identical to SPEC-CUSTODY's genesis rule, read as an input-space position
rather than an output-space one: the default is `sum(inputValue[0..k-1])` for
envelope input `k`, and a pointer strictly less than the total output sats
replaces it. Output space and input space are the same coordinate system,
since a transaction's outputs are a prefix slice of its concatenated inputs.

That identity has a consequence worth stating plainly, because it is easy to
get wrong: a valid pointer can place the start position in an input *later*
than the one carrying the envelope. Proving inputs `0..k` is therefore a floor
and not a ceiling. A bundle MUST supply prev txs for inputs `0..k` so the
envelope input's value is proven, MAY supply more, and MUST supply enough to
reach the start position. Verifiers MUST use every prev tx supplied.

Unbound inscriptions (zero-value envelope input, or an unrecognized even field
in the envelope) have no chain location and therefore no sat to name. v1 MUST
refuse (`CustodyUnsupportedError`).

## Envelope binding

The start position above is derived from the envelope's input index and its
pointer, both of which live in the reveal's witness, and a txid does not commit
to a witness (BIP-141). A server that rewrites the pointer moves the start
position and therefore names a different sat, while the reveal's txid, its
inclusion proof and the whole ancestry behind it stay valid.

The outpoints the reveal's inputs name are txid-committed, and this bundle
already carries the previous transactions those outpoints name. The envelope
input's prevout therefore supplies a trustworthy scriptPubKey to check the
witness against.

Verifiers MUST perform the envelope binding of SPEC-CUSTODY at the reveal
before deriving a start position, including its two-way index rule, and
MUST record the way the index was proven in `indexProof`:

- a reveal hop carrying a witness section MUST be verified against the
  block's BIP-141 witness commitment as SPEC-CUSTODY specifies, with no
  fallback past a section that fails. Success proves the envelope's bytes
  and its index outright (`wtxid`), with no residual, since the presented
  witness is the chain's witness;
- with no section, a single-input reveal needs nothing more
  (`single-input`).

A reveal with more than one input and no witness section is refused. The
verifier MUST refuse it distinguishably from a forgery
(`EnvelopeIndexUnprovenError`), naming the reveal's input count and the
envelope's input, since such a bundle can be honest and merely unable to
prove its numbering.

At input `k` itself, in every case, the verifier MUST reject a key-path
spend, MUST reject a prevout scriptPubKey that is not P2TR, and MUST verify
the BIP-341 script-path commitment, rejecting the bundle when it does not
hold. The verifier MUST accept a witness section only at the reveal, and MUST
refuse a bundle carrying one on a funding step or on the terminal coinbase
hop. Builders SHOULD emit the section for multi-input reveals.

Verifiers SHOULD report the control block depth, `singleLeafTree` and
`singleInputReveal`, with the residual SPEC-CUSTODY states: when
`indexProof` is not `wtxid`, the binding proves what the commit output's
author committed and not what the reveal executed, because control block
depth 0 does not prove the observed tapscript was the script the input ran.

Funding steps and the coinbase need no such check. Their arithmetic reads
output values and outpoints, which the stripped serialization covers.

## Backward step

For a transaction whose successor's input names output `vout` at offset
`offset`:

```
position = sum(outputValue[0..vout-1]) + offset
```

The containing input is found by walking proven input values in order until
their running total exceeds `position`; the remainder is the offset inside that
input's funding output. Input values MUST come from the referenced previous
transactions, and each previous transaction's bytes MUST hash to the txid the
input names.

Prev txs are aligned from input 0 and form a prefix of the input list. A
verifier whose supplied values do not reach the position MUST reject and say so
rather than assume the sat came from an input it cannot value.

## Terminal coinbase

A coinbase spends a single null outpoint, so it is where the walk stops. The
implicit input stream is `subsidy(h)` sats first, then the block's fee sats:

- a position below `subsidy(h)` yields `firstSat(h) + position`;
- a position in the fee tail means the sat was once paid as a fee, which needs
  whole-block accounting to follow. v1 MUST refuse
  (`CustodyUnsupportedError`), symmetric with forward custody.

The height that numbers the sat is the one input a server can change without
breaking a hash, so verifiers MUST NOT accept a claimed height unchecked.
At heights at or above 230,000, verifiers MUST parse the BIP34 height from the
coinbase's own scriptSig (first push, little-endian) and MUST reject a bundle
whose claimed height contradicts it. Below 230,000 the height rests on header
anchoring alone, since an attester's hash-at-height vote binds the pair.

## Genealogy bundle

```jsonc
{
  "version": 1,
  "inscriptionId": "<txid>i<n>",
  "reveal": {                        // a CustodyHopJson, anchored
    "block": { "height": n, "hash": "…", "header": "<160 hex>", "txCount": n },
    "tx": { "hex": "…", "pos": n, "txidBranch": ["…"] },
    "prevTxs": ["…"],                // inputs 0..k at minimum
    "witness": { /* OPTIONAL: the reveal's wtxid proof, SPEC-CUSTODY shape */ }
  },
  "funding": [                       // nearest funder first; empty when the
    { "tx": { "hex": "…" },          // reveal spends a coinbase directly
      "prevTxs": ["…"] }             // inputs 0..containing input
  ],
  "coinbase": { /* CustodyHopJson, anchored; tx.pos MUST be 0 */ },
  "claimedSat": "<decimal>"
}
```

An empty `funding` list is specified and implemented, and it is close to
unreachable on mainnet: a reveal spends a taproot commit output, so reaching it
takes a miner paying a coinbase output straight to an inscription commit
address. A scan of 3,001 blocks (830000 to 833000) found no taproot coinbase
output at all, and 135 uncommon-sat inscriptions bottomed out at depth 2. The
branch therefore carries unit coverage rather than a mainnet vector, as does a
pointer that lands past its own envelope input, which 3,232 multi-input reveals
across 206 blocks did not produce.

Verifiers MUST, for the reveal and the coinbase: recompute the header hash,
check proof of work, require a valid `txCount` and a branch depth equal to
`treeHeight(txCount)` (CVE-2017-12842 hardening, as in SPEC-VERIFICATION), and
fold the txid branch to the header's merkle root. The reveal and the coinbase
MUST be rejected at a stripped size of 64 bytes, since their txids are folded
through a merkle branch and a 64-byte stripped transaction is indistinguishable
from an interior node (CVE-2017-12842 again). Funding steps SHOULD be rejected
on the same rule, cheaply, to keep the chain positions uniform. Previous
transactions need no such check: none of them is folded into a tree, and each
is pinned by the txid the input spending it names, so hashing to that txid is
the whole of what they have to satisfy. Verifiers MUST additionally bind the
reveal's envelope and its index as the envelope binding section requires.

Verifiers MUST reject a duplicate transaction anywhere in the genealogy, and
MUST reject a coinbase appearing as a funding step rather than as the terminal
element. A verifier-side step cap (default 10,000) bounds hostile bundles.
Builders carry their own cap, since a walk spends a request per step against a
live backend; the reference builder defaults to 4,096 and exposes it as
`--max-steps`. Deep ancestries are ordinary: mainnet has inscriptions past 800
funding steps, so a builder cap below four figures refuses real work.

`claimedSat` is a claim. Verifiers MUST fold the genealogy themselves and
reject on mismatch.

Header anchoring is out of band, as for proof and custody bundles: embedded PoW
alone is cheap, so callers anchor both endpoint headers against checkpoints and
independent sources, and the backend that built the bundle MUST NOT count as an
independent attester for it.

## What sat identity proofs cannot say

That this inscription is the *first* one on the sat. A genealogy names the sat
an envelope was bound to; whether some earlier envelope was bound to the same
sat is a global question over every inscription ever made, and no path proof
answers it. Callers who care about first-inscription status need an index, and
should treat that part as trusted.

Rarity is a statement about the sat's position in the issuance schedule.
Whether the wider market recognizes any given tier is outside this spec.

## Deferred (v1 boundaries)

- Sats mined into the fee tail: needs block-level fee accounting; refused
  loudly, as in SPEC-CUSTODY.
- Unbound inscriptions: no chain location to trace; refused loudly.
- Inscription numbers: a global aggregate over every reveal in chain order,
  with no path structure to prove. Out of scope for any single-inscription
  proof.
