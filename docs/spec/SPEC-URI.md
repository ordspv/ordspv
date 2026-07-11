# ORD-URI-1: the `ord:` URI scheme for inscription content

Status: draft v0.1 · 2026-07-11
Companion specs: [SPEC-VERIFICATION.md](./SPEC-VERIFICATION.md), [SPEC-GATEWAY.md](./SPEC-GATEWAY.md)

The key words MUST, MUST NOT, SHOULD, MAY are to be interpreted per RFC 2119.

## 1. Purpose and relationship to upstream

This spec extends the draft `ord:` scheme in the ord handbook
([inscriptions/uris](https://docs.ordinals.com/inscriptions/uris.html)) without
contradicting it. Upstream defines the bare form and its referent; this spec adds a
compatibility alias, two path suffixes, and an integrity fragment, and defines
normalization and resolution behavior precisely enough for interoperable resolvers,
gateways, and cross-chain consumers.

## 2. Syntax

```
ord-uri        = scheme id-part [ "/" path ] [ "#" fragment ]
scheme         = "ord:" / "ord://"          ; "ord:" is canonical
id-part        = 64hexdig "i" index         ; inscription id
index          = "0" / nonzero *digit       ; decimal u32, no leading zeros
path           = "content" / "metadata"
fragment       = "integrity=" "sha256-" digest
digest         = 64hexdig / base64-32bytes  ; hex preferred; SRI-style base64(url) accepted
```

- Matching is **case-insensitive** everywhere (upstream requirement, preserves QR
  alphanumeric mode); producers SHOULD emit lowercase. Resolvers MUST normalize to
  lowercase before use — inscription IDs survive URI authority case-folding by
  construction.
- `ord://` is a **compatibility alias**: resolvers MUST accept it and MUST treat
  `ord://X` identically to `ord:X`. Producers SHOULD emit `ord:`. (Rationale: upstream
  chose no hierarchical part; existing URL-detection heuristics in wallets and
  marketplaces often require `://`. Accepting both costs nothing and forks nothing.)
- Canonical serialization: `ord:` + lowercase id + optional `/path` + optional
  lowercase-hex fragment. Resolvers SHOULD expose the canonical form (see
  `parseOrdUri().canonical`).
- A bare inscription id (no scheme) is NOT an ord URI, but resolver APIs MAY accept it
  as an ergonomic input.

## 3. Referents

| form | referent | ord server equivalent |
|---|---|---|
| `ord:<id>` | the inscription's **original** content: body bytes, content-type, and content-encoding from its own envelope, delegation NOT applied | `/r/undelegated-content/<id>` |
| `ord:<id>/content` | the inscription's content **as ord serves it**: if the envelope carries a valid delegate, the delegate's body, content-type, and content-encoding (one hop, never chained) | `/content/<id>` |
| `ord:<id>/metadata` | the inscription's raw CBOR metadata (tag 5, chunks concatenated) | `/r/metadata/<id>` (hex-encoded there) |

- The bare-form referent follows upstream verbatim: "The referent of an inscription URI
  is always the original content of the target inscription, and not the content of the
  delegate."
- `ord:<id>/content` with a delegate whose reveal is not yet inscribed MUST fail
  (upstream 404 semantics), not fall back to the delegating inscription's own body.
- Referents are **immutable**: same URI, same bytes, forever. Caches MAY treat
  resolutions as `immutable` (see SPEC-GATEWAY §4).
- An inscription with no body (bare form), or whose effective content source has no
  body (`/content` form), has no referent: resolution MUST fail with a
  not-found-equivalent error.
- Envelope index semantics: `<id>` addresses the Nth envelope of the reveal
  transaction, counting every parsed envelope (cursed and unbound included) flat across
  inputs in order — matching ord. Unbound/cursed inscriptions are valid referents.

## 4. The integrity fragment

```
ord:<id>#integrity=sha256-<hex64>
ord:<id>/content#integrity=sha256-<base64url-of-32-bytes>
```

- The digest domain is the **stored body bytes** of the effective content source (the
  addressed inscription for the bare form; the delegate for `/content` when
  delegation applies; the raw CBOR bytes for `/metadata`) — i.e. exactly the
  concatenated envelope body pushes, BEFORE any content-encoding is decoded and before
  any transport re-encoding. This makes the digest a pure function of on-chain data.
- Fragments are client-side by design (never sent to gateways). A resolver that is
  given an integrity fragment MUST verify it and MUST fail resolution on mismatch,
  regardless of verification level.
- A resolver that only holds transport-decoded bytes (e.g. its HTTP layer transparently
  inflated `Content-Encoding: br`) and observes a mismatch MUST distinguish
  "indeterminate" from "mismatch" (see `INTEGRITY_INDETERMINATE`) and SHOULD retry via
  a chain-data path (L2+) where stored bytes are available.
- Rationale: this is what ERC-2477 tried to do in a parallel contract field and never
  got adopted; inside the URI it travels everywhere the pointer travels — including
  inside immutable EVM contract storage, where it upgrades a hosted-gateway consumer to
  L1 verification with zero Bitcoin infrastructure (levels in SPEC-VERIFICATION §2).

## 5. Resolution requirements

- Resolvers MUST implement the verification-level contract of SPEC-VERIFICATION and
  SHOULD default to L2 or better.
- Resolvers MUST apply ord's envelope semantics exactly (tag table, take semantics,
  duplicate/unbound flags, one-hop delegation) — the normative behavior is ord's
  `envelope.rs`/`tag.rs`; a conformant TypeScript mirror with tests ships in
  `@ord-resolver/core`.
- Content-encoding: resolvers SHOULD decode a recognized `content_encoding` (`br`,
  `gzip`, `deflate`) for callers, and MUST otherwise deliver the stored bytes together
  with the encoding label. Resolvers MUST NOT fail solely because an encoding is
  unknown (any string can appear on-chain).
- Unknown paths and unknown fragments MUST fail parsing (fail-closed: a consumer that
  doesn't understand `/foo` must not silently serve the bare referent under a URI that
  meant something else to its producer).

## 6. Out of scope (deliberately)

- **Inscription numbers** (`ord:12345`): numbers are an artifact of a trusted global
  index (including negative/cursed numbering quirks) and cannot be verified from chain
  data by ID-holders; adding them would silently reintroduce the trusted-oracle
  dependency this scheme exists to remove.
- **Sat addressing** (`ord:sat/…`): requires `--index-sats`-class infrastructure;
  `did:btco` already occupies the sat-identity niche.
- **Recursive-endpoint URIs** (`ord://r/...` per discussion #3780): gateway-layer
  concern; addressed as HTTP surface in SPEC-GATEWAY, not as URI referents.

## 7. Registration and compatibility notes

- Upstream's draft contemplates IANA registration; the ar:// playbook (provisional
  registration + one solid resolver SDK) is the recommended path and should be
  coordinated with upstream rather than filed independently.
- Consumers pattern-matching URIs SHOULD use:
  `(?i)^ord:(//)?[0-9a-f]{64}i(0|[1-9][0-9]*)(/(content|metadata))?(#integrity=sha256-([0-9a-f]{64}|[A-Za-z0-9+/_-]{43}=?))?$`
- EVM/tokenURI embedding guidance lives in [../CROSS-CHAIN.md](../CROSS-CHAIN.md).

## 8. Test vectors

Inscription 0 (all forms resolve to the same 793-byte PNG; digest verified in this
repo's test suite):

```
ord:6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0
ord://6FB976AB49DCEC017F1E201E84395983204AE1A7C2ABF7CED0A85D692E442799I0
ord:6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0/content
```

Invalid (MUST fail): `ord:abci0` (short txid), `ord:<64hex>i01` (leading zero),
`ord:<64hex>i4294967296` (index > u32), `ord:<id>/preview` (unknown path),
`ord:<id>#integrity=md5-…` (unknown algorithm).
