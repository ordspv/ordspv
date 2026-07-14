## Title: `ord:` URI extensions: compatibility alias, paths, integrity, IANA registration

The `ord:` scheme drafted in [uris.md](https://docs.ordinals.com/inscriptions/uris.html)
is the right foundation: id-addressed, no hierarchical part, undelegated referent.
We've built a verifying resolver on top of it (library, reference gateway, proof
format, conformance test corpus), and along the way wrote a small extension profile where real-world integrations needed more than the
draft specifies. This discussion proposes upstreaming the extension points (or
hearing why not), and offers legwork on IANA registration.

**What exists today** (all open source, ISC, links at the end):

- A resolver that takes `ord:<id>` and returns verified bytes: BIP-341 tapscript
  commitment + txid merkle proof against a PoW-checked header ("L2"), or the full
  BIP-141 witness-commitment binding ("L3"). No trusted index is required for content.
- A reference gateway mapping the scheme onto the recursive endpoints, exactly as
  suggested in #3780 (`/r/undelegated-content` for the bare referent, `/content`
  for delegation-applied).
- An envelope parser locked byte-for-byte to ord's own `envelope.rs` test corpus,
  plus a live parity sweep against ordinals.com across eras (cursed, pushnum-era,
  666-envelope batches, delegates, chunked metadata, content-encoding).

**Proposed extension points** (spec'd and implemented; we'd rather converge than fork):

1. **`ord://` as a compatibility alias.** The canonical form stays `ord:<id>`
   (QR-friendly, no authority). But every marketplace URL-detector, wallet
   deep-link router, and `tokenURI` pipeline in the wild expects
   scheme-plus-slashes; #3780's demand is real. Parsers SHOULD accept `ord://`
   and normalize to `ord:`.
2. **Explicit referent paths.** `ord:<id>` = undelegated content (upstream rule,
   unchanged); `ord:<id>/content` = delegation-applied content;
   `ord:<id>/metadata` = raw CBOR metadata. Collections using delegates need an
   addressable form for "the content this inscription displays as". That's
   `/content`, mirroring the recursive endpoints' own split.
3. **Integrity fragment.** `ord:<id>#integrity=sha256-<hex>` pins the sha256 of
   the STORED body bytes: the pure on-chain function of the envelope, and NOT
   transport bytes (CDNs make `Content-Encoding` ambiguous, so the pin is
   defined over tag-9-encoded bytes as inscribed). Fragments are client-side, so
   this composes with any gateway. Precedent: SRI, and the reason ERC-2477
   stalled is that integrity lived OUTSIDE the URI.
4. **ID addressing only.** Inscription numbers and sat addressing stay out.
   They're trusted-index artifacts; ids are self-certifying.

**IANA.** `ord:` is unregistered. The ar:// playbook (provisional registration +
one good SDK) is what got that scheme into mainstream acceptance. A provisional
registration under RFC 7595 is a two-page template referencing the uris.md draft;
we're happy to draft it for review here, with the ord project as change
controller. The scheme is yours, we just want the paperwork to exist.

**Ask:**
- Would a PR extending `uris.md` with §1–3 above (marked as extensions, canonical
  form unchanged) be welcome?
- Any objection to a provisional IANA registration naming ordinals.com /
  the ord repo as the authority?

Happy to adjust the profile to whatever upstream decides. The point of building
against the draft was to avoid forking the referent semantics, and the parity
corpus means we notice immediately if we drift.

*Links: [resolver + specs + corpus](https://github.com/ordspv/ordspv),
[live browser demo](https://ordspv.github.io/ordspv/examples/verify-inscription-0.html),
[witness-proof electrs branch](https://github.com/ordspv/electrs/tree/witness-merkle-proof)
(companion infrastructure so L3 verification is cheap everywhere).*
