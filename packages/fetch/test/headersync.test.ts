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
 * fixtures/headers/mainnet-766080-2120.bin: 2120 headers from the
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
      // NOTE: deliberately NO /block-height or /blocks/tip routes; the sync
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

// ---------------------------------------------------------------------------
// hardening: reorg discipline, most-work rule, transport bounds, TLS
// ---------------------------------------------------------------------------

import { calcNextBits, workFromBits } from '@ordspv/core';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { mkdtempSync as mkdtemp2 } from 'node:fs';
import { afterAll, beforeAll } from 'vitest';
import { ElectrumTcpTransport, MAX_FUTURE_DRIFT_SECONDS, ReorgLinkError } from '../src/headersync.js';

describe('sync-loop reorg discipline', () => {
  const CHAIN2 = mineChain(40, 5000);
  const BASE2 = { height: 0, headerHex: bytesToHex(CHAIN2[0]) };

  it('consensus failures do NOT truncate the chain (only linkage at the tip does)', async () => {
    const chain = await HeaderChain.open({ base: BASE2, params: TEST_PARAMS, checkpoints: new Map() });
    const server = new FakeElectrum(CHAIN2.slice(0, 30));
    await syncHeaders(chain, server);
    expect(chain.tipHeight).toBe(29);
    const tipBefore = chain.tipHash;

    // serve an extension whose SECOND header has tampered bits: a bad batch,
    // not reorg evidence; the sync must abort without rewinding anything
    const ext = [CHAIN2[30], CHAIN2[31].slice()];
    ext[1][72] ^= 0x01;
    const badServer = new FakeElectrum([...CHAIN2.slice(0, 30), ...ext]);
    await expect(syncHeaders(chain, badServer)).rejects.toThrow(/bits/);
    expect(chain.tipHeight).toBe(29);
    expect(chain.tipHash).toBe(tipBefore);
  });

  it('appendBatch types the tip-linkage failure as ReorgLinkError, deeper breaks as plain Error', async () => {
    const chain = await HeaderChain.open({ base: BASE2, params: TEST_PARAMS, checkpoints: new Map() });
    chain.appendBatch(concatRaw(CHAIN2.slice(1, 10)));
    // first header of the batch does not link to our tip: reorg evidence
    expect(() => chain.appendBatch(CHAIN2[12])).toThrow(ReorgLinkError);
    // a batch broken INTERNALLY is not: same message, plain Error
    try {
      chain.appendBatch(concatRaw([CHAIN2[10], CHAIN2[12]]));
      expect.unreachable('batch must throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/does not link/);
      expect(e instanceof ReorgLinkError).toBe(false);
    }
  });

  it('rejects a malformed electrum header batch before decoding it', async () => {
    const chain = await HeaderChain.open({ base: BASE2, params: TEST_PARAMS, checkpoints: new Map() });
    const inner = new FakeElectrum(CHAIN2.slice(0, 20));
    const liar: ElectrumTransport = {
      async request(method, params) {
        const res = await inner.request(method, params);
        if (method === 'blockchain.block.headers') {
          const r = res as { hex: string; count: number };
          return { ...r, hex: r.hex + 'ab'.repeat(80) }; // hex longer than claimed count
        }
        return res;
      },
    };
    await expect(syncHeaders(chain, liar)).rejects.toThrow(/malformed/);
    expect(chain.tipHeight).toBe(0);

    const overCount: ElectrumTransport = {
      async request(method, params) {
        const res = await inner.request(method, params);
        if (method === 'blockchain.block.headers') {
          const r = res as { hex: string; count: number };
          return { ...r, count: r.count + 5 }; // claims more than requested
        }
        return res;
      },
    };
    await expect(syncHeaders(chain, overCount)).rejects.toThrow(/malformed/);
  });

  it('rejects headers timestamped beyond the future-drift bound', async () => {
    const NOW = 1_700_000_000 + 40 * 600;
    const chain = await HeaderChain.open({
      base: BASE2,
      params: TEST_PARAMS,
      checkpoints: new Map(),
      now: () => NOW,
    });
    chain.appendBatch(concatRaw(CHAIN2.slice(1, 5)));
    const prev = parseHeader(CHAIN2[4]).hashLE;
    const tooNew = mineHeader(prev, NOW + MAX_FUTURE_DRIFT_SECONDS + 60, 7777);
    expect(() => chain.appendBatch(tooNew)).toThrow(/in the future/);
    const okNew = mineHeader(prev, NOW + MAX_FUTURE_DRIFT_SECONDS - 60, 7778);
    expect(chain.appendBatch(okNew)).toBe(5);
  });
});

function concatRaw(headers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(headers.length * 80);
  headers.forEach((h, i) => out.set(h, i * 80));
  return out;
}

describe('most-work reorg rule (forced-easier-retarget fork is rejected)', () => {
  // tiny retarget interval so a boundary crossing is cheap to mine
  const FORK_PARAMS: ChainParams = {
    retargetInterval: 4,
    targetTimespan: 4 * 600,
    powLimitBits: 0x207fffff,
  };
  const START_BITS = 0x2000ffff; // well below the pow limit: room to retarget easier
  const T0 = 1_700_000_000;
  const NOW = T0 + 10 * 600;

  function mineAt(prevHashLE: Uint8Array, time: number, bits: number, seed: number): Uint8Array {
    const h = new Uint8Array(80);
    const view = new DataView(h.buffer);
    view.setInt32(0, 4, true);
    h.set(prevHashLE, 4);
    h.set(sha256(new Uint8Array([seed & 0xff, seed >> 8, 0x77])), 36);
    view.setUint32(68, time, true);
    view.setUint32(72, bits, true);
    for (let nonce = 0; ; nonce++) {
      view.setUint32(76, nonce, true);
      const parsed = parseHeader(h.slice());
      if (checkProofOfWork(parsed)) return h.slice();
    }
  }

  /** extend a chain of (raw, time, bits) tuples following FORK_PARAMS retargeting */
  function extend(
    rows: { raw: Uint8Array; time: number; bits: number }[],
    time: number,
    seed: number,
  ): void {
    const h = rows.length;
    const bits =
      h === 0
        ? START_BITS
        : h % FORK_PARAMS.retargetInterval === 0
          ? calcNextBits(
              rows[h - 1].bits,
              rows[h - FORK_PARAMS.retargetInterval].time,
              rows[h - 1].time,
              FORK_PARAMS,
            )
          : rows[h - 1].bits;
    const prev = h === 0 ? new Uint8Array(32) : parseHeader(rows[h - 1].raw).hashLE;
    rows.push({ raw: mineAt(prev, time, bits, seed), time, bits });
  }

  it('a taller fork with less cumulative work is refused and the chain restored', async () => {
    // honest chain: heights 0..9, 600s spacing (difficulty ratchets harder)
    const honest: { raw: Uint8Array; time: number; bits: number }[] = [];
    for (let h = 0; h < 10; h++) extend(honest, T0 + h * 600, 100 + h);

    // attack fork from height 6: timestamps pushed forward (inside the +2h
    // bound) so the height-8 retarget lands EASIER; taller but lighter
    const fork = honest.slice(0, 6);
    const JUMP = 6000;
    for (let h = 6; h < 11; h++) extend(fork, T0 + h * 600 + JUMP, 900 + h);

    const honestWork = honest.slice(6).reduce((w, r) => w + workFromBits(r.bits), 0n);
    const forkWork = fork.slice(6).reduce((w, r) => w + workFromBits(r.bits), 0n);
    expect(fork.length).toBeGreaterThan(honest.length); // taller
    expect(forkWork).toBeLessThan(honestWork); // lighter

    const chain = await HeaderChain.open({
      base: { height: 0, headerHex: bytesToHex(honest[0].raw) },
      params: FORK_PARAMS,
      checkpoints: new Map(),
      now: () => NOW,
    });
    await syncHeaders(chain, new FakeElectrum(honest.map((r) => r.raw)));
    expect(chain.tipHeight).toBe(9);
    const honestTip = chain.tipHash;
    const honestWorkTotal = chain.chainwork;

    const forkServer = new FakeElectrum(fork.map((r) => r.raw));
    await expect(syncHeaders(chain, forkServer)).rejects.toThrow(/most-work/);
    // fully restored: same tip, same work, no partial adoption
    expect(chain.tipHeight).toBe(9);
    expect(chain.tipHash).toBe(honestTip);
    expect(chain.chainwork).toBe(honestWorkTotal);
  });

  it('a heavier fork is still adopted (the legitimate reorg path keeps working)', async () => {
    const honest: { raw: Uint8Array; time: number; bits: number }[] = [];
    for (let h = 0; h < 8; h++) extend(honest, T0 + h * 600, 300 + h);

    // same-difficulty fork from height 6, one block taller: strictly more work
    const fork = honest.slice(0, 6);
    for (let h = 6; h < 9; h++) extend(fork, T0 + h * 600 + 30, 1300 + h);

    const chain = await HeaderChain.open({
      base: { height: 0, headerHex: bytesToHex(honest[0].raw) },
      params: FORK_PARAMS,
      checkpoints: new Map(),
      now: () => NOW,
    });
    await syncHeaders(chain, new FakeElectrum(honest.map((r) => r.raw)));
    expect(chain.tipHeight).toBe(7);

    await syncHeaders(chain, new FakeElectrum(fork.map((r) => r.raw)));
    expect(chain.tipHeight).toBe(8);
    expect(chain.tipHash).toBe(parseHeader(fork[8].raw).hash);
  });
});

describe('electrum transport bounds and TLS verification', () => {
  let floodServer: NetServer;
  let floodPort = 0;

  beforeAll(async () => {
    // a hostile server that answers any request with an endless unterminated line
    floodServer = createNetServer((socket) => {
      const junk = 'a'.repeat(64 * 1024);
      const timer = setInterval(() => {
        if (!socket.writableEnded) socket.write(junk);
      }, 5);
      socket.on('close', () => clearInterval(timer));
      socket.on('error', () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => floodServer.listen(0, '127.0.0.1', resolve));
    floodPort = (floodServer.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => floodServer.close(() => resolve())));

  it('destroys the connection once the receive buffer cap is exceeded', async () => {
    const transport = new ElectrumTcpTransport({
      host: '127.0.0.1',
      port: floodPort,
      tls: false,
      maxBufferBytes: 256 * 1024,
      timeoutMs: 10_000,
    });
    await expect(transport.request('server.version', [])).rejects.toThrow(
      /receive buffer exceeded|socket closed/,
    );
    transport.close();
  });
});

const hasOpenssl = (() => {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('electrum TLS certificate verification', () => {
  let tlsServer: TlsServer;
  let tlsPort = 0;
  let certPem = '';

  beforeAll(async () => {
    const dir = mkdtemp2(join(tmpdir(), 'electrum-tls-'));
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj /CN=localhost`,
      { cwd: dir, stdio: 'ignore' },
    );
    certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
    const keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
    tlsServer = createTlsServer({ key: keyPem, cert: certPem }, (socket) => {
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line) as { id: number };
            socket.write(`${JSON.stringify({ id: msg.id, result: ['stub/1.4', '1.4'] })}\n`);
          } catch {
            /* ignore */
          }
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => tlsServer.close(() => resolve())));

  const fingerprint = () => {
    const der = Buffer.from(
      certPem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ''),
      'base64',
    );
    return createHash('sha256').update(der).digest('hex');
  };

  it('rejects a self-signed server by default (rejectUnauthorized)', async () => {
    const transport = new ElectrumTcpTransport({ host: '127.0.0.1', port: tlsPort, timeoutMs: 5000 });
    await expect(transport.request('server.version', [])).rejects.toThrow(
      /self.signed|self signed|certificate|SELF_SIGNED/i,
    );
    transport.close();
  });

  it('accepts it behind the explicit insecure opt-in', async () => {
    const transport = new ElectrumTcpTransport({
      host: '127.0.0.1',
      port: tlsPort,
      insecure: true,
      timeoutMs: 5000,
    });
    await expect(transport.request('server.version', [])).resolves.toEqual(['stub/1.4', '1.4']);
    transport.close();
  });

  it('accepts a matching pinned certificate fingerprint (no insecure needed)', async () => {
    const transport = new ElectrumTcpTransport({
      host: '127.0.0.1',
      port: tlsPort,
      pinnedCertSha256: fingerprint(),
      timeoutMs: 5000,
    });
    await expect(transport.request('server.version', [])).resolves.toEqual(['stub/1.4', '1.4']);
    transport.close();
  });

  it('rejects a wrong pinned fingerprint', async () => {
    const transport = new ElectrumTcpTransport({
      host: '127.0.0.1',
      port: tlsPort,
      pinnedCertSha256: '11'.repeat(32),
      timeoutMs: 5000,
    });
    await expect(transport.request('server.version', [])).rejects.toThrow(/fingerprint/);
    transport.close();
  });
});
