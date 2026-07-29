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

## Envelope binding

Everything above reads the envelope out of the reveal's witness, and a txid
does not commit to a witness (BIP-141). Anchoring the reveal by txid therefore
establishes nothing about the pointer, the envelope's input, or the envelope
bytes: a server can rewrite any of them, leave every byte the txid hashes
untouched, and produce a bundle whose inclusion proofs still fold.

What a txid does commit to is each input's outpoint, and the previous
transactions above are already pinned by those outpoints. The envelope input's
prevout therefore carries a trustworthy scriptPubKey, and BIP-341 requires the
witness tapscript to be committed by it.

Binding the envelope input alone is not sufficient. The envelope's index is a
running count over the envelopes found in every input before it, in input
order, so the witness of each earlier input decides which envelope the
inscription id names. An unchecked earlier input leaves the numbering
rewritable even when the envelope's own input is bound.

A bundle can prove the numbering in two ways. The verifier MUST record
which one it used in the `indexProof` field of the verified result:

- `wtxid`: the reveal hop carries a witness section (see the bundle format
  below). The verifier MUST verify it: the coinbase parses, is a coinbase,
  and merkle-proves into the anchored header at position 0 with the correct
  branch depth; the coinbase carries a BIP-141 witness commitment and a
  well-formed reserved value; and the commitment matches the witness tree
  folded from the reveal's wtxid at the proven position, with the zeroed
  coinbase leaf required as the sibling at position 1 and position 0
  refused. The wtxid covers the reveal's exact serialization including every
  input's witness, so success pins the envelope's bytes and its index
  together, with no multi-leaf residual, since the presented witness is the
  chain's witness. The verifier MUST NOT fall back past a present witness
  section that fails; such a bundle is forged or corrupt.
- `single-input`: no witness section, and the reveal has one input. The
  input count is txid-committed, so no other input can contribute an
  envelope and there is nothing to renumber. This says nothing about whether
  the observed tapscript was executed; that is the residual below.

A reveal with more than one input and no witness section is refused. The
verifier MUST refuse it distinguishably from a forgery
(`EnvelopeIndexUnprovenError` in the reference implementation), since such a
bundle can be perfectly honest and simply unable to prove its numbering, and
the refusal MUST name the reveal's input count and the requested index. The
verifier MUST refuse before selecting an envelope, because the envelope count
of such a reveal is itself unproven: reporting that the requested index is
absent would assert a count the bundle cannot support.

The verifier MUST accept a witness section only at the reveal. Later custody
hops read nothing from witnesses, so the verifier MUST refuse a bundle whose
later hop carries one.

In every case, including `wtxid`, the verifier MUST bind the envelope's own
input `k` before using anything read from the envelope: the corresponding
previous transaction MUST hash to the txid input `k` names and MUST contain
the named output; the verifier MUST reject a key-path spend at the envelope
input, since a key-path spend commits to no script and cannot carry an
envelope; the verifier MUST reject a prevout scriptPubKey that is not P2TR,
since an envelope is committed in a taproot script path; and the verifier
MUST verify the BIP-341 script-path commitment of the tapscript against that
scriptPubKey, rejecting the bundle when it does not hold.

Binding an input before `k` would not help, and an earlier revision of this
spec required it in error. Control block depth 0 proves the prevout's author
committed the observed tapscript. It does not prove that tapscript was
executed, because a single-leaf P2TR output is spendable by key path as well
as by script path and the txid commits to neither the witness nor the spend
path chosen. An input the reveal spent by key path reveals no envelope, and
a verifier holding only the served script-path witness cannot tell the two
apart. Inputs after `k` need no binding for a different and sound reason:
envelopes they carry receive higher indices and cannot renumber the selected
one.

Builders SHOULD emit the witness section for multi-input reveals; the
reference builder does, at the cost of one raw block request, and emits no
section for single-input reveals by default, whose bundles are unchanged.

Builders MUST be able to emit the section for ANY reveal, single-input ones
included, because a consumer holding the inscriber inside its threat model
needs `indexProof` `wtxid` on every inscription it verifies, and a builder
that cannot produce one leaves that consumer with a remedy it cannot
exercise. The reference builder takes `witnessSection: 'always' |
'when-needed'` (`--witness-section` on the CLI), defaulting to
`'when-needed'`, which is the behavior above. A builder asked for a section
it cannot fetch MUST fail rather than emit a bundle without it, and MUST
report that failure distinguishably from the verifier's refusal above, since
one is availability and the other is not.

A builder reads the envelope out of the served reveal witness before anything
has bound that witness, so a domain refusal it derives from that envelope is
one backend's claim about the path and not the chain's answer. The same holds
of the block hash and the in-block position a backend's own status and merkle
proof name, which is what decides whether the reveal's witness section can be
built at all: a backend naming a real but wrong block for the reveal makes the
raw block unusable at every backend. So the test is what the refusal was
derived from. A builder MUST NOT treat a build-time refusal as terminal while
another backend is configured unless the refusal was derived from data the
reveal txid commits; it MUST record the rest as that backend's cause and build
against the next one. A position that lands outside the sat space of the
transaction it was resolved against is derived from the pointer and the
envelope input in that same witness, so it is one backend's claim too. The
reveal's input count is such data, so a refusal raised on the count of inputs
is terminal. A refusal becomes terminal once a
verifier raises it, because the bundle a verifier refused had already bound
its witness through the envelope binding above. A builder that has exhausted
every configured backend SHOULD report the refusal in the class each backend
raised, and SHOULD name every backend that led an attempt reporting it. A
builder MUST report whether every configured backend reached that same
refusal, and MUST name the backends it could not reach when they did not. A
caller MUST NOT read a domain refusal that only some configured backends
reached as proof about the chain.

Verifiers SHOULD report the control block's merkle path depth at input `k`,
whether it is zero (`singleLeafTree`), and whether the reveal has a single
input (`singleInputReveal`). When `indexProof` is `wtxid` the presented
witness is the chain's witness and no residual remains. Otherwise the
residual is the residual of SPEC-VERIFICATION level 2: the binding proves
what the commit output's author committed, and not what the reveal executed.
With `singleLeafTree` true it proves no other tapscript was committed at
all, which is still a statement about commitment; the same author could have
spent the output by key path and served the tapscript afterwards. A
consumer for whom the inscriber is inside the threat model SHOULD require
`indexProof` `wtxid`.

Later hops need no such check. Their arithmetic reads outpoints, output values
and txids, all of which the stripped serialization covers.

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
      "prevTxs": ["…"],           // aligned to inputs 0..k / 0..j
      "witness": {                // OPTIONAL, hop 0 only: the reveal's wtxid
        "coinbaseHex": "…",       // proof, same shape as SPEC-VERIFICATION's
        "coinbaseTxidBranch": ["…"],  // L3 witness section
        "wtxidBranch": ["…"]
      }
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
and hops after the reveal MUST NOT be coinbases. At hop 0 verifiers MUST also
bind the envelope and its index as the envelope binding section requires.

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
- Inscription numbers: global aggregates with no path structure; out of scope
  for any custody proof.

Backward sat identity (which sat an inscription lives on, traced to the
coinbase that mined it) is this machinery run in reverse, and is specified
separately in SPEC-SAT.
