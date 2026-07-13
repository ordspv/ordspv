# Security policy

## Supported versions

| Version | Supported            |
| ------- | -------------------- |
| 0.2.x   | :white_check_mark:   |
| < 0.2.0 | :x:                  |

Security fixes land on the 0.2.x line. Users on 0.1.x should upgrade; those
releases are deprecated on npm and will not receive fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to the **Security** tab of https://github.com/ordspv/ordspv
2. Click **Report a vulnerability**
3. Fill in what you found, how to reproduce it, and the impact you see

This routes the report to the maintainers privately and lets us collaborate on
a fix and a coordinated release before any details are public.

If GitHub private reporting is unavailable to you, open a regular issue that
says only "security report — please enable a private channel" with **no
technical detail**, and we will follow up.

## What to include

- Affected package(s) and version(s) (`@ordspv/core`, `@ordspv/fetch`,
  `@ordspv/gateway`, `@ordspv/cli`, `@ordspv/proof-sidecar`)
- A minimal reproduction (an inscription id, a crafted proof bundle, a request
  sequence, or a short script)
- The security property you believe is broken. This project's core claim is
  that resolved bytes are bound to Bitcoin proof-of-work; reports showing a
  path to **forged content accepted as verified**, a bypass of header
  anchoring, or a resource-exhaustion denial of service are especially valuable

## Coordinated disclosure

We ask for coordinated disclosure: give us a reasonable window to ship a fix
and publish patched packages before public write-ups. We will keep you updated
on progress, credit you in the release notes if you wish, and coordinate timing
with you. We aim to acknowledge a report within a few days.

## Scope

In scope: the published `@ordspv/*` packages and this repository's code.

Out of scope: vulnerabilities in third-party services this software can talk to
(esplora instances, ord servers, Electrum servers, Bitcoin Core). Those
backends are treated as **untrusted** by design — reports that assume a
malicious backend and show it defeating verification ARE in scope; reports that
a backend is merely unavailable or serves bad data that we correctly reject are
not.

## Trust model, in brief

- Backends (esplora, ord gateways, Electrum, Core RPC) are untrusted for
  soundness; they are relied on only for availability.
- Content bytes are verified against block header proof-of-work via merkle and
  (at L3) witness-commitment proofs.
- Header anchoring is fail-closed: a block that cannot be tied to a checkpoint,
  a locally synced header chain, or enough independent sources is rejected, not
  served.
- TLS on the Electrum transport is transport hygiene, not the trust anchor; the
  header validation is what makes a sync sound.
