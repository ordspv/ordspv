#!/usr/bin/env tsx
/**
 * Vendor a real mainnet header slice for offline headersync tests: 2120
 * headers from the retarget-aligned base 766080 (covers the 767430
 * inscription-0 checkpoint AND the 768096 retarget boundary), fetched over
 * Electrum, validated through HeaderChain (linkage, PoW, retarget, MTP,
 * checkpoint crossing) before a byte is written.
 *
 *   npx tsx scripts/fetch-header-fixture.ts [host[:port]]
 *
 * Default server: electrum.blockstream.info:50002 (TLS).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes, sha256 } from '@ordspv/core';
import {
  ElectrumTcpTransport,
  HeaderChain,
  MAINNET_BASE_766080,
} from '../packages/fetch/src/headersync.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COUNT = 2120; // base..base+2119, boundary at 768096 = base+2016
const OUT_DIR = join(ROOT, 'fixtures/headers');

const arg = process.argv[2] ?? 'electrum.blockstream.info:50002';
const [host, portStr] = arg.split(':');
const transport = new ElectrumTcpTransport({ host, port: Number(portStr ?? 50002), tls: true });

console.log(`fetching ${COUNT} headers from ${host} starting at ${MAINNET_BASE_766080.height}…`);
await transport.request('server.version', ['ordspv fixture fetch', '1.4']);
const chunks: Uint8Array[] = [];
let fetched = 0;
while (fetched < COUNT) {
  const res = (await transport.request('blockchain.block.headers', [
    MAINNET_BASE_766080.height + fetched,
    COUNT - fetched,
  ])) as { hex: string; count: number; max: number };
  if (res.count === 0) throw new Error('server returned zero headers');
  chunks.push(hexToBytes(res.hex));
  fetched += res.count;
  console.log(`  +${res.count} (server max ${res.max}) -> ${fetched}/${COUNT}`);
}
transport.close();

const raw = new Uint8Array(fetched * 80);
let offset = 0;
for (const chunk of chunks) {
  raw.set(chunk, offset);
  offset += chunk.length;
}
if (fetched !== COUNT) throw new Error(`expected ${COUNT} headers, got ${fetched}`);

// first header must BE the pinned base; the rest must validate on top of it
const baseBytes = hexToBytes(MAINNET_BASE_766080.headerHex);
if (bytesToHex(raw.slice(0, 80)) !== bytesToHex(baseBytes)) {
  throw new Error('server header at base height differs from the pinned base header');
}
const chain = await HeaderChain.open({ base: MAINNET_BASE_766080 });
chain.appendBatch(raw.slice(80));
console.log(`validated: tip ${chain.tipHeight}, chainwork ${chain.chainwork.toString(16)}`);
console.log(`checkpoint crossing 767430 = ${chain.hashAt(767430)}`);

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `mainnet-${MAINNET_BASE_766080.height}-${COUNT}.bin`);
writeFileSync(file, raw);
writeFileSync(
  join(OUT_DIR, `mainnet-${MAINNET_BASE_766080.height}-${COUNT}.json`),
  JSON.stringify(
    {
      baseHeight: MAINNET_BASE_766080.height,
      count: COUNT,
      tipHeight: chain.tipHeight,
      tipHash: chain.hashAt(chain.tipHeight),
      sha256: bytesToHex(sha256(raw)),
      source: `electrum ${host}`,
      fetched: '2026-07-11',
    },
    null,
    2,
  ),
);
console.log(`wrote ${file}`);
