# ORD-GW-1: HTTP gateway surface for ord: resolution

Status: draft v0.1 · 2026-07-11
Companion: [SPEC-URI.md](./SPEC-URI.md), [SPEC-VERIFICATION.md](./SPEC-VERIFICATION.md)
Reference implementation: `@ord-resolver/gateway`

A gateway is an HTTP server that makes `ord:` URIs consumable by software that only
speaks HTTPS (browsers, marketplaces, `tokenURI` pipelines). The design premise —
borrowed from IPFS's trustless-gateway split — is that **gateways provide availability,
not truth**: anything a gateway serves is either re-verifiable by the client
(proof bundles) or verified by the gateway itself with attestation headers, and the
client's trust dial is explicit.

## 1. URI ↔ URL mapping

For gateway origin `G`:

| URI form | URL |
|---|---|
| `ord:<id>` | `G/r/undelegated-content/<id>` |
| `ord:<id>/content` | `G/content/<id>` |
| `ord:<id>/metadata` | `G/r/metadata/<id>` |
| proof acquisition | `G/ord/v1/proof/<id>?level=l2\|l3` |
| gateway-verified content | `G/ord/v1/verified/<id>` |

Integrity fragments never reach the gateway (fragments are client-side).

## 2. Personalities

- **proxy** — replicates an upstream ord server's `/content` and `/r/*` surface with
  ord-parity headers (§4). Adds availability/fan-out; adds no trust. MUST NOT emit
  `x-ord-verification`.
- **verify** — serves `/content/<id>` only after locally verifying the bytes against
  Bitcoin at L2+ via configured esplora/electrum backends. A compromised upstream
  cannot make a verify-gateway serve forged bytes. MUST emit attestation headers (§5).

Both personalities MUST serve `/ord/v1/proof` (§3) if they advertise this spec.

## 3. Proof endpoint

```
GET /ord/v1/proof/<inscription-id>?level=l2|l3
→ 200 application/vnd.ord.proof+json; version=1   (SPEC-VERIFICATION §3)
```

- Default level: `l2`. Bundles MUST verify under SPEC-VERIFICATION before being served
  (a gateway MUST NOT relay bundles it cannot verify).
- Responses are immutable: `Cache-Control: public, max-age=1209600, immutable` (SHOULD
  be cached aggressively; CDN-friendly by construction).
- Errors: `400` malformed id; `404` unknown inscription; `502` upstream data
  unavailable. Error bodies are JSON `{ "error": string }`.
- This endpoint is the ecosystem patch for the wtxid-proof hole (no public chain API
  serves witness-tree branches): one ~1.3 KB response replaces a ~1.6 MB block
  download for L3 clients.

## 4. ord-parity response headers (`/content/<id>`)

To keep recursive/HTML inscriptions working identically to ord (research §2), content
responses MUST include:

- `Content-Type` from the (effective) envelope, falling back to
  `application/octet-stream`;
- `Content-Encoding` when serving stored encoded bytes and the request's
  `Accept-Encoding` admits it; a gateway MAY decompress `br` server-side (ord
  `--decompress` parity) and otherwise MUST return `406`;
- `Cache-Control: public, max-age=1209600, immutable`;
- both ord CSP headers:
  `default-src 'self' 'unsafe-eval' 'unsafe-inline' data: blob:` and
  `default-src *:*/content/ *:*/blockheight *:*/blockhash *:*/blockhash/ *:*/blocktime *:*/r/ 'unsafe-eval' 'unsafe-inline' data: blob:`
  (single `--csp-origin`-style header when the gateway knows its canonical origin);
- `Access-Control-Allow-Origin: *`.

Divergence from ord (deliberate, safe): gateways SHOULD add
`X-Content-Type-Options: nosniff` (ord sets none).

Root-relative recursion (`/content/…`, `/r/…`) inside HTML inscriptions requires the
gateway to answer those paths on the same origin — hence §6. Deployments hosting
untrusted HTML SHOULD consider per-inscription origin isolation (subdomain-per-id, the
IPFS subdomain-gateway lesson); specifying that scheme is future work.

## 5. Attestation headers (verify personality and `/ord/v1/verified`)

```
x-ord-verification: L2|L3
x-ord-block:        <display block hash>
x-ord-height:       <height>
x-ord-body-sha256:  <hex sha256 of stored body bytes>
x-ord-delegate:     <delegate id, when content came via delegation>
```

Attestation headers are claims by the gateway, useful for monitoring and debugging;
clients with adversarial gateways in their threat model MUST ignore them and verify
proof bundles themselves. `x-ord-body-sha256` doubles as the value producers should pin
in `#integrity=` fragments.

## 6. Recursion endpoint tiers

A gateway exposing `/r/*` MUST document, per endpoint, which tier it serves:

- **Tier A — chain-derivable (trustless-capable):** `/r/blockhash[/h]`,
  `/r/blockheight`, `/r/blocktime`, `/r/tx/<txid>`, `/r/undelegated-content/<id>`,
  `/content/<id>`, `/r/metadata/<id>` — computable from headers + raw transactions;
  a verify-gateway SHOULD serve these from chain data.
- **Tier B — index-dependent:** `/r/inscription/<id>` (number, sat, charms…),
  `/r/children/*`, `/r/parents/*` (reverse edges / location validation),
  `/r/sat/*`, `/r/utxo/*` — require an ord index; responses are trusted-index claims
  and MUST NOT carry `x-ord-verification`.

Recursive inscriptions consuming Tier B data are only as trustless as the index behind
the gateway; this boundary is protocol-inherent (research §2), not a gateway defect.

## 7. Operational notes (non-normative)

The reference implementation is single-file Node with no rate limiting, caching, or
TLS; production deployments front it with a CDN (every 200 here is immutable) and add
per-IP limits — recall that hotlinking pressure is what took ordinals.com down
(ord#3873). A gateway with `GATEWAY_MODE=verify` plus `ESPLORA=` pointing at two
operator-diverse instances is the minimum trust-minimized deployment; self-hosted
`electrs` + `ord --index-transactions` removes third parties entirely.
