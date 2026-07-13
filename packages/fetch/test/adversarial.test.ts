import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  buildMerkleBranch,
  computeMerkleRoot,
  hexToBytes,
  internalToDisplay,
  parseHeader,
  serializeBlock,
  tapLeafHash,
  type ParsedTx,
} from '@ordspv/core';
import { OrdResolver, OrdResolveError } from '../src/index.js';
import type { FetchFn } from '../src/backends.js';
import {
  buildBlock,
  commitTx,
  envelopeScript,
  revealTx,
  taprootCommit,
  type TestBlock,
} from '../../core/test/helpers.js';

/**
 * Failure-injection suite: the REAL resolver driven against a mock hostile
 * backend. Every case must reject or bound the attack — never surface forged
 * content as verified. Synthetic blocks are mined at regtest difficulty, so
 * the mainnet powLimit floor is disabled (powLimitBits: null); a dedicated
 * case below re-enables it to prove the floor rejects a too-easy header.
 */

const E = 'https://esplora.test';
const E2 = 'https://esplora2.test';

type Route = string | Uint8Array | object | (() => Promise<Response> | Response);

function stubFetch(routes: Record<string, Route>): FetchFn {
  return async (url: string) => {
    const route = routes[url];
    if (route === undefined) return new Response(`no stub for ${url}`, { status: 404 });
    if (typeof route === 'function') return route();
    if (route instanceof Uint8Array) return new Response(route.slice());
    if (typeof route === 'string') return new Response(route);
    return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
  };
}

/** esplora routes for a synthetic block; both E and E2 attest the height */
function routesForBlock(block: TestBlock, height: number): Record<string, Route> {
  const routes: Record<string, Route> = {
    [`${E}/block/${block.blockHash}/header`]: block.headerHex.trim(),
    [`${E}/block/${block.blockHash}`]: { id: block.blockHash, height, tx_count: block.txCount },
    [`${E}/block-height/${height}`]: block.blockHash,
    [`${E}/blocks/tip/height`]: String(height + 10),
    [`${E2}/block-height/${height}`]: block.blockHash,
    [`${E2}/blocks/tip/height`]: String(height + 10),
    [`${E}/block/${block.blockHash}/raw`]: serializeBlock(hexToBytes(block.headerHex), block.txs),
  };
  const txids = block.txs.map((t) => t.txidLE);
  block.txs.forEach((tx, pos) => {
    routes[`${E}/tx/${tx.txid}/status`] = { confirmed: true, block_height: height, block_hash: block.blockHash };
    routes[`${E}/tx/${tx.txid}/hex`] = bytesToHex(tx.raw);
    routes[`${E}/tx/${tx.txid}/merkle-proof`] = {
      block_height: height,
      merkle: buildMerkleBranch(txids, pos).map(internalToDisplay),
      pos,
    };
  });
  return routes;
}

function newResolver(routes: Record<string, Route>, extra = {}) {
  return new OrdResolver({ esplora: [E, E2], fetchFn: stubFetch(routes), powLimitBits: null, ...extra });
}

/** a standard single-inscription reveal + its funding commit, in one block */
function inscriptionInBlock(body: string, height = 100) {
  const script = envelopeScript({ fields: [[1, 'text/plain']], body: [body] }, { checksigPrefix: true });
  const tap = taprootCommit(script);
  const commit = commitTx(tap.scriptPubKey);
  const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
    prevTxidLE: commit.txidLE,
    vout: 0,
  });
  const block = buildBlock([reveal]);
  const routes = routesForBlock(block, height);
  routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
  return { script, tap, commit, reveal, block, routes, id: `${reveal.txid}i0` };
}

describe('adversarial: forged low-difficulty header + matching merkle', () => {
  it('rejects a header easier than the mainnet powLimit even with a valid merkle proof', async () => {
    // build a fully self-consistent synthetic block (merkle proof folds to the
    // header) but present it at a mainnet height with the powLimit ENABLED.
    const { block, routes, id } = inscriptionInBlock('forged', 800000);
    const header = parseHeader(hexToBytes(block.headerHex));
    // sanity: the regtest header would never satisfy mainnet difficulty
    expect(header.bits).toBe(0x207fffff);
    const resolver = new OrdResolver({
      esplora: [E, E2],
      fetchFn: stubFetch(routes),
      checkpoints: new Map(), // no checkpoint to lean on
      // powLimitBits left at the mainnet default: the floor must catch this
    });
    await expect(resolver.resolve(`ord:${id}`)).rejects.toMatchObject({ code: 'HEADER_TRUST' });
    await expect(resolver.resolve(`ord:${id}`)).rejects.toThrow(/proof-of-work limit/);
  });

  it('rejects a merkle proof that does not fold to the header root', async () => {
    const { block, routes, id, reveal } = inscriptionInBlock('tamper');
    // replace the merkle branch with a bogus sibling: root will not match
    routes[`${E}/tx/${reveal.txid}/merkle-proof`] = {
      block_height: 100,
      merkle: [internalToDisplay(new Uint8Array(32).fill(0xab))],
      pos: 1,
    };
    const resolver = newResolver(routes);
    await expect(resolver.resolve(`ord:${id}`)).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });
});

describe('adversarial: witness-swap forgery', () => {
  it('L2 surfaces the multi-leaf assurance; L3 rejects the swapped witness', async () => {
    // one commit tree with two envelope leaves; reveal A indexed, B served
    const scriptA = envelopeScript({ fields: [[1, 'text/plain']], body: ['real'] }, { checksigPrefix: true });
    const scriptB = envelopeScript({ fields: [[1, 'text/plain']], body: ['forged'] }, { checksigPrefix: true });
    const leafA = tapLeafHash(scriptA, 0xc0);
    const leafB = tapLeafHash(scriptB, 0xc0);
    const commitA = taprootCommit(scriptA, [leafB]);
    const commitB = taprootCommit(scriptB, [leafA]);
    expect(bytesToHex(commitA.scriptPubKey)).toBe(bytesToHex(commitB.scriptPubKey));

    const commit = commitTx(commitA.scriptPubKey);
    const revealA = revealTx([{ script: scriptA, controlBlock: commitA.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    const revealB = revealTx([{ script: scriptB, controlBlock: commitB.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    expect(revealB.txid).toBe(revealA.txid); // txid identical, wtxid differs

    // the honest block contains revealA. The hostile backend serves revealB's
    // bytes for the reveal-tx hex under the SAME id/txid.
    const block = buildBlock([revealA]);
    const routes = routesForBlock(block, 100);
    routes[`${E}/tx/${revealA.txid}/hex`] = bytesToHex(revealB.raw); // swap!
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    const id = `${revealA.txid}i0`;

    // L2: verifies (txid matches, tapscript valid for leaf B) but flags it
    const l2 = await newResolver(routes).resolve(`ord:${id}`, { verification: 'L2' });
    expect(new TextDecoder().decode(l2.body)).toBe('forged');
    expect(l2.verification.l2?.singleLeafTree).toBe(false); // assurance surfaced

    // L3: the block's witness commitment pins revealA's witness → rejected.
    // The raw-block route already contains revealA, so L3 serves 'real'; the
    // forgery cannot be substituted because the wtxid tree would not fold.
    const l3 = await newResolver(routes).resolve(`ord:${id}`, { verification: 'L3' });
    expect(new TextDecoder().decode(l3.body)).toBe('real');
  });

  it('L3 rejects a raw block whose served reveal witness was swapped', async () => {
    const scriptA = envelopeScript({ fields: [[1, 'text/plain']], body: ['real'] }, { checksigPrefix: true });
    const scriptB = envelopeScript({ fields: [[1, 'text/plain']], body: ['forged'] }, { checksigPrefix: true });
    const leafA = tapLeafHash(scriptA, 0xc0);
    const leafB = tapLeafHash(scriptB, 0xc0);
    const commitA = taprootCommit(scriptA, [leafB]);
    const commitB = taprootCommit(scriptB, [leafA]);
    const commit = commitTx(commitA.scriptPubKey);
    const revealA = revealTx([{ script: scriptA, controlBlock: commitA.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    const revealB = revealTx([{ script: scriptB, controlBlock: commitB.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    const block = buildBlock([revealA]);
    const id = `${revealA.txid}i0`;

    // hostile raw block: same coinbase (so the witness commitment is unchanged)
    // but revealA's bytes replaced with revealB's swapped witness
    const forgedTxs: ParsedTx[] = [block.txs[0], revealB];
    const routes = routesForBlock(block, 100);
    routes[`${E}/block/${block.blockHash}/raw`] = serializeBlock(hexToBytes(block.headerHex), forgedTxs);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);

    await expect(newResolver(routes).resolve(`ord:${id}`, { verification: 'L3' })).rejects.toBeInstanceOf(
      OrdResolveError,
    );
  });
});

describe('adversarial: wrong txCount', () => {
  it('rejects an inflated txCount that does not match the header merkle root', async () => {
    const { block, routes, id } = inscriptionInBlock('count');
    routes[`${E}/block/${block.blockHash}`] = { id: block.blockHash, height: 100, tx_count: 999999 };
    await expect(newResolver(routes).resolve(`ord:${id}`, { verification: 'L2' })).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
    });
  });
});

describe('adversarial: oversized body', () => {
  it('bounds a reveal-hex response that exceeds the tx cap', async () => {
    const { routes, id, reveal } = inscriptionInBlock('big');
    const realHex = bytesToHex(reveal.raw);
    // a backend that streams far more hex than the cap allows
    routes[`${E}/tx/${reveal.txid}/hex`] = () =>
      new Response('00'.repeat(200) + realHex.repeat(1000));
    // tiny cap so the test is fast; a hostile stream blows past it
    const resolver = newResolver(routes, { limits: { txMaxBytes: 4096 } });
    await expect(resolver.resolve(`ord:${id}`)).rejects.toMatchObject({ code: 'BACKEND' });
  });

  it('bounds a raw block larger than the block cap at L3', async () => {
    const { routes, id, block } = inscriptionInBlock('bigblock');
    const realRaw = serializeBlock(hexToBytes(block.headerHex), block.txs);
    const padded = new Uint8Array(realRaw.length + 5_000_000);
    padded.set(realRaw, 0);
    routes[`${E}/block/${block.blockHash}/raw`] = () => new Response(padded.slice());
    await expect(newResolver(routes).resolve(`ord:${id}`, { verification: 'L3' })).rejects.toMatchObject({
      code: 'BACKEND',
    });
  });
});

describe('adversarial: slow-drip / hung backend', () => {
  it('times out a hung backend and fails over to the next esplora', async () => {
    // the good routes live on E; the resolver lists a hung backend FIRST, so
    // it must time out there and fail over. Attester routes for the height are
    // served for whatever host asks (both the hung host and E), so once the
    // proof is built on E the M-of-N anchor is still satisfied.
    const good = inscriptionInBlock('failover');
    const HUNG = 'https://hung.test';
    const onE = stubFetch(good.routes);
    let hungCalls = 0;
    const fetchFn: FetchFn = async (url, init) => {
      if (url.startsWith(HUNG)) {
        hungCalls++;
        // never resolve on its own; settle (as a reject) only when aborted
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted (timeout)')), {
            once: true,
          });
        });
      }
      // E2 attester answers mirror E's height routes
      return onE(url.replace(E2, E));
    };
    const resolver = new OrdResolver({
      esplora: [HUNG, E, E2],
      fetchFn,
      powLimitBits: null,
      limits: { timeoutMs: 200 },
    });
    const started = Date.now();
    const result = await resolver.resolve(`ord:${good.id}`);
    // it really went through the hung backend first (and gave up on it)
    expect(hungCalls).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.verification.level).toBe('L2');
    expect(new TextDecoder().decode(result.body)).toBe('failover');
  });
});

describe('adversarial: decompression bomb', () => {
  it('serves the stored encoded bytes rather than OOMing on a bomb', async () => {
    // craft a tag-9 gzip inscription whose body decompresses far past the cap
    const bomb = await gzipBytes(new Uint8Array(2 * 1024 * 1024)); // 2MB of zeros -> tiny gz
    const script = envelopeScript(
      { fields: [[1, 'text/plain'], [9, 'gzip']], body: [bomb] },
      { checksigPrefix: true },
    );
    const tap = taprootCommit(script);
    const commit = commitTx(tap.scriptPubKey);
    const reveal = revealTx([{ script, controlBlock: tap.controlBlock }], {
      prevTxidLE: commit.txidLE,
      vout: 0,
    });
    const block = buildBlock([reveal]);
    const routes = routesForBlock(block, 100);
    routes[`${E}/tx/${commit.txid}/hex`] = bytesToHex(commit.raw);
    const id = `${reveal.txid}i0`;

    // cap decoded output well below the 2MB expansion: decode is refused,
    // stored (compressed) bytes are served with the encoding preserved
    const resolver = newResolver(routes, { maxDecompressedBytes: 64 * 1024 });
    const result = await resolver.resolve(`ord:${id}`);
    expect(result.decoded).toBe(false);
    expect(result.storedContentEncoding).toBe('gzip');
    expect(result.body.length).toBe(bomb.length); // the stored bytes, unexpanded

    // with a generous cap the same body decodes normally
    const ok = newResolver(routes, { maxDecompressedBytes: 8 * 1024 * 1024 });
    const decoded = await ok.resolve(`ord:${id}`);
    expect(decoded.decoded).toBe(true);
    expect(decoded.body.length).toBe(2 * 1024 * 1024);
  });
});

async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const zlib = await import('node:zlib');
  return new Uint8Array(zlib.gzipSync(data));
}

// keep the merkle-root import meaningful (used indirectly via helpers): assert
// the block builder actually roots the reveal we address
describe('adversarial: sanity of the harness', () => {
  it('an untampered synthetic inscription resolves cleanly at L2 and L3', async () => {
    const { routes, id, block } = inscriptionInBlock('honest');
    const l2 = await newResolver(routes).resolve(`ord:${id}`, { verification: 'L2' });
    expect(new TextDecoder().decode(l2.body)).toBe('honest');
    const l3 = await newResolver(routes).resolve(`ord:${id}`, { verification: 'L3' });
    expect(new TextDecoder().decode(l3.body)).toBe('honest');
    // the header merkle root really is the root of the txid list (guards the
    // harness itself against silently accepting anything)
    const root = computeMerkleRoot(block.txs.map((t) => t.txidLE));
    expect(internalToDisplay(root)).toBe(parseHeader(hexToBytes(block.headerHex)).merkleRoot);
  });
});
