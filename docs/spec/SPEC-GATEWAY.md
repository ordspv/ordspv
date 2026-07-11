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

**`Content-Encoding` is ambiguous through CDNs.** Transport compression applied by
CDNs/reverse proxies — and transparently removed by HTTP clients — is
indistinguishable on the wire from the inscription's stored tag-9 encoding:
`content-encoding: br` may mean "an intermediary compressed this response" or "the
stored bytes are brotli", and intermediaries may stack, strip, or rewrite the header.
(Observed in the wild: ordinals.com behind Cloudflare serves *unencoded* text
inscriptions with `content-encoding: br`.) Therefore:

- Consumers MUST determine an inscription's encoding from the envelope parse
  (tag 9) — via a proof bundle, their own reveal-tx parse, or the
  `x-ord-content-encoding` attestation header (§5) — and MUST NOT infer it from
  `Content-Encoding` or any other transport header.
- Gateways SHOULD emit `x-ord-content-encoding: <tag-9 value>` (§5) whenever the
  envelope declares an encoding, sourced from the envelope parse and never copied
  from an upstream response header.
- Integrity pins (`#integrity=`) hash STORED bytes, so on encoded inscriptions they
  cannot be evaluated against a transport-decoded body; clients seeing this
  combination fall back to L2+ verification (the resolver's
  `INTEGRITY_INDETERMINATE` behavior).

Root-relative recursion (`/content/…`, `/r/…`) inside HTML inscriptions requires the
gateway to answer those paths on the same origin — hence §6. Deployments hosting
untrusted HTML SHOULD consider per-inscription origin isolation (subdomain-per-id, the
IPFS subdomain-gateway lesson); specifying that scheme is future work.

## 5. Attestation headers (verify personality and `/ord/v1/verified`)

```
x-ord-verification:      L2|L3
x-ord-block:             <display block hash>
x-ord-height:            <height>
x-ord-body-sha256:       <hex sha256 of stored body bytes>
x-ord-delegate:          <delegate id, when content came via delegation>
x-ord-content-encoding:  <tag-9 value, when the served envelope declares one>
```

`x-ord-content-encoding` is the unambiguous channel for the stored encoding (§4:
transport `Content-Encoding` is CDN-ambiguous). It MUST be sourced from the
gateway's own envelope parse of the verified reveal tx — never copied from an
upstream response — and reflects the SERVED source (the delegate's envelope when
content came via delegation). It is emitted even when the gateway decompressed the
body server-side, so clients can always recover what the on-chain bytes are.

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

The reference implementation ships the production basics; fronting with a CDN
remains recommended (every 200 here is immutable) — recall that hotlinking pressure
is what took ordinals.com down (ord#3873).

- **Caching**: in-process byte-budgeted LRU over immutable 200s
  (`CACHE_MAX_BYTES`, default 256 MiB; per-entry cap `CACHE_MAX_ENTRY_BYTES`,
  8 MiB). Responses carry `x-cache: HIT|MISS`. Immutability makes eviction the
  only invalidation concern.
- **Streaming vs buffering**: proxy passthrough streams bodies above the
  per-entry cap. VERIFIED responses are buffered by necessity — a merkle proof
  cannot be checked over bytes not yet read; verify-personality memory scales
  with the largest inscription served, bounded by the tx-size consensus limit.
- **Rate limiting**: per-IP token bucket (`RATE_LIMIT` sustained rps, default 10;
  `RATE_BURST`, default 40) with `429` + `retry-after`; `/healthz` and `/metrics`
  exempt. `TRUST_PROXY=1` keys on the first `X-Forwarded-For` hop instead of the
  socket address — only set it behind infrastructure you control.
- **Observability**: one JSON log line per request (ip, route, status, ms,
  cache) and Prometheus text at `/metrics` (`gateway_http_requests_total`,
  latency histogram by route label, cache hit/miss counters, rate-limit
  counter, cache/limiter gauges). Route labels are collapsed
  (`/content/:id`, `/r/*`) to keep cardinality flat.
- **Shutdown**: SIGTERM/SIGINT stops accepting, drains in-flight connections,
  force-closes after a 10 s grace.
- **Reference deployment**: `deploy/Dockerfile` + `deploy/docker-compose.yml`
  wire bitcoind → electrs (esplora HTTP API) → verify-gateway, defaulting to
  signet for tryability; mainnet electrs needs ~1 TB and days to index. A
  gateway with `GATEWAY_MODE=verify` plus `ESPLORA=` pointing at two
  operator-diverse instances is the minimum trust-minimized deployment;
  self-hosted `electrs` + `ord --index-transactions` removes third parties
  entirely.
