#!/usr/bin/env tsx
/**
 * Headless smoke of the committed demo pages against LIVE esplora instances.
 *
 * Serves the repo statically (the pages.yml site copies examples/ verbatim, so
 * the served paths match production), opens each demo in headless chromium
 * (playwright-core; browser installed separately, see demo-smoke.yml), clicks
 * the verify button, and requires every step to report success AND the
 * verified image to actually decode. Anything less fails loudly.
 *
 * Usage:
 *   npx tsx scripts/demo-smoke.ts                # single attempt per page, any failure is red
 *   npx tsx scripts/demo-smoke.ts --ci           # scheduled-CI mode, see below
 *   npx tsx scripts/demo-smoke.ts --root <dir>   # serve <dir> instead of the repo (e.g. _site)
 *
 * --ci reuses the parity-sweep discipline of separating NETWORK weather from
 * the real signal: a failure classified as transient (both esplora sources
 * unreachable / rate-limited / 5xx, or a fetch that hangs a step past the
 * attempt deadline) is retried with backoff, and a page that stays
 * transient-broken SKIPS — loudly, but without failing the run. Everything
 * else (a step that fails a cryptographic check, an esplora answering
 * definitively with data the page rejects, a page that renders nothing, an
 * uncaught page error) is definitive: the demo is broken for visitors, and the
 * run goes red immediately.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

const rootArgAt = process.argv.indexOf('--root');
const ROOT = resolve(
  rootArgAt !== -1 && process.argv[rootArgAt + 1]
    ? process.argv[rootArgAt + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..'),
);
const PAGES = ['/examples/verify-inscription-0.html', '/examples/evm-nft/index.html'];

const CI = process.argv.includes('--ci');
const ATTEMPTS = CI ? 3 : 1;
const BACKOFF_MS = [5_000, 15_000];
/** per-attempt budget: live fetches normally finish in seconds */
const ATTEMPT_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// static server for the repo checkout
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(root: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      let pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      pathname = normalize(decodeURIComponent(pathname));
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = resolve(join(root, pathname));
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no server address');
      resolvePromise({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// transient-vs-definitive classification (parity-sweep discipline)
// ---------------------------------------------------------------------------

/**
 * A failed step's detail is transient iff it is the esplora failover
 * exhausting ("all esplora sources failed for <path>: a; b") AND every
 * per-source reason is network weather: a non-HTTP fetch error, a rate limit,
 * or a server error. A definitive HTTP answer (404 from every source for data
 * the demo depends on) means the demo is genuinely broken for visitors.
 */
function isTransientDetail(detail: string): boolean {
  const m = detail.match(/all esplora sources failed for \S+: (.*)$/s);
  if (!m) return false;
  return m[1].split('; ').every((reason) => {
    const status = reason.match(/: HTTP (\d{3})/);
    if (!status) return true; // fetch()-level failure: DNS, TLS, timeout, CORS
    const code = Number(status[1]);
    return code === 408 || code === 425 || code === 429 || code >= 500;
  });
}

// ---------------------------------------------------------------------------
// one attempt: load, click, poll to a verdict
// ---------------------------------------------------------------------------

interface StepState {
  cls: string;
  title: string;
  detail: string;
}

interface PageState {
  steps: StepState[];
  failnote: string | null;
  img: { present: boolean; complete: boolean; naturalWidth: number };
}

type Verdict =
  | { kind: 'pass'; detail: string }
  | { kind: 'transient'; detail: string }
  | { kind: 'definitive'; detail: string };

async function attemptPage(browser: Browser, url: string): Promise<Verdict> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.click('#run', { timeout: 10_000 });

    const deadline = Date.now() + ATTEMPT_TIMEOUT_MS;
    let last: PageState = { steps: [], failnote: null, img: { present: false, complete: false, naturalWidth: 0 } };
    while (Date.now() < deadline) {
      last = await page.evaluate((): PageState => {
        const steps = [...document.querySelectorAll('#steps .step')].map((li) => ({
          cls: li.className,
          title: li.querySelector('.title')?.textContent ?? '',
          detail: li.querySelector('.detail')?.textContent ?? '',
        }));
        const img = document.querySelector('#result .card img') as HTMLImageElement | null;
        return {
          steps,
          failnote: document.querySelector('.failnote')?.textContent ?? null,
          img: { present: img !== null, complete: img?.complete ?? false, naturalWidth: img?.naturalWidth ?? 0 },
        };
      });

      if (pageErrors.length > 0) {
        return { kind: 'definitive', detail: `uncaught page error: ${pageErrors.join(' | ')}` };
      }

      const failed = last.steps.filter((s) => s.cls.includes('fail'));
      if (last.failnote !== null || failed.length > 0) {
        const reasons = failed.map((s) => `"${s.title}" failed: ${s.detail}`);
        const detail = reasons.join(' | ') || `failnote without a failed step: ${last.failnote}`;
        return failed.length > 0 && failed.every((s) => isTransientDetail(s.detail))
          ? { kind: 'transient', detail }
          : { kind: 'definitive', detail };
      }

      if (last.img.present && last.img.complete) {
        if (last.img.naturalWidth === 0) {
          return { kind: 'definitive', detail: 'verified image failed to decode (naturalWidth 0)' };
        }
        const allPass = last.steps.length > 0 && last.steps.every((s) => s.cls.includes('pass'));
        if (!allPass) {
          return {
            kind: 'definitive',
            detail: `image rendered but steps are not all green: [${last.steps.map((s) => s.cls).join(', ')}]`,
          };
        }
        return {
          kind: 'pass',
          detail: `${last.steps.length} step(s) passed; image decoded (${last.img.naturalWidth}px natural width)`,
        };
      }

      await sleep(POLL_MS);
    }

    if (last.steps.length === 0) {
      return { kind: 'definitive', detail: 'verify button clicked but no steps ever appeared' };
    }
    const running = last.steps.find((s) => s.cls.includes('running'));
    if (running) {
      return {
        kind: 'transient',
        detail: `step "${running.title}" still running after ${ATTEMPT_TIMEOUT_MS / 1000}s (hung fetch)`,
      };
    }
    return { kind: 'definitive', detail: `timed out in an unexpected state: [${last.steps.map((s) => s.cls).join(', ')}]` };
  } catch (e) {
    // harness-level trouble (navigation, click): the served page is broken
    return { kind: 'definitive', detail: `drive error: ${(e as Error).message}` };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

const { server, base } = await serveStatic(ROOT);
const browser = await chromium.launch();

let failures = 0;
const skips: string[] = [];

console.log(
  `demo smoke: ${PAGES.length} page(s) against ${base} (live esplora behind them)` +
    (CI ? ' (--ci: retrying transient failures)' : ''),
);

for (const path of PAGES) {
  console.log(`\n${path}`);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(BACKOFF_MS[attempt - 2] ?? BACKOFF_MS.at(-1)!);
    const verdict = await attemptPage(browser, `${base}${path}`);
    if (verdict.kind === 'pass') {
      console.log(`    ✓ PASSED (attempt ${attempt}/${ATTEMPTS}): ${verdict.detail}`);
      break;
    }
    if (verdict.kind === 'definitive') {
      failures++;
      console.log(`    ✗ FAILED (attempt ${attempt}/${ATTEMPTS}, definitive): ${verdict.detail}`);
      break;
    }
    console.log(`    · transient (attempt ${attempt}/${ATTEMPTS}): ${verdict.detail}`);
    if (attempt === ATTEMPTS) {
      if (CI) {
        // parity-sweep discipline: persistent network weather skips, loudly
        skips.push(`${path}: ${verdict.detail}`);
        console.log(`    ⚠ SKIPPED after ${ATTEMPTS} transient attempts (network weather, not a page verdict)`);
      } else {
        failures++;
        console.log('    ✗ FAILED (transient fetch trouble; re-run, or use --ci for retries)');
      }
    }
  }
}

await browser.close();
server.close();

if (skips.length > 0) {
  console.log(`\n${skips.length} page(s) SKIPPED on persistent transient failures:`);
  for (const s of skips) console.log(`    ⚠ ${s}`);
}
const summary =
  failures > 0
    ? `${failures} PAGE(S) FAILED: the published demo is broken`
    : skips.length > 0
      ? `NO FAILURES, but ${skips.length} page(s) skipped on network weather`
      : 'ALL PAGES PASSED';
console.log(`\n${summary}`);
process.exitCode = failures === 0 ? 0 : 1;
