#!/usr/bin/env tsx
/**
 * Build the self-contained browser demo: bundle examples/src/demo.ts (core
 * primitives only, IIFE, minified) and inline it into the template, producing
 * examples/verify-inscription-0.html: a single committed file that opens from
 * file:// with no server and no build step for the viewer.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'examples/.build');

await build({
  entry: { demo: join(ROOT, 'examples/src/demo.ts') },
  outDir: OUT_DIR,
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  clean: true,
  silent: true,
});

const bundle = readFileSync(join(OUT_DIR, 'demo.global.js'), 'utf8');
const template = readFileSync(join(ROOT, 'examples/src/template.html'), 'utf8');
if (!template.includes('/*BUNDLE*/')) throw new Error('template missing /*BUNDLE*/ marker');
// </script> inside the bundle would terminate the inline tag prematurely
const safe = bundle.replace(/<\/script>/gi, '<\\/script>');
const html = template.replace('/*BUNDLE*/', () => safe);
const out = join(ROOT, 'examples/verify-inscription-0.html');
writeFileSync(out, html);
rmSync(OUT_DIR, { recursive: true, force: true });
console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);
