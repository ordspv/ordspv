#!/usr/bin/env tsx
/**
 * Envelope-parser parity sweep against a live ord instance.
 *
 * For each inscription id: fetch the reveal tx (esplora), parse it with OUR
 * envelope parser, then cross-check against ord's recursive API:
 *
 *   - /r/inscription/<id>       exists, content_type, content_length, delegate,
 *                               and (pre-Jubilee, envelope-derivable curses only)
 *                               the `cursed` charm
 *   - /r/inscription/<txid>i<count>  must 404, locking our per-tx envelope COUNT
 *   - /r/undelegated-content    byte-for-byte body parity (sha256; for encoded
 *                               bodies our STORED bytes are decompressed first,
 *                               because fetch() transparently decodes transport
 *                               content-encoding); our body=undefined must 404
 *   - /r/metadata               hex parity with our concatenated tag-5 chunks
 *
 * ANY mismatch is a P0 bug (DEVELOPMENT.md invariant 2). Exit code = failed checks.
 *
 * Usage:
 *   npx tsx scripts/parity-sweep.ts                 # curated default corpus
 *   npx tsx scripts/parity-sweep.ts <id> [<id>…]    # specific inscriptions
 *   ORD_BASE=https://my-ord:80 npx tsx scripts/parity-sweep.ts
 */
import {
  bytesToHex,
  hexToBytes,
  inscriptionsFromTx,
  parseTx,
  sha256,
  type Inscription,
} from '@ordspv/core';
import { EsploraBackend, OrdBackend, nodeDecompressor } from '@ordspv/fetch';

const JUBILEE_HEIGHT = 824544;

/**
 * Curated ids spanning eras and envelope features (discovered by scanning raw
 * blocks with this repo's parser + ordpool-parser's published vectors, then
 * confirmed live):
 */
const DEFAULT_IDS: [string, string][] = [
  // baseline
  ['6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0', 'inscription 0 (h767430)'],
  // pushnum era, pre-Jubilee (cursed)
  ['ded23bc43cf92d13fe72c1626a019b607289053038eaf6faceb9b00b3ca3548ai0', 'pushnum text (h780000, pre-Jubilee)'],
  // multi-INPUT reveal, Apr 2023 (cursed input>0; ord issue #2045 era)
  ['092111e882a8025f3f05ab791982e8cc7fd7395afe849a5949fd56255b5c41cci0', 'multi-input reveal, i0 (pre-Jubilee)'],
  ['092111e882a8025f3f05ab791982e8cc7fd7395afe849a5949fd56255b5c41cci1', 'multi-input reveal, i1 = input 1 (cursed)'],
  ['092111e882a8025f3f05ab791982e8cc7fd7395afe849a5949fd56255b5c41cci2', 'multi-input reveal, i2 = input 2 (cursed)'],
  // 666-envelope batch with pointers, all in vin[1]
  ['11d3f4b39e8ab97995bab1eacf7dcbf1345ec59c07261c0197e18bf29b88d8dai0', '666-batch, i0'],
  ['11d3f4b39e8ab97995bab1eacf7dcbf1345ec59c07261c0197e18bf29b88d8dai1', '666-batch, i1 (i>0)'],
  ['11d3f4b39e8ab97995bab1eacf7dcbf1345ec59c07261c0197e18bf29b88d8dai665', '666-batch, last (i665)'],
  // post-Jubilee batch (blessed i>0 + pointer)
  ['74c157fbb6581e86b333395ca5def1442c9e7a5c9795774dc20325c6c012500bi1', 'batch i1 + pointer (h833000)'],
  // delegate WITHOUT body (bare-content 404 nuance), input>0, i>0
  ['69696d8fc8dd8c59f48ae65dc184a4332d396e3e2fc0ef16a2757c67f891a466i0', 'delegate, no body, input 1 (h860000)'],
  ['69696d8fc8dd8c59f48ae65dc184a4332d396e3e2fc0ef16a2757c67f891a466i1', 'delegate, no body, i>0 + pointer'],
  // delegate WITH empty-but-present body + metadata
  ['0028084bc1cdddbd3c870af063c6f65d5ba216d932e3d6ea2fd29e2d43ff9ff2i0', 'delegate + metadata + empty body (h846000)'],
  // the delegate target of the above (vendored as an extended fixture)
  ['177c1e83ca20790448559382232487c7c97767f69bf46ec62152c3da0e099882i0', 'delegate target svg'],
  // brotli content-encoding (ordpool-parser vector)
  ['6dc2c16a74dedcae46300b2058ebadc7ca78aea78236459662375c8d7d9804dbi0', 'brotli-encoded js'],
  // chunked metadata > 520 bytes (ordpool-parser vector)
  ['c50ed012bcfd8f890269b2802c7c20308c5a6a0a99499d65db1fcae71c3ab707i0', 'chunked metadata >520B'],
  // metaprotocol + metadata, multi-input
  ['49cbc5cbac92cf917dd4539d62720a3e528d17e22ef5fc47070a17ec0d3cf307i0', 'cbrc-20 metaprotocol + metadata'],
  // tag 15 note (no-op tag)
  ['4c83f2e1d12d6f71e9f69159aff48f7946ce04c5ffcc3a3feee4080bac343722i0', 'tag-15 note (chisel.xyz)'],
  // input>0 + pointer + metadata, big webp
  ['a87a8ed81799a321ecfe5a14c0652a77d482de718a10f4d8e3f103d29b26fe49i0', 'input>0 + pointer + metadata (h860000)'],
];

const esploras = [
  new EsploraBackend('https://mempool.space/api'),
  new EsploraBackend('https://blockstream.info/api'),
];
const ord = new OrdBackend(process.env.ORD_BASE ?? 'https://ordinals.com');

let failures = 0;

function check(ok: boolean, what: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`    ${ok ? '✓' : '✗ MISMATCH'} ${what}${detail ? `: ${detail}` : ''}`);
}

function note(what: string): void {
  console.log(`    · ${what}`);
}

async function fetchRevealHex(txid: string): Promise<string> {
  const errors: string[] = [];
  for (const e of esploras) {
    try {
      return (await e.getTxHex(txid)).trim();
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(`all esploras failed for ${txid}: ${errors.join('; ')}`);
}

/** raw fetch against the ord instance, returning status + bytes + headers */
async function ordRaw(path: string): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
  const res = await fetch(`${ord.baseUrl}${path}`, {
    headers: { 'accept-encoding': 'br, gzip, identity' },
  });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
}

const parsedTxCache = new Map<string, Inscription[]>();

async function inscriptionsOf(txid: string): Promise<Inscription[]> {
  let inscs = parsedTxCache.get(txid);
  if (!inscs) {
    const hex = await fetchRevealHex(txid);
    inscs = inscriptionsFromTx(parseTx(hexToBytes(hex)));
    parsedTxCache.set(txid, inscs);
  }
  return inscs;
}

/** envelope-derivable pre-Jubilee curse indicators (subset of ord's curse reasons) */
function envelopeCurseIndicators(insc: Inscription): string[] {
  const reasons: string[] = [];
  if (insc.flags.pushnum) reasons.push('pushnum');
  if (insc.flags.incompleteField) reasons.push('incomplete-field');
  if (insc.flags.duplicateField) reasons.push('duplicate-field');
  if (insc.flags.unrecognizedEvenField) reasons.push('unrecognized-even-field');
  if (insc.flags.stutter) reasons.push('stutter');
  if (insc.index > 0) reasons.push('not-at-offset-zero');
  if (insc.input > 0) reasons.push('not-in-first-input');
  if (insc.pointer !== undefined) reasons.push('pointer');
  return reasons;
}

async function sweep(id: string, label: string): Promise<void> {
  console.log(`\n${id}\n    (${label})`);
  const txid = id.slice(0, 64);
  const index = Number(id.slice(65));

  const inscs = await inscriptionsOf(txid);
  const mine = inscs.find((i) => i.index === index);

  const infoRes = await ordRaw(`/r/inscription/${id}`);
  if (!mine) {
    check(infoRes.status === 404, 'we parse NO envelope at this index; ord must 404', `ord HTTP ${infoRes.status}`);
    return;
  }
  check(infoRes.status === 200, 'envelope exists on both sides', `ord HTTP ${infoRes.status}`);
  if (infoRes.status !== 200) return;
  const info = JSON.parse(new TextDecoder().decode(infoRes.bytes)) as {
    charms: string[];
    content_type: string | null;
    content_length: number | null;
    delegate: string | null;
    height: number;
    number: number;
    id: string;
  };

  note(`ord number ${info.number}, height ${info.height}, charms [${info.charms.join(',')}]`);

  check(
    (mine.contentType ?? null) === info.content_type,
    'content_type',
    `ours=${mine.contentType ?? 'null'} ord=${info.content_type ?? 'null'}`,
  );
  check(
    (mine.body?.length ?? null) === info.content_length,
    'content_length',
    `ours=${mine.body?.length ?? 'null'} ord=${info.content_length ?? 'null'}`,
  );
  check(
    (mine.delegate ?? null) === info.delegate,
    'delegate',
    `ours=${mine.delegate ?? 'null'} ord=${info.delegate ?? 'null'}`,
  );

  // pre-Jubilee + envelope-derivable curse indicator => must carry the cursed charm.
  // (The converse doesn't hold: reinscription etc. are not envelope-derivable.)
  const indicators = envelopeCurseIndicators(mine);
  if (info.height < JUBILEE_HEIGHT && indicators.length > 0) {
    check(
      info.charms.includes('cursed'),
      `pre-Jubilee curse indicators [${indicators.join(',')}] => cursed charm`,
      `charms=[${info.charms.join(',')}]`,
    );
  }

  // body parity via /r/undelegated-content (never delegate-substituted)
  const content = await ordRaw(`/r/undelegated-content/${id}`);
  if (mine.body === undefined) {
    check(
      content.status === 404,
      'no body => /r/undelegated-content 404s (bare-URI nuance)',
      `ord HTTP ${content.status}`,
    );
  } else {
    check(content.status === 200, '/r/undelegated-content serves the body', `ord HTTP ${content.status}`);
    if (content.status === 200) {
      // fetch() transport-decodes whatever content-encoding the response
      // carries: the inscription's own tag-9 encoding (ord serves stored
      // bytes + the header) and CDN transport compression alike. So: if WE
      // parsed a tag-9 encoding, our stored bytes must decode to the fetched
      // bytes; otherwise the fetched bytes must equal our stored bytes as-is.
      let ourBytes: Uint8Array | undefined = mine.body;
      if (mine.contentEncoding) {
        ourBytes = await nodeDecompressor(mine.contentEncoding, mine.body);
        note(
          `tag-9 content-encoding ${mine.contentEncoding}: comparing decoded bytes ` +
            `(${ourBytes?.length ?? '?'}B from ${mine.body.length}B stored; response header ${content.headers.get('content-encoding') ?? 'none'})`,
        );
      }
      if (!ourBytes) {
        check(false, `decode our body as ${mine.contentEncoding}`, 'decompressor returned undefined');
      } else {
        check(
          bytesToHex(sha256(ourBytes)) === bytesToHex(sha256(content.bytes)),
          'body sha256 parity',
          `${ourBytes.length}B vs ${content.bytes.length}B`,
        );
      }
    }
  }

  // metadata parity via /r/metadata (ord serves hex-in-JSON)
  const meta = await ordRaw(`/r/metadata/${id}`);
  if (mine.metadata === undefined) {
    check(meta.status === 404, 'no metadata => /r/metadata 404s', `ord HTTP ${meta.status}`);
  } else {
    check(meta.status === 200, '/r/metadata serves metadata', `ord HTTP ${meta.status}`);
    if (meta.status === 200) {
      const hex = JSON.parse(new TextDecoder().decode(meta.bytes)) as string;
      check(
        hex === bytesToHex(mine.metadata),
        'metadata hex parity',
        `${mine.metadata.length}B ours`,
      );
    }
  }
}

/** count parity: ord must 404 exactly one index past our last envelope */
async function sweepCount(txid: string): Promise<void> {
  const inscs = await inscriptionsOf(txid);
  const past = await ordRaw(`/r/inscription/${txid}i${inscs.length}`);
  console.log(`\n${txid} envelope count`);
  check(
    past.status === 404,
    `we parse ${inscs.length} envelope(s); ord 404s at i${inscs.length}`,
    `ord HTTP ${past.status}`,
  );
}

const args = process.argv.slice(2);
const ids: [string, string][] = args.length
  ? args.map((a) => [a, 'cli arg'] as [string, string])
  : DEFAULT_IDS;

console.log(`parity sweep: ${ids.length} inscription(s) against ${ord.baseUrl}`);
for (const [id, label] of ids) {
  try {
    await sweep(id, label);
  } catch (e) {
    failures++;
    console.log(`    ✗ ERROR sweeping ${id}: ${(e as Error).message}`);
  }
}
for (const txid of new Set(ids.map(([id]) => id.slice(0, 64)))) {
  try {
    await sweepCount(txid);
  } catch (e) {
    failures++;
    console.log(`    ✗ ERROR count-checking ${txid}: ${(e as Error).message}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED: parity bug, treat as P0`}`);
process.exitCode = failures === 0 ? 0 : 1;
