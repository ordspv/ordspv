import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMerkleBranch,
  bytesToHex,
  checkProofOfWork,
  internalToDisplay,
  parseHeader,
  sha256,
  type ChainParams,
} from '@ordspv/core';
import {
  blockHashMerkleRoot,
  headerSyncTrust,
  HeaderChain,
  MAINNET_BASE_766080,
  syncHeaders,
  type ElectrumTransport,
} from '../src/headersync.js';
import { OrdResolver } from '../src/index.js';
import type { FetchFn } from '../src/backends.js';

/**
 * Offline headersync tests over a REAL vendored mainnet slice:
 * fixtures/headers/mainnet-766080-2120.bin — 2120 headers from the
 * retarget-aligned base 766080, crossing the in-repo-verified 767430
 * checkpoint AND the 768096 retarget boundary. The slice self-verifies
 * (every header's PoW + linkage + consensus bits are recomputed here), so a
 * corrupted fixture cannot pass.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const SLICE = new Uint8Array(readFileSync(join(FIXTURES, 'headers/mainnet-766080-2120.bin')));
const MANIFEST = JSON.parse(
  readFileSync(join(FIXTURES, 'headers/mainnet-766080-2120.json'), 'utf8'),
);
const REST = SLICE.slice(80); // everything above the base header
const INSC0_CHECKPOINT = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';
const BOUNDARY = 768096; // 766080 + 2016

const openMainnet = () => HeaderChain.open({ base: MAINNET_BASE_766080 });

describe('HeaderChain over the real mainnet slice', () => {
  it('fixture integrity: manifest hash matches file bytes', () => {
    expect(bytesToHex(sha256(SLICE))).toBe(MANIFEST.sha256);
  });

  it('validates all 2120 headers incl. the retarget boundary and checkpoint crossing', async () => {
    const chain = await openMainnet();
    chain.appendBatch(REST);
    expect(chain.tipHeight).toBe(768199);
    expect(chain.hashAt(767430)).toBe(INSC0_CHECKPOINT);
    // base hash as pinned against mempool.space + blockstream.info (2026-07-11)
    expect(chain.hashAt(766080)).toBe(
      '00000000000000000005e69a1a07c24511f2808bdf83895d91e0dacc9265872f',
    );
    expect(chain.chainwork).toBeGreaterThan(0n);
    // the boundary header exists and its bits were consensus-checked on append
    expect(chain.headerAt(BOUNDARY)).toBeDefined();
  });

  it('append in split batches equals one-shot append (cross-batch retarget context)', async () => {
    const oneShot = await openMainnet();
    oneShot.appendBatch(REST);
    const split = await openMainnet();
    split.appendBatch(REST.slice(0, 1000 * 80));
    split.appendBatch(REST.slice(1000 * 80));
    expect(split.tipHeight).toBe(oneShot.tipHeight);
    expect(split.tipHash).toBe(oneShot.tipHash);
    expect(split.chainwork).toBe(oneShot.chainwork);
  });

  it('rejects a tampered retarget boundary (bits)', async () => {
    const chain = await openMainnet();
    const tampered = REST.slice();
    const boundaryOffset = (BOUNDARY - 766080 - 1) * 80; // REST starts at base+1
    tampered[boundaryOffset + 72] ^= 0x01; // bits field: bytes 72..75
    expect(() => chain.appendBatch(tampered)).toThrow(/retarget boundary|bits/);
  });

  it('rejects tampered mid-period bits, broken linkage, and MTP violations', async () => {
    // mid-period bits
    let chain = await openMainnet();
    let tampered = REST.slice();
    tampered[500 * 80 + 72] ^= 0x01;
    expect(() => chain.appendBatch(tampered)).toThrow(/bits/);

    // linkage: flip a prev-hash byte
    chain = await openMainnet();
    tampered = REST.slice();
    tampered[500 * 80 + 4] ^= 0x01;
    expect(() => chain.appendBatch(tampered)).toThrow(/does not link/);

    // median-time-past: force a timestamp far into the past (time: bytes 68..71)
    chain = await openMainnet();
    tampered = REST.slice();
    tampered[500 * 80 + 68] = 0;
    tampered[500 * 80 + 69] = 0;
    tampered[500 * 80 + 70] = 0;
    tampered[500 * 80 + 71] = 0x60; // ~2021, far below the window median
    expect(() => chain.appendBatch(tampered)).toThrow(/median-time-past|PoW|link/);
  });

  it('rejects a chain contradicting a checkpoint crossing', async () => {
    const chain = await HeaderChain.open({
      base: MAINNET_BASE_766080,
      checkpoints: new Map([[767430, '00'.repeat(32)]]),
    });
    expect(() => chain.appendBatch(REST)).toThrow(/contradicts checkpoint/);
  });

  it('refuses a non-retarget-aligned base', async () => {
    await expect(
      HeaderChain.open({
        base: { height: 766081, headerHex: MAINNET_BASE_766080.headerHex },
      }),
    ).rejects.toThrow(/not a retarget boundary/);
  });
});

describe('persistence', () => {
  it('round-trips through disk with full revalidation, and detects corruption', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headersync-'));
    const file = join(dir, 'headers.bin');

    const chain = await HeaderChain.open({ base: MAINNET_BASE_766080, file });
    chain.appendBatch(REST.slice(0, 1200 * 80));
    expect(chain.tipHeight).toBe(766080 + 1200);

    const reopened = await HeaderChain.open({ base: MAINNET_BASE_766080, file });
    expect(reopened.tipHeight).toBe(chain.tipHeight);
    expect(reopened.tipHash).toBe(chain.tipHash);
    // appending after reopen continues from disk state
    reopened.appendBatch(REST.slice(1200 * 80));
    expect(reopened.tipHeight).toBe(768199);

    // corruption cannot load
    const bytes = new Uint8Array(readFileSync(file));
    bytes[80 * 700 + 40] ^= 0xff;
    writeFileSync(file, bytes);
    await expect(HeaderChain.open({ base: MAINNET_BASE_766080, file })).rejects.toThrow();
  });

  it('truncateTo rewrites the file and reopen sees the shorter chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headersync-'));
    const file = join(dir, 'headers.bin');
    const chain = await HeaderChain.open({ base: MAINNET_BASE_766080, file });
    chain.appendBatch(REST.slice(0, 100 * 80));
    chain.truncateTo(766080 + 40);
    expect(chain.tipHeight).toBe(766080 + 40);
    const reopened = await HeaderChain.open({ base: MAINNET_BASE_766080, file });
    expect(reopened.tipHeight).toBe(766080 + 40);
  });
});

// ---------------------------------------------------------------------------
// synthetic regtest-style chain for sync-loop / reorg / cp_height tests
// ---------------------------------------------------------------------------

const TEST_PARAMS: ChainParams = {
  retargetInterval: 2016,
  targetTimespan: 14 * 24 * 3600,
  powLimitBits: 0x207fffff,
  noRetarget: true,
};

/** mine a linking regtest-difficulty header */
function mineHeader(prevHashLE: Uint8Array, time: number, seed: number): Uint8Array {
  const h = new Uint8Array(80);
  const view = new DataView(h.buffer);
  view.setInt32(0, 4, true);
  h.set(prevHashLE, 4);
  h.set(sha256(new Uint8Array([seed & 0xff, seed >> 8])), 36); // arbitrary merkle root
  view.setUint32(68, time, true);
  view.setUint32(72, 0x207fffff, true);
  for (let nonce = 0; ; nonce++) {
    view.setUint32(76, nonce, true);
    const parsed = parseHeader(h.slice());
    if (checkProofOfWork(parsed)) return h.slice();
  }
}

function mineChain(length: number, seedBase = 0): Uint8Array[] {
  const headers: Uint8Array[] = [];
  let prev: Uint8Array = new Uint8Array(32); // genesis-style zero prev
  let time = 1_700_000_000;
  for (let i = 0; i < length; i++) {
    const raw = mineHeader(prev, time, seedBase + i);
    headers.push(raw);
    prev = parseHeader(raw).hashLE;
    time += 600;
  }
  return headers;
}

class FakeElectrum implements ElectrumTransport {
  requests: string[] = [];
  constructor(
    private headersByHeight: Uint8Array[], // index = height
    private opts: { maxBatch?: number; cp?: { height: number } } = {},
  ) {}

  swapTail(from: number, replacement: Uint8Array[]): void {
    this.headersByHeight = [...this.headersByHeight.slice(0, from), ...replacement];
  }

  get tip(): number {
    return this.headersByHeight.length - 1;
  }

  async request(method: string, params: unknown[]): Promise<unknown> {
    this.requests.push(method);
    if (method === 'server.version') return ['fake/1.4', '1.4'];
    if (method === 'blockchain.headers.subscribe') {
      return { height: this.tip, hex: bytesToHex(this.headersByHeight[this.tip]) };
    }
    if (method === 'blockchain.block.headers') {
      const [start, count, cpHeight] = params as [number, number, number?];
      const max = this.opts.maxBatch ?? 2016;
      const n = Math.min(count, max, this.headersByHeight.length - start);
      const slice = this.headersByHeight.slice(start, start + n);
      const hex = slice.map(bytesToHex).join('');
      const res: Record<string, unknown> = { hex, count: n, max };
      if (cpHeight !== undefined) {
        const hashes = this.headersByHeight
          .slice(0, cpHeight + 1)
          .map((raw) => parseHeader(raw).hashLE);
        res.root = internalToDisplay(blockHashMerkleRoot(hashes));
        res.branch = buildMerkleBranch(hashes, start + n - 1).map(internalToDisplay);
      }
      return res;
    }
    throw new Error(`unexpected method ${method}`);
  }
}

describe('syncHeaders loop (fake transport, regtest params)', () => {
  const CHAIN = mineChain(60);
  const BASE = { height: 0, headerHex: bytesToHex(CHAIN[0]) };

  it('syncs to the server tip across multiple capped batches', async () => {
    const chain = await HeaderChain.open({ base: BASE, params: TEST_PARAMS, checkpoints: new Map() });
    const server = new FakeElectrum(CHAIN, { maxBatch: 16 });
    const result = await syncHeaders(chain, server, { batchSize: 16 });
    expect(result.tipHeight).toBe(59);
    expect(result.added).toBe(59);
    expect(chain.tipHash).toBe(parseHeader(CHAIN[59]).hash);
  });

  it('recovers from a shallow reorg by truncating and re-requesting', async () => {
    const chain = await HeaderChain.open({ base: BASE, params: TEST_PARAMS, checkpoints: new Map() });
    const server = new FakeElectrum(CHAIN.slice(0, 50));
    await syncHeaders(chain, server);
    expect(chain.tipHeight).toBe(49);

    // server reorgs the last block (different seed => different hash) and extends
    const prev48 = parseHeader(CHAIN[48]).hashLE;
    const alt49 = mineHeader(prev48, 1_700_000_000 + 49 * 600 + 1, 9049);
    const alt50 = mineHeader(parseHeader(alt49).hashLE, 1_700_000_000 + 50 * 600 + 1, 9050);
    server.swapTail(49, [alt49, alt50]);

    const result = await syncHeaders(chain, server);
    expect(result.tipHeight).toBe(50);
    expect(chain.hashAt(49)).toBe(parseHeader(alt49).hash);
    expect(chain.hashAt(50)).toBe(parseHeader(alt50).hash);
  });

  it('verifies Electrum cp_height branches against a pinned root, rejecting forgeries', async () => {
    const hashes = CHAIN.map((raw) => parseHeader(raw).hashLE);
    const CP = 55;
    const root = internalToDisplay(blockHashMerkleRoot(hashes.slice(0, CP + 1)));

    const chain = await HeaderChain.open({ base: BASE, params: TEST_PARAMS, checkpoints: new Map() });
    const server = new FakeElectrum(CHAIN, { maxBatch: 16 });
    const result = await syncHeaders(chain, server, {
      batchSize: 16,
      checkpoint: { height: CP, root },
    });
    expect(result.tipHeight).toBe(59);

    // wrong pinned root must fail on the first cp-anchored batch
    const chain2 = await HeaderChain.open({ base: BASE, params: TEST_PARAMS, checkpoints: new Map() });
    await expect(
      syncHeaders(chain2, new FakeElectrum(CHAIN, { maxBatch: 16 }), {
        batchSize: 16,
        checkpoint: { height: CP, root: '11'.repeat(32) },
      }),
    ).rejects.toThrow(/cp root/);
  });
});

describe('headerSyncTrust as the resolver anchor (drop-in)', () => {
  it('anchors inscription 0 L2 resolution with zero esplora header lookups', async () => {
    const chain = await openMainnet();
    chain.appendBatch(REST);

    const INSC0 = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
    const REVEAL = INSC0.slice(0, 64);
    const COMMIT = '274bda6667e60bedede0d87f351220da4089427e6122f7d0bbd8e662b3796358';
    const dir = join(FIXTURES, 'insc0');
    const read = (f: string) => readFileSync(join(dir, f), 'utf8').trim();
    const E = 'https://esplora.test';
    const routes: Record<string, string | object> = {
      [`${E}/tx/${REVEAL}/status`]: {
        confirmed: true,
        block_height: 767430,
        block_hash: INSC0_CHECKPOINT,
      },
      [`${E}/tx/${REVEAL}/hex`]: read('reveal.hex'),
      [`${E}/tx/${REVEAL}/merkle-proof`]: JSON.parse(read('merkle-proof.json')),
      [`${E}/block/${INSC0_CHECKPOINT}/header`]: read('header-767430.hex'),
      [`${E}/block/${INSC0_CHECKPOINT}`]: { id: INSC0_CHECKPOINT, height: 767430, tx_count: 2332 },
      [`${E}/tx/${COMMIT}/hex`]: read('commit.hex'),
      // NOTE: deliberately NO /block-height or /blocks/tip routes — the sync
      // chain is the only anchor available
    };
    const fetchFn: FetchFn = async (url) => {
      const route = routes[url];
      if (route === undefined) return new Response(`no stub for ${url}`, { status: 404 });
      if (typeof route === 'string') return new Response(route);
      return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
    };

    const resolver = new OrdResolver({
      esplora: [E],
      fetchFn,
      verification: 'L2',
      trustHeader: headerSyncTrust(chain, { minConfirmations: 6 }),
    });
    const result = await resolver.resolve(`ord:${INSC0}`);
    expect(result.body.length).toBe(793);
    expect(result.verification.headerTrust?.anchoredBySync).toBe(true);
    expect(result.verification.headerTrust?.tipHeight).toBe(768199);
  });

  it('rejects headers outside or contradicting the synced chain', async () => {
    const chain = await openMainnet();
    chain.appendBatch(REST.slice(0, 100 * 80));
    const trust = headerSyncTrust(chain);
    const someHeader = chain.headerAt(766100)!;
    await expect(trust(someHeader, 999999)).rejects.toThrow(/outside synced chain/);
    await expect(trust(someHeader, 766101)).rejects.toThrow(/contradicts synced chain/);
    await expect(trust(someHeader, 766100)).resolves.toMatchObject({ anchoredBySync: true });
  });
});
