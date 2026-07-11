# ordspv browser extension (MV3)

Verify inscription content against Bitcoin proof-of-work in your browser.
Instead of trusting `ordinals.com` (or any gateway) to serve honest bytes, the
extension resolves inscriptions itself: fetches chain data from public esplora
instances, checks the txid merkle proof against a PoW-checked header and the
BIP-341 tapscript commitment (L2; optional L3 adds the witness commitment via
a raw-block download), and renders only bytes that passed.

## Load it (dev build; store submission is a later, identity-gated step)

1. `npx tsx scripts/build-extension.ts` (repo root), or use the committed
   `dist-unpacked/` as-is
2. `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select `extension/dist-unpacked/`

## What it does

| surface | behavior |
|---|---|
| gateway URLs | main-frame navigations to `ordinals.com/content/<id>`, `/preview/<id>`, `/r/undelegated-content/<id>` redirect to the verifying viewer (declarativeNetRequest; toggle in popup; `/content`+`/preview` resolve delegation-applied, `/r/undelegated-content` the bare referent, per SPEC-URI) |
| `ord:` links | on per-site-enabled origins, a content script makes `ord:`/`ord://` anchors clickable (browsers won't navigate unknown schemes and MV3 can't register protocol handlers for them; this is the IPFS Companion workaround) |
| omnibox | keyword `ord` + an inscription id or `ord:` URI opens the viewer |
| popup | intercept toggle, L2/L3 default, per-site enable (requests the host permission just-in-time), quick-open box |

UX patterns follow IPFS Companion: interception is a global toggle, page
integration is opt-in per site with a just-in-time permission grant, and the
address-bar keyword is the always-available path.

## Trust model

- esplora responses are UNTRUSTED inputs; everything is re-verified
  client-side (`@ordspv/fetch` browser bundle; header anchoring via
  compiled checkpoints + M-of-N hash-at-height).
- The viewer renders from verified bytes only; verification failure shows the
  error and renders nothing.
- HTML inscriptions render in a sandboxed, opaque-origin iframe. Recursive
  inscriptions (`/content/…`, `/r/…` references) have no origin to resolve
  against inside the viewer. Standalone HTML works; recursive HTML needs a
  gateway (documented limitation).
- Brotli-encoded bodies (tag 9 `br`) can't be decoded by `DecompressionStream`;
  the viewer offers the verified stored bytes as a download instead
  (gzip/deflate decode fine).

## Development

- sources in `src/` (`urlmap.ts` is pure and unit-tested at
  `extension/test/urlmap.test.ts`, run by the repo's vitest)
- `npx tsx scripts/build-extension.ts` rebuilds `dist-unpacked/` (unminified,
  reviewable)
- canonical repo: github.com/ordspv/ordspv
