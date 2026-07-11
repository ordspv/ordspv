#!/usr/bin/env tsx
/**
 * Live-network fixture refresh + end-to-end validation.
 *
 * The initial repo was built in a sandbox without direct API egress; small
 * fixtures were pulled through a constrained channel and are cryptographically
 * self-verified in tests. This script, run with real network access:
 *
 *   1. re-fetches every insc0 fixture from esplora and byte-compares;
 *   2. runs a LIVE L2 resolution of inscription 0 (real mempool.space +
 *      blockstream.info, checkpointed header trust);
 *   3. runs a LIVE L3 resolution (downloads block 767430 raw, ~1.5 MB, builds
 *      the wtxid tree locally) — the one flow the sandbox could not exercise;
 *   4. optionally vendors extended vectors (delegate, brotli, multi-envelope)
 *      given inscription IDs as CLI args, emitting fixture JSON + a verified
 *      proof bundle for each into fixtures/extended/.
 *
 * Usage:
 *   npx tsx scripts/fetch-fixtures.ts
 *   npx tsx scripts/fetch-fixtures.ts <inscription-id> [<inscription-id>…]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, sha256, verifyProofBundle } from '@ord-resolver/core';
import { buildProofBundle, EsploraBackend, OrdResolver, parseOrdUri } from '@ord-resolver/fetch';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSC0 = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
const REVEAL = INSC0.slice(0, 64);
const COMMIT = '274bda6667e60bedede0d87f351220da4089427e6122f7d0bbd8e662b3796358';
const BLOCK = '000000000000000000029730547464f056f8b6e2e0a02eaf69c24389983a04f5';

const esplora = new EsploraBackend('https://mempool.space/api');

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function refreshInsc0(): Promise<void> {
  console.log('\n[1/3] re-fetching insc0 fixtures from live esplora…');
  const dir = join(ROOT, 'fixtures/insc0');
  const pairs: [string, Promise<string>][] = [
    ['reveal.hex', esplora.getTxHex(REVEAL)],
    ['commit.hex', esplora.getTxHex(COMMIT)],
    ['header-767430.hex', esplora.getHeaderHex(BLOCK)],
  ];
  for (const [file, promise] of pairs) {
    const live = (await promise).trim();
    const vendored = readFileSync(join(dir, file), 'utf8').trim();
    check(file, live === vendored, live === vendored ? 'byte-identical' : 'DIFFERS — investigate!');
  }
  const proof = await esplora.getMerkleProof(REVEAL);
  const vendored = JSON.parse(readFileSync(join(dir, 'merkle-proof.json'), 'utf8'));
  check(
    'merkle-proof.json',
    proof.pos === vendored.pos && JSON.stringify(proof.merkle) === JSON.stringify(vendored.merkle),
  );
}

async function liveResolutions(): Promise<void> {
  console.log('\n[2/3] LIVE L2 resolution of inscription 0…');
  const resolver = new OrdResolver({ verification: 'L2' });
  const l2 = await resolver.resolve(`ord:${INSC0}`);
  check('L2 resolve', l2.body.length === 793 && l2.contentType === 'image/png',
    `${l2.body.length} bytes, singleLeaf=${l2.verification.l2?.singleLeafTree}`);

  console.log('\n[3/3] LIVE L3 resolution (raw block download, ~1.5 MB)…');
  const l3 = await resolver.resolve(`ord:${INSC0}`, { verification: 'L3' });
  check('L3 resolve', l3.verification.level === 'L3' && l3.body.length === 793,
    `block ${l3.verification.blockHash}`);
}

async function vendorExtended(ids: string[]): Promise<void> {
  const dir = join(ROOT, 'fixtures/extended');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const resolver = new OrdResolver({ verification: 'L2' });
  for (const raw of ids) {
    const parsed = parseOrdUri(raw);
    console.log(`\nvendoring ${parsed.idString}…`);
    const bundle = await buildProofBundle(esplora, parsed.id, 'L2');
    const verified = verifyProofBundle(bundle);
    const insc = verified.inscription;
    // live /content resolution (follows delegates, decodes tag-9 encodings)
    // to record served-content expectations alongside the envelope-level facts
    let served: Record<string, unknown>;
    try {
      const result = await resolver.resolve(`ord:${parsed.idString}/content`);
      served = {
        sha256Stored: result.verification.bodySha256,
        length: result.body.length,
        viaDelegate: result.viaDelegate,
        decoded: result.decoded,
      };
    } catch (e) {
      served = { error: (e as { code?: string }).code ?? (e as Error).message };
    }
    const out = {
      inscriptionId: parsed.idString,
      height: verified.height,
      contentType: insc.contentType,
      contentEncoding: insc.contentEncoding,
      delegate: insc.delegate,
      parents: insc.parents,
      pointer: insc.pointer?.toString(),
      metaprotocol: insc.metaprotocol,
      metadataHex: insc.metadata ? bytesToHex(insc.metadata) : undefined,
      bodyLength: insc.body?.length,
      bodySha256: insc.body ? bytesToHex(sha256(insc.body)) : undefined,
      flags: insc.flags,
      served,
      l2: verified.l2,
    };
    writeFileSync(join(dir, `${parsed.idString}.json`), JSON.stringify(out, null, 2));
    writeFileSync(join(dir, `${parsed.idString}.bundle.json`), JSON.stringify(bundle));
    check(`vendored ${parsed.idString}`, true, `${out.contentType ?? 'no content-type'}, body ${out.bodyLength ?? 'absent'}B`);
  }
}

const ids = process.argv.slice(2);
await refreshInsc0();
await liveResolutions();
if (ids.length) await vendorExtended(ids);
console.log('\ndone.');
