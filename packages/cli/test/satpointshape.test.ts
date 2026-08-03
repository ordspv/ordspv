import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hexToBytes, parseTx } from '@ordspv/core';
import { fetchCustody, type FetchFn } from '@ordspv/fetch';

/**
 * One satpoint shape on both surfaces. The live `custody --json` emits the
 * satpoint as an object, and `verify` on the bundle the same command writes
 * must emit the identical object, field for field. The CLI exposes no fetch
 * seam and its proof-of-work floor has no override, so the live half runs
 * through `fetchCustody`'s fetchFn seam on the vendored mainnet inscription-0
 * fixtures (real difficulty, checkpoint at 767430 anchors the hop), with the
 * command's own defaults; the satpoint compared is the field main.ts emits
 * verbatim, serialized through the same bigint replacer. The verify half runs
 * the real CLI on the bundle the build returned.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN = join(ROOT, 'packages/cli/src/main.ts');
const FIXTURES = join(ROOT, 'fixtures/insc0');

const revealHex = readFileSync(join(FIXTURES, 'reveal.hex'), 'utf8').trim();
const commitHex = readFileSync(join(FIXTURES, 'commit.hex'), 'utf8').trim();
const headerHex = readFileSync(join(FIXTURES, 'header-767430.hex'), 'utf8').trim();
const merkleProof = JSON.parse(readFileSync(join(FIXTURES, 'merkle-proof.json'), 'utf8')) as {
  block_height: number;
  merkle: string[];
  pos: number;
};
const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  revealTxid: string;
  blockHash: string;
  blockHeight: number;
};

const E = 'https://esplora.test';

type Route = string | object;

function stubFetch(routes: Record<string, Route>): FetchFn {
  return async (url: string) => {
    const route = routes[url];
    if (route === undefined) return new Response(`no stub for ${url}`, { status: 404 });
    if (typeof route === 'string') return new Response(route);
    return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
  };
}

const bigintReplacer = (_: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

describe('satpoint shape across surfaces', () => {
  it('verify renders the satpoint object the live command emits', async () => {
    const reveal = parseTx(hexToBytes(revealHex));
    const commitTxid = reveal.inputs[0].prevTxid;
    const routes: Record<string, Route> = {
      [`${E}/tx/${reveal.txid}/status`]: {
        confirmed: true,
        block_height: expected.blockHeight,
        block_hash: expected.blockHash,
      },
      [`${E}/tx/${reveal.txid}/hex`]: revealHex,
      [`${E}/tx/${reveal.txid}/merkle-proof`]: merkleProof,
      [`${E}/block/${expected.blockHash}/header`]: headerHex,
      [`${E}/block/${expected.blockHash}`]: {
        id: expected.blockHash,
        height: expected.blockHeight,
        tx_count: 2332,
      },
      [`${E}/tx/${commitTxid}/hex`]: commitHex,
      [`${E}/tx/${reveal.txid}/outspend/0`]: { spent: false },
    };
    const res = await fetchCustody(`${reveal.txid}i0`, {
      esplora: [E],
      fetchFn: stubFetch(routes),
    });

    // the field main.ts's custody --json branch emits, through the same
    // replacer: an object, offset as a decimal string
    const live = JSON.parse(JSON.stringify(res.custody.satpoint, bigintReplacer)) as unknown;
    expect(live).toEqual({ txid: reveal.txid, vout: 0, offset: '0' });

    const file = join(mkdtempSync(join(tmpdir(), 'ord-satpoint-')), 'custody.bundle.json');
    writeFileSync(file, JSON.stringify(res.bundle, bigintReplacer));
    const r = spawnSync('npx', ['tsx', MAIN, 'verify', file], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as { kind: string; satpoint: unknown };
    expect(report.kind).toBe('custody');
    expect(report.satpoint).toEqual(live);
  });
});
