# Verification defects in `@ordspv` 0.2.x

Published 2026-08-04. Fixed in 0.3.0.

## Affected versions

| Package                 | Affected | Fixed in |
| ----------------------- | -------- | -------- |
| `@ordspv/core`          | 0.2.0    | 0.3.0    |
| `@ordspv/fetch`         | 0.2.1    | 0.3.0    |
| `@ordspv/cli`           | 0.2.1    | 0.3.0    |
| `@ordspv/gateway`       | 0.2.1    | 0.3.0    |
| `@ordspv/proof-sidecar` | 0.2.1    | 0.3.0    |

The four packages at 0.2.1 pin `@ordspv/core` to exactly `0.2.0`, and
`packages/core` is byte-identical between the `v0.2.0` and `v0.2.1` tags, so
every published 0.2.x package carries all three defects. 0.1.x has not been
examined for these and is deprecated.

There is no 0.2.x backport. Upgrade to 0.3.0.

## Summary

Three defects in `@ordspv/core` 0.2.0 weaken the forgery detection in
`verifyProofBundle`. Two of them let a crafted bundle pass a check that was
written to refuse it. The third leaves a fabricated block header cheap to
produce. All three sit in the code path that every published package uses to
verify content, so they reach L2 and L3 verification, which is the whole of
what 0.2.x offers.

We know of no way to turn any of the three into a wrong content answer against
a verifier that follows the anchoring requirement in SPEC-VERIFICATION section
4. That requirement says a verifier MUST anchor a bundle's block hash against
its own view of the chain, and the library reports when it could not do so. A
caller who ignores that report gets materially less protection than the
documentation promises, and that gap is the practical shape of these defects.

We are publishing this because the checks were documented as holding and did
not hold, which users cannot audit for themselves without reading the source.

## 1. The merkle duplicate-sibling guard checked one member of the pair

`packages/core/src/merkle.ts:81` at `v0.2.1`:

```ts
if (!isLastOdd && bytesEqual(sibling, node) && index % 2 === 0 && index + 1 === width - 1) {
```

The guard refuses the CVE-2012-2459 shape, where a level's final node is
duplicated so that a tree of one leaf count produces the same root as a tree of
another. The condition is asymmetric. `index % 2 === 0` restricts it to the
left member of the final pair, so a proof of the right member of the same
duplicated pair has an odd index and skips the check.

Over trees of 1 to 40 leaves, claiming every position in each, there are 40
duplicated-final-pair claims. The 0.2.x guard refuses 20 and accepts 20. The
0.3.0 guard refuses all 40 and rejects none of the honest claims over the same
range.

What an accepted claim buys an attacker is narrower than the guard's absence
suggests. The fold still has to reach the honest root, so the leaf still has to
be the hash of a transaction that really is in the block. The accepted claims
restate a genuine transaction at an inflated position and leaf count. In the
sweep, every position-moving claim concerns the block's last real transaction,
moves it upward, and never produces position 0. The content path does not read
the position, so a claim surviving this way returns the content it would have
returned honestly.

Fixed by `width % 2 === 0 && (index | 1) === width - 1`, which names the final
pair of an even-width level and refuses whichever member is being proved.

## 2. The 64-byte rule tested the witness-bearing serialization

`packages/core/src/proof.ts:106` at `v0.2.1`:

```ts
if (tx.raw.length === 64) throw new Error(`${label}: 64-byte transactions are rejected (leaf/node ambiguity)`);
```

A 64-byte transaction is ambiguous with an internal merkle node, since a node
is two concatenated 32-byte hashes and both are hashed the same way. The rule
is right and the field is wrong. `tx.raw` is the BIP-144 serialization
including witness data. The preimage that becomes a leaf of the txid tree is
`tx.strippedRaw`, which excludes the witness. Both fields were already present
on the parsed transaction at 0.2.1.

So a segwit transaction whose stripped serialization is exactly 64 bytes passes
a check written to refuse it. That shape is constructible: one input with an
empty scriptSig, one small output, and a witness of any size. A witness is
where an inscription envelope lives, so the bypassing shape and the shape this
library cares about are compatible.

Reaching a wrong answer from there is expensive. The same 64 bytes must also
equal two real internal node hashes of a real block's tree, and those values
are not attacker-chosen. Producing one plausibly requires block-producing
capability plus grinding. This is a defense-in-depth failure with a high bar to
exercise, and it is the sharpest of the three because that bar is the only
thing standing in the way.

Fixed by testing `tx.strippedRaw.length === 64`.

## 3. No proof-of-work floor on a bundle's header

`packages/core/src/proof.ts:120` at `v0.2.1`, calling `header.ts:64`:

```ts
if (!checkProofOfWork(header)) throw new Error('header fails proof of work');
```

`checkProofOfWork` confirms the header hashes below the target its own `nBits`
field encodes. The bundle supplies the header, so it supplies `nBits` too. A
fabricated header that declares difficulty 1 satisfies the check for about 2^32
hashes, which is seconds of work. Nothing in 0.2.x compares the declared target
against a floor.

This does not by itself produce a wrong answer, because the fabricated header
still has to survive anchoring against the caller's chain view, and a
fabricated hash will not be found at the claimed height. It does mean a caller
who skips anchoring, or who treats an unanchored result as a pass, faces no
cost barrier at all.

Fixed by `checkPowLimit`, called from `verifyProofBundle` and from the custody
verifier. The floor is mainnet's difficulty-1 limit by default and is
configurable through `powLimitBits` for other chains. It removes the free case
and does nothing more, since a bundle still picks its own height and its own
bits. Anchoring remains the defense against a fabricated header.

## If you cannot upgrade yet

Anchor every block hash a bundle reports against an independent view of the
chain, and treat an unanchored result as unproven rather than as a pass. That
advice holds for a correct release too, and it is what closes the gap these
three defects open.

## Credit

Found in internal review. No external report.
