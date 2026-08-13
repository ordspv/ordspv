/**
 * Does the gateway's relay path carry the guarantee the spec requires of it?
 *
 * docs/spec/SPEC-GATEWAY.md:46-47, normative:
 *
 *     Default level: `l2`. Bundles MUST verify under SPEC-VERIFICATION before
 *     being served (a gateway MUST NOT relay bundles it cannot verify).
 *
 * These began as regression tests for three 0.3.0 defects, and each one failed
 * against the code that shipped:
 *
 *   1. the proof branch built a bundle and sent it, with no verification step
 *      between, and `verifyProofBundle` was not imported anywhere in
 *      packages/gateway/src. The sidecar had it right at
 *      packages/sidecar/src/index.ts, under the comment "never relay a bundle
 *      we cannot verify".
 *   2. an unrecognised mode string fell through to the proxy branch while
 *      /healthz echoed it back, so `GATEWAY_MODE=Verify` served unverified
 *      bytes and reported "Verify" as apparent confirmation.
 *   3. `isInscriptionId` accepted an index `parseInscriptionId` rejected, so a
 *      malformed id passed the 400 gate and surfaced as a 502.
 *
 * The upstream is made to misbehave in the mildest realistic way: one endpoint
 * answers HTTP 200 with a body that is not a block header. No malice and no
 * network position is required, since a CDN error page or a truncated response
 * produces it. What `verifyProofBundle` threw on that body was
 * `hex length must be even, got 41`, the length of the HTML below.
 */

import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyProofBundle, type ProofBundleJson } from '@ordspv/core';
import type { FetchFn } from '@ordspv/fetch';
import { createGateway, gatewayOptionsFromEnv, normalizeMode } from '../src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insc0');
const read = (f: string) => readFileSync(join(FIXTURES, f), 'utf8').trim();

const INSC0 = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
const REVEAL = INSC0.slice(0, 64);
const COMMIT = '274bda6667e60bedede0d87f351220da4089427e6122f7d0bbd8e662b3796358';
const BLOCK = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';
const E = 'https://esplora.test';
const U = 'https://upstream.test';

/** An HTTP 200 whose body is an error page where a block header belongs. */
const CDN_ERROR_PAGE = () =>
  new Response('<html><body>502 Bad Gateway</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

/** Everything honest except the block header endpoint. */
function routesWithHeader(headerBody: () => Response): Record<string, () => Response> {
  return {
    [`${E}/tx/${REVEAL}/status`]: () =>
      Response.json({ confirmed: true, block_height: 767430, block_hash: BLOCK }),
    [`${E}/tx/${REVEAL}/hex`]: () => new Response(read('reveal.hex')),
    [`${E}/tx/${REVEAL}/merkle-proof`]: () => new Response(read('merkle-proof.json')),
    [`${E}/block/${BLOCK}/header`]: headerBody,
    [`${E}/block/${BLOCK}`]: () => Response.json({ id: BLOCK, height: 767430, tx_count: 2332 }),
    [`${E}/tx/${COMMIT}/hex`]: () => new Response(read('commit.hex')),
    [`${U}/r/blockheight`]: () => new Response('767430', { headers: { 'content-type': 'text/plain' } }),
  };
}

/** A gateway over a stub fetch, on an ephemeral port. */
function gatewayOver(routes: Record<string, () => Response>, mode: 'proxy' | 'verify') {
  const stub: FetchFn = async (url) =>
    routes[url as string]?.() ?? new Response(`no stub: ${url}`, { status: 404 });
  return createGateway({ upstream: U, esplora: [E], mode, fetchFn: stub });
}

/** Listen on an ephemeral port for the life of one describe block. */
function serve(server: ReturnType<typeof createGateway>): () => string {
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return () => base;
}

/** Is this response a spec-compliant answer to a proof request? */
async function isSpecCompliant(res: Response): Promise<{ ok: boolean; why: string }> {
  if (res.status !== 200) {
    return { ok: true, why: `refused with ${res.status}, which SPEC-GATEWAY §3 allows` };
  }
  let bundle: ProofBundleJson;
  try {
    bundle = (await res.json()) as ProofBundleJson;
  } catch (e) {
    return { ok: false, why: `served 200 with a body that is not JSON: ${(e as Error).message}` };
  }
  try {
    verifyProofBundle(bundle);
    return { ok: true, why: 'served 200 with a bundle that verifies' };
  } catch (e) {
    return {
      ok: false,
      why: `served 200 with a bundle that does NOT verify: verifyProofBundle threw ` +
           `"${(e as Error).message}"`,
    };
  }
}

for (const mode of ['proxy', 'verify'] as const) {
  describe(`gateway proof endpoint in ${mode} mode`, () => {
    // Both modes are covered because the proof branch returns above the mode
    // check, so /ord/v1/proof is byte-identical in the two personalities.
    const base = serve(gatewayOver(routesWithHeader(CDN_ERROR_PAGE), mode));

    it('MUST NOT relay a bundle it cannot verify (SPEC-GATEWAY §3)', async () => {
      const res = await fetch(`${base()}/ord/v1/proof/${INSC0}?level=l2`);
      const verdict = await isSpecCompliant(res);
      expect(verdict.ok, `SPEC-GATEWAY.md:46 requires a gateway not to relay an ` +
                         `unverifiable bundle. This gateway ${verdict.why}.`).toBe(true);
    });

    it('an unverifiable bundle MUST NOT be served as immutable and cacheable', async () => {
      // Compounding: sendCached writes the body into the LRU before sending,
      // and the cache lookup runs ahead of the proof branch. One bad upstream
      // answer served here would reach every later caller until eviction,
      // under `cache-control: public, max-age=1209600, immutable`.
      const res = await fetch(`${base()}/ord/v1/proof/${INSC0}?level=l2`);
      if (res.status !== 200) return;                    // refused: nothing to cache
      const cacheControl = res.headers.get('cache-control') ?? '';
      const verdict = await isSpecCompliant(res);
      expect(
        verdict.ok || !cacheControl.includes('immutable'),
        `an unverifiable bundle was served with cache-control: ${cacheControl}`,
      ).toBe(true);
    });
  });
}

describe('gateway proof endpoint, refusal and the LRU', () => {
  // The refusal must leave the cache untouched. Asserted by repairing the
  // upstream and asking again on the same key: a cached refusal, or a cached
  // unverifiable bundle, would still be answered from the LRU and the second
  // request would not reach the repaired backend.
  let broken = true;
  const server = gatewayOver(
    routesWithHeader(() => (broken ? CDN_ERROR_PAGE() : new Response(read('header-767430.hex')))),
    'proxy',
  );
  const base = serve(server);

  it('a refused proof request leaves no LRU entry behind', async () => {
    const first = await fetch(`${base()}/ord/v1/proof/${INSC0}?level=l2`);
    expect(first.status, 'the unverifiable bundle must be refused').toBe(502);
    expect(await first.text()).toContain('hex length must be even');

    broken = false;
    const second = await fetch(`${base()}/ord/v1/proof/${INSC0}?level=l2`);
    expect(second.status, 'the repaired upstream must be reachable on the same key').toBe(200);
    expect(second.headers.get('x-cache'), 'a MISS proves nothing was cached by the refusal')
      .toBe('MISS');
    const verdict = await isSpecCompliant(second);
    expect(verdict.ok, verdict.why).toBe(true);

    const third = await fetch(`${base()}/ord/v1/proof/${INSC0}?level=l2`);
    expect(third.headers.get('x-cache'), 'the bundle that did verify is cached').toBe('HIT');
  });
});

describe('gateway proof endpoint, malformed inscription id', () => {
  // The wire-level consequence of the isInscriptionId / parseInscriptionId
  // disagreement (see packages/core/test/identity.props.test.ts). The id used
  // to pass the 400 gate and throw in the work behind it, so the catch answered
  // 502 and incremented mUpstreamErrors, the counter an operator reads to
  // detect an upstream problem. SPEC-GATEWAY.md:50 assigns 400 to a malformed
  // id and 502 to upstream data being unavailable; no upstream is contacted here.
  const base = serve(gatewayOver(routesWithHeader(() => new Response(read('header-767430.hex'))), 'proxy'));

  // `i4294967296` is one past the 32-bit ceiling. The long digit run passes the
  // grammar, `Number()` returns Infinity, and `Number.isSafeInteger(Infinity)`
  // is false, so it is the same defect reached by a different arithmetic.
  const MALFORMED = [
    ['an index above 2^32-1', `${REVEAL}i4294967296`],
    ['an index of 40 digits', `${REVEAL}i${'9'.repeat(40)}`],
  ] as const;

  for (const [label, id] of MALFORMED) {
    it(`answers 400 for ${label} on /ord/v1/proof, not 502`, async () => {
      const res = await fetch(`${base()}/ord/v1/proof/${id}`);
      const body = await res.text();
      expect(res.status, `SPEC-GATEWAY.md:50 assigns 400 to a malformed id. Got ${res.status}: ${body}`)
        .toBe(400);
      expect(body, 'the 400 names the reason rather than repeating the input')
        .toContain('inscription index out of range');
    });

    it(`answers 400 for ${label} on /ord/v1/verified too`, async () => {
      // A different code path: this throw arrives from packages/fetch/src/uri.ts
      // by way of resolver.resolve and never passes through tryBackends.
      const res = await fetch(`${base()}/ord/v1/verified/${id}`);
      const body = await res.text();
      expect(res.status, `same gate, different branch. Got ${res.status}: ${body}`).toBe(400);
      expect(body).toContain('inscription index out of range');
    });
  }

  it('the metrics counter for upstream errors is untouched by a malformed id', async () => {
    // mUpstreamErrors is what an operator alerts on. A malformed request
    // inflating it points the investigation at the backends.
    await fetch(`${base()}/ord/v1/proof/${REVEAL}i4294967296`);
    const metrics = await (await fetch(`${base()}/metrics`)).text();
    const line = metrics.split('\n').find((l) => l.startsWith('gateway_upstream_errors_total'));
    expect(line, 'the counter must still read zero').toMatch(/\s0$/);
  });
});

describe('gateway mode selection', () => {
  // Two layers, both of which were defective. This one is the options
  // boundary: createGateway's own `mode` is compared with === 'verify', so an
  // unrecognised spelling served proxy bytes while /healthz reported the
  // string back. A library caller casting past the type reaches it too, which
  // is why the normalisation lives here and not at the environment read.
  const base = serve(gatewayOver(routesWithHeader(() => new Response(read('header-767430.hex'))),
                                 'Verify' as unknown as 'verify'));

  it('an unrecognised mode string is normalised, and never reported as verifying', async () => {
    const reported = (await (await fetch(`${base()}/healthz`)).json()).mode;
    expect(
      reported === 'proxy' || reported === 'verify',
      `/healthz reports mode ${JSON.stringify(reported)}, which is neither 'proxy' nor 'verify'. ` +
      `The comparison that selects the verifying branch is === 'verify', so this instance ` +
      `serves unverified proxy bytes while advertising ${JSON.stringify(reported)}.`,
    ).toBe(true);
    expect(reported, 'an unrecognised mode falls back to the personality that claims least')
      .toBe('proxy');
  });

  it('/healthz reports the resolved verification level too', async () => {
    const health = await (await fetch(`${base()}/healthz`)).json();
    expect(health.verification).toBe('L2');
  });
});

/** which option each environment count lands in */
const optionFor = {
  RATE_LIMIT: 'rateLimitPerSec',
  RATE_BURST: 'rateBurst',
  CACHE_MAX_BYTES: 'cacheMaxBytes',
  CACHE_MAX_ENTRY_BYTES: 'cacheMaxEntryBytes',
  UPSTREAM_TIMEOUT_MS: 'upstreamTimeoutMs',
  TRUST_PROXY: 'trustProxy',
} as const;

describe('gateway configuration read from the environment', () => {
  // The second layer. GATEWAY_MODE reached the options through an `as` cast
  // that is erased at runtime, and every count reached them through a bare
  // Number(), whose NaN result `??` does not catch.
  it('an unrecognised GATEWAY_MODE resolves to proxy, not to the string supplied', () => {
    expect(gatewayOptionsFromEnv({ GATEWAY_MODE: 'Verify' }).mode).toBe('proxy');
    expect(gatewayOptionsFromEnv({ GATEWAY_MODE: 'VERIFY' }).mode).toBe('proxy');
    expect(gatewayOptionsFromEnv({ GATEWAY_MODE: '' }).mode).toBe('proxy');
    expect(gatewayOptionsFromEnv({}).mode).toBe('proxy');
    expect(gatewayOptionsFromEnv({ GATEWAY_MODE: 'verify' }).mode).toBe('verify');
    expect(normalizeMode(undefined)).toBe('proxy');
    expect(normalizeMode('verify')).toBe('verify');
  });

  it('an unreadable count does not silently disable the protection it governs', () => {
    // undefined means "the option default applies". NaN would mean the
    // opposite: every guard downstream is a `> 0` test that NaN fails.
    for (const name of ['RATE_LIMIT', 'CACHE_MAX_BYTES', 'CACHE_MAX_ENTRY_BYTES', 'RATE_BURST',
                        'UPSTREAM_TIMEOUT_MS', 'TRUST_PROXY'] as const) {
      for (const bad of ['abc', '', '  ', '-1', 'NaN', 'Infinity']) {
        const options = gatewayOptionsFromEnv({ [name]: bad }) as Record<string, unknown>;
        expect(options[optionFor[name]], `${name}=${JSON.stringify(bad)}`).toBeUndefined();
      }
    }
    expect(gatewayOptionsFromEnv({ PORT: 'abc' }).port, 'an unreadable PORT falls back to 8317')
      .toBe(8317);
  });

  it('POW_LIMIT_BITS reaches the floor, in hex, in decimal, and switched off', () => {
    // deploy/docker-compose.yml runs the reference gateway on signet, whose
    // powLimit target is easier than mainnet's. With no reach from the
    // environment that deployment refused every header it was served.
    expect(gatewayOptionsFromEnv({}).powLimitBits, 'unset means the mainnet default')
      .toBeUndefined();
    expect(gatewayOptionsFromEnv({ POW_LIMIT_BITS: '0x1e0377ae' }).powLimitBits).toBe(0x1e0377ae);
    expect(gatewayOptionsFromEnv({ POW_LIMIT_BITS: '503543726' }).powLimitBits).toBe(0x1e0377ae);
    expect(gatewayOptionsFromEnv({ POW_LIMIT_BITS: 'off' }).powLimitBits, 'null disables the floor')
      .toBeNull();
    expect(gatewayOptionsFromEnv({ POW_LIMIT_BITS: 'OFF' }).powLimitBits).toBeNull();
    for (const bad of ['abc', '1.5', '-1', 'NaN']) {
      expect(gatewayOptionsFromEnv({ POW_LIMIT_BITS: bad }).powLimitBits, bad).toBeUndefined();
    }
  });

  it('CHECKPOINTS reaches the set, switched off, and as pairs', () => {
    // the same shape of problem as POW_LIMIT_BITS, one layer up: the compiled-in
    // checkpoints are mainnet hashes, so a gateway on another chain that reaches
    // a checkpointed height would refuse every honest bundle its own node served
    expect(gatewayOptionsFromEnv({}).checkpoints, 'unset means the mainnet set')
      .toBeUndefined();
    expect(gatewayOptionsFromEnv({ CHECKPOINTS: 'off' }).checkpoints, 'the signet setting')
      .toEqual(new Map());
    expect(gatewayOptionsFromEnv({ CHECKPOINTS: 'OFF' }).checkpoints).toEqual(new Map());

    const hash = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';
    const other = `${'ab'.repeat(22)}00000000000000000000`;
    expect(gatewayOptionsFromEnv({ CHECKPOINTS: `767430:${hash}` }).checkpoints)
      .toEqual(new Map([[767430, hash]]));
    expect(
      gatewayOptionsFromEnv({ CHECKPOINTS: ` 767430:${hash.toUpperCase()} , 800000:${other} ` })
        .checkpoints,
      'whitespace trimmed and hashes folded, so a pasted set reads the same either way',
    ).toEqual(
      new Map([
        [767430, hash],
        [800000, other],
      ]),
    );

    // an unreadable entry lands the WHOLE variable on the default: half a
    // checkpoint set is a weaker chain view than either the operator's or ours
    for (const bad of [
      '767430',
      `:${hash}`,
      `767430:${hash.slice(0, 63)}`,
      `abc:${hash}`,
      `-1:${hash}`,
      `1.5:${hash}`,
      `767430:${hash},garbage`,
    ]) {
      expect(gatewayOptionsFromEnv({ CHECKPOINTS: bad }).checkpoints, bad).toBeUndefined();
    }
  });

  it('a readable count is passed through, zero included', () => {
    expect(gatewayOptionsFromEnv({ RATE_LIMIT: '25' }).rateLimitPerSec).toBe(25);
    expect(gatewayOptionsFromEnv({ RATE_LIMIT: '0' }).rateLimitPerSec, 'zero disables by design')
      .toBe(0);
    expect(gatewayOptionsFromEnv({ CACHE_MAX_BYTES: '268435456' }).cacheMaxBytes).toBe(268435456);
    expect(gatewayOptionsFromEnv({ PORT: '9000' }).port).toBe(9000);
    expect(gatewayOptionsFromEnv({ GATEWAY_LEVEL: 'L3' }).verification).toBe('L3');
    expect(gatewayOptionsFromEnv({ ESPLORA: 'a,b' }).esplora).toEqual(['a', 'b']);
  });
});

describe('gateway proof endpoint, the powLimitBits floor', () => {
  // The floor is what makes a fabricated header cost anything, and the gateway
  // was the only one of the three services that could not set it. The fixture
  // block declares bits 0x17083830, so a floor of 0x1703a30c is harder than the
  // block's own target: an honest header refused by an unreachable option
  // cannot be the explanation, so a refusal here proves the option arrived.
  const routes = routesWithHeader(() => new Response(read('header-767430.hex')));
  const stub: FetchFn = async (url) =>
    routes[url as string]?.() ?? new Response(`no stub: ${url}`, { status: 404 });
  const mainnet = serve(
    createGateway({ upstream: U, esplora: [E], mode: 'proxy', fetchFn: stub, powLimitBits: 0x1d00ffff }),
  );
  const strict = serve(
    createGateway({ upstream: U, esplora: [E], mode: 'proxy', fetchFn: stub, powLimitBits: 0x1703a30c }),
  );

  it('serves the bundle when the header meets the configured floor', async () => {
    const res = await fetch(`${mainnet()}/ord/v1/proof/${INSC0}?level=l2`);
    expect(res.status).toBe(200);
    const verdict = await isSpecCompliant(res);
    expect(verdict.ok, verdict.why).toBe(true);
  });

  it('reaches the bundle verification: a header under the floor is refused', async () => {
    const res = await fetch(`${strict()}/ord/v1/proof/${INSC0}?level=l2`);
    expect(res.status, 'powLimitBits must reach the verification step').toBe(502);
    expect(await res.text()).toContain('proof-of-work limit');
  });

  it('reaches the resolver: /ord/v1/verified refuses under the same floor', async () => {
    const res = await fetch(`${strict()}/ord/v1/verified/${INSC0}`);
    expect(res.status, 'powLimitBits must reach OrdResolver too').toBe(502);
    expect(await res.text()).toContain('proof-of-work limit');
  });
});

describe('gateway proof endpoint, honest upstream', () => {
  // The control. If this fails, the harness is wrong and the tests above prove
  // nothing, so it is asserted explicitly rather than assumed.
  const base = serve(gatewayOver(routesWithHeader(() => new Response(read('header-767430.hex'))), 'proxy'));

  it('serves a bundle that verifies when the upstream is honest', async () => {
    const res = await fetch(`${base()}/ord/v1/proof/${INSC0}?level=l2`);
    expect(res.status).toBe(200);
    const verdict = await isSpecCompliant(res);
    expect(verdict.ok, verdict.why).toBe(true);
  });
});
