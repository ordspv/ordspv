# Extended fixture provenance

Every vector here is real Bitcoin mainnet data, vendored by
`npx tsx scripts/fetch-fixtures.ts <id>…` and cross-checked against a live ord
instance by `scripts/parity-sweep.ts`. Nothing in this directory is trusted at
test time: each `<id>.bundle.json` self-verifies cryptographically in
`packages/fetch/test/extended.test.ts` (the reveal txid is recomputed from the
vendored hex, the header hash is recomputed and the merkle branch re-folded,
the BIP-341 control block is re-checked against the vendored commit tx), and
the `<id>.json` summary carries live-recorded expectations including body
sha256 pins. A corrupted fixture cannot pass silently.

Per id, the raw ingredients came from these URL shapes (esplora API, either
mempool.space/api or blockstream.info/api):

- reveal + commit hex: `https://mempool.space/api/tx/<txid>/hex`
- txid merkle proof: `https://mempool.space/api/tx/<txid>/merkle-proof`
- header: `https://mempool.space/api/block/<hash>/header`
- tx count: `https://mempool.space/api/block/<hash>`
- ord cross-check: `https://ordinals.com/r/inscription/<id>`,
  `/r/undelegated-content/<id>`, `/r/metadata/<id>`

## First wave (vendored 2026-07-11)

Discovered by scanning raw mainnet blocks with this repo's parser plus the
published ordpool-parser test vectors, then confirmed live. Details in the
2026-07-11 sweep notes (ROADMAP.md).

| id | height | what it locks |
| --- | --- | --- |
| `ded23bc4…8ai0` | 780000 | pushnum-era cursed text (pre-Jubilee) |
| `74c157fb…0bi1` | 833000 | post-Jubilee batch, i1 + pointer |
| `6dc2c16a…dbi0` | 819367 | brotli (tag-9) javascript |
| `c50ed012…07i0` | 830198 | chunked metadata > 520 B (duplicate tag 5) |
| `4c83f2e1…22i0` | 825897 | gzip (tag-9) svg with a tag-15 note |
| `0028084b…f2i0` | 846000 | delegate + metadata + empty-but-present body |
| `177c1e83…82i0` | 844374 | the delegate target svg |

## Second wave (vendored 2026-07-19)

| id | height | what it locks | discovery |
| --- | --- | --- | --- |
| `52b4ea10…99i0` | 842600 | recursive html calling `/r/sat/<sat>/at/-1` (and `/content/`), with a parent | ord handbook "Inscription Examples" page (Oscillations collection parent) |
| `3891327c…14i0` | 825451 | tag-9 brotli javascript library, stored 4219 B → 16475 B decoded, parent tag, envelope in reveal input 1 | TheWizardsOfOrd Elements README → `/r/sat/45018381985` listing |
| `47c72607…a3i0` | 839876 | provenance: parents = [inscription 0], envelope in reveal input 1, multi-input reveal (L2 `singleInputReveal=false`) | children listed on ord's inscription-0 page |
| `758b032b…b2i1` | 828500 | `application/json;charset=utf-8` body at i1 (JSON.parse-able) | raw-block scan with this repo's parser |
| `6c76e134…45i0` | 824886 | `text/css` asset (non-html text type) | stylesheet link inside the Oscillations parent html |
| `49cbc5cb…07i0` | 821487 | tag-7 metaprotocol (`cbrc-20:deploy`) + CBOR metadata | already in the parity-sweep corpus (ordpool-parser era vectors); vendored to lock metaprotocol offline |

Search notes for the second wave: audio/* was also wanted but no small example
surfaced — raw-block scans of 12 mainnet blocks across the 776000–958760 range
(2023-02 through 2026-07 eras) found zero audio envelopes, and the audio
entries on ord's examples page are generators typed `text/javascript` /
`text/html`. The unrepresented-type slots went to `application/json` and
`text/css` instead; revisit audio when an indexed by-type source is available.

Refresh/re-vendor: `npx tsx scripts/fetch-fixtures.ts <id>` (network required)
rebuilds a vector from live data; the offline suite then re-verifies it byte
by byte. Keep new vectors small (bundles here are 2.3–43 KB) and add each new
id to `DEFAULT_IDS` in `scripts/parity-sweep.ts` so the weekly live sweep
keeps checking it against ord.
