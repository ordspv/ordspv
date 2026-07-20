#!/usr/bin/env tsx
/**
 * Build the self-contained browser demos: bundle each page's entry (core
 * primitives plus the ord URI parser, IIFE, minified) and inline it into its
 * template, producing committed single files that open from file:// with no
 * server and no build step for the viewer.
 *
 * - examples/verify-inscription-0.html: plain inscription-0 verification
 * - examples/evm-nft/index.html: the cross-chain demo; additionally inlines
 *   examples/evm-nft/metadata.json (the committed token document is the
 *   single source of truth for what the page displays and verifies)
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'examples/.build');

interface Page {
  entry: string;
  template: string;
  out: string;
  /** extra marker → file-content inlining, applied before the bundle */
  inject?: { marker: string; file: string };
}

const PAGES: Page[] = [
  {
    entry: 'examples/src/demo.ts',
    template: 'examples/src/template.html',
    out: 'examples/verify-inscription-0.html',
  },
  {
    entry: 'examples/src/evm-nft.ts',
    template: 'examples/src/evm-nft-template.html',
    out: 'examples/evm-nft/index.html',
    inject: { marker: '/*METADATA*/', file: 'examples/evm-nft/metadata.json' },
  },
];

await build({
  entry: Object.fromEntries(PAGES.map((p) => [p.entry.split('/').at(-1)!.replace(/\.ts$/, ''), join(ROOT, p.entry)])),
  outDir: OUT_DIR,
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  clean: true,
  silent: true,
});

for (const page of PAGES) {
  const bundle = readFileSync(join(OUT_DIR, `${page.entry.split('/').at(-1)!.replace(/\.ts$/, '')}.global.js`), 'utf8');
  let html = readFileSync(join(ROOT, page.template), 'utf8');
  if (!html.includes('/*BUNDLE*/')) throw new Error(`${page.template} missing /*BUNDLE*/ marker`);
  if (page.inject) {
    if (!html.includes(page.inject.marker)) throw new Error(`${page.template} missing ${page.inject.marker} marker`);
    const content = readFileSync(join(ROOT, page.inject.file), 'utf8').trim();
    if (/<\/script/i.test(content)) throw new Error(`${page.inject.file} would terminate its inline script tag`);
    html = html.replace(page.inject.marker, () => content);
  }
  // </script> inside the bundle would terminate the inline tag prematurely
  const safe = bundle.replace(/<\/script>/gi, '<\\/script>');
  html = html.replace('/*BUNDLE*/', () => safe);
  const out = join(ROOT, page.out);
  writeFileSync(out, html);
  console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);
}
rmSync(OUT_DIR, { recursive: true, force: true });
