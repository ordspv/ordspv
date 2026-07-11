#!/usr/bin/env tsx
/**
 * Build the MV3 extension into extension/dist-unpacked/ (committed, loadable
 * via chrome://extensions → "Load unpacked" straight from a clone).
 * viewer.js bundles @ordspv/fetch with the BROWSER decompress path
 * (same swap as the fetch browser bundle); background/content/popup are
 * dependency-light. headersync is node-only and never referenced here.
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'extension/src');
const OUT = join(ROOT, 'extension/dist-unpacked');

const browserDecompress = {
  name: 'browser-decompress',
  setup(b: { onResolve: Function }) {
    b.onResolve({ filter: /^\.\/decompress\.js$/ }, (args: { importer: string }) => ({
      path: join(dirname(args.importer), 'decompress.browser.ts'),
    }));
  },
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entry: {
    background: join(SRC, 'background.ts'),
    viewer: join(SRC, 'viewer.ts'),
    popup: join(SRC, 'popup.ts'),
    content: join(SRC, 'content.ts'),
  },
  outDir: OUT,
  format: ['iife'], // classic scripts: valid for sw ("type": "module" tolerates it), pages, content scripts
  platform: 'browser',
  target: 'es2022',
  minify: false, // reviewable dist; store submission can minify later
  sourcemap: false,
  clean: false,
  silent: true,
  esbuildPlugins: [browserDecompress as never],
  outExtension: () => ({ js: '.js' }),
});

for (const file of ['manifest.json', 'viewer.html', 'popup.html']) {
  copyFileSync(join(SRC, file), join(OUT, file));
}
console.log(`extension built into ${OUT}. Load via chrome://extensions → Load unpacked`);
