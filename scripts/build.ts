#!/usr/bin/env tsx
/**
 * Build pipeline: tsup (esbuild) ESM builds + bundled .d.ts per package, a
 * browser bundle for core+fetch (node decompress path swapped), and a
 * publish-staging assembly under build/staging/<pkg>/ whose package.json
 * points at dist/. The repo's own package.json files keep exporting src/*.ts
 * so tsx scripts and vitest always run live sources (no stale-dist hazard).
 *
 *   npx tsx scripts/build.ts                    # build + stage + npm pack --dry-run
 *   npx tsx scripts/build.ts --publish-dry-run  # additionally npm publish --dry-run
 *
 * Scope: @ordspv/*, canonical repo github.com/ordspv/ordspv. Nothing here
 * posts anywhere; publish is a manual GOING-PUBLIC.md step.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Options } from 'tsup';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = join(ROOT, 'build/staging');

const EXTERNAL = [/^@noble\//, /^@ordspv\//, /^node:/];

// dts note: tsup's bundled-dts path (rollup-plugin-dts) is incompatible with
// TypeScript 7's native compiler, so declarations come from `tsc -p
// tsconfig.build.json --emitDeclarationOnly` per package instead (per-file
// .d.ts tree in dist/, same import specifiers).
const COMMON: Options = {
  format: ['esm'],
  sourcemap: true,
  clean: true,
  dts: false,
  target: 'es2022',
  silent: true,
  external: EXTERNAL,
};

/** esbuild plugin: route ./decompress.js to the browser implementation */
const browserDecompress = {
  name: 'browser-decompress',
  setup(b: { onResolve: Function }) {
    b.onResolve({ filter: /^\.\/decompress\.js$/ }, (args: { importer: string }) => ({
      path: join(dirname(args.importer), 'decompress.browser.ts'),
    }));
  },
};

async function buildAll(): Promise<void> {
  // core: browser-safe as-is (noble only); one neutral build serves both
  await build({
    ...COMMON,
    entry: { index: join(ROOT, 'packages/core/src/index.ts') },
    outDir: join(ROOT, 'packages/core/dist'),
    platform: 'neutral',
  });

  // fetch: node build (dynamic node:zlib stays) + browser build (decompress swapped)
  // headersync is a NODE-ONLY subpath entry, deliberately absent from the
  // browser bundle (raw TCP/TLS + filesystem persistence)
  await build({
    ...COMMON,
    entry: {
      index: join(ROOT, 'packages/fetch/src/index.ts'),
      headersync: join(ROOT, 'packages/fetch/src/headersync.ts'),
    },
    outDir: join(ROOT, 'packages/fetch/dist'),
    platform: 'neutral',
  });
  await build({
    ...COMMON,
    dts: false, // exports mirror decompress.ts; the node build's .d.ts serves both
    clean: false,
    entry: { 'index.browser': join(ROOT, 'packages/fetch/src/index.ts') },
    outDir: join(ROOT, 'packages/fetch/dist'),
    platform: 'browser', // guards against accidental node:* imports creeping in
    esbuildPlugins: [browserDecompress as never],
  });

  await build({
    ...COMMON,
    entry: { index: join(ROOT, 'packages/gateway/src/index.ts') },
    outDir: join(ROOT, 'packages/gateway/dist'),
    platform: 'node',
  });

  await build({
    ...COMMON,
    dts: false,
    entry: { main: join(ROOT, 'packages/cli/src/main.ts') },
    outDir: join(ROOT, 'packages/cli/dist'),
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
  });

  await build({
    ...COMMON,
    entry: { index: join(ROOT, 'packages/sidecar/src/index.ts') },
    outDir: join(ROOT, 'packages/sidecar/dist'),
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
  });

  // declarations via TS7's own tsc (per-file .d.ts tree into dist/)
  for (const dir of ['core', 'fetch', 'gateway', 'sidecar']) {
    execFileSync('npx', ['tsc', '-p', join(ROOT, 'packages', dir, 'tsconfig.build.json')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}

interface PkgJson {
  name: string;
  version: string;
  description?: string;
  dependencies?: Record<string, string>;
  [k: string]: unknown;
}

/** publish-shaped package.json: dist exports, files whitelist, no author (pseudonymous) */
function stagedManifest(dir: string, extra: Record<string, unknown>): void {
  const source = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')) as PkgJson;
  const manifest: Record<string, unknown> = {
    name: source.name,
    version: source.version,
    type: 'module',
    description: source.description,
    license: 'ISC',
    files: ['dist'],
    sideEffects: false,
    ...extra,
    dependencies: source.dependencies,
  };
  const out = join(STAGING, dir);
  mkdirSync(out, { recursive: true });
  cpSync(join(ROOT, 'packages', dir, 'dist'), join(out, 'dist'), { recursive: true });
  cpSync(join(ROOT, 'LICENSE'), join(out, 'LICENSE')); // npm includes LICENSE implicitly
  writeFileSync(join(out, 'package.json'), JSON.stringify(manifest, null, 2));
}

function stage(): void {
  rmSync(STAGING, { recursive: true, force: true });
  stagedManifest('core', {
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    main: './dist/index.js',
    types: './dist/index.d.ts',
  });
  stagedManifest('fetch', {
    exports: {
      '.': {
        types: './dist/index.d.ts',
        browser: './dist/index.browser.js',
        default: './dist/index.js',
      },
      // node-only: Electrum TCP/TLS + file persistence (no browser condition)
      './headersync': {
        types: './dist/headersync.d.ts',
        default: './dist/headersync.js',
      },
    },
    main: './dist/index.js',
    types: './dist/index.d.ts',
  });
  stagedManifest('gateway', {
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    main: './dist/index.js',
    types: './dist/index.d.ts',
  });
  stagedManifest('cli', {
    bin: { 'ord-resolve': './dist/main.js' },
    exports: { '.': './dist/main.js' },
    main: './dist/main.js',
  });
  stagedManifest('sidecar', {
    bin: { 'ord-proof-sidecar': './dist/index.js' },
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    main: './dist/index.js',
    types: './dist/index.d.ts',
  });
}

function npmDryRuns(publish: boolean): void {
  for (const dir of ['core', 'fetch', 'gateway', 'cli', 'sidecar']) {
    const cwd = join(STAGING, dir);
    console.log(`\n── ${dir}: npm pack --dry-run ──`);
    execFileSync('npm', ['pack', '--dry-run'], { cwd, stdio: 'inherit' });
    if (publish) {
      console.log(`── ${dir}: npm publish --dry-run ──`);
      execFileSync('npm', ['publish', '--dry-run', '--access', 'public'], { cwd, stdio: 'inherit' });
    }
  }
}

await buildAll();
stage();
npmDryRuns(process.argv.includes('--publish-dry-run'));
console.log('\nbuild + staging complete: build/staging/<pkg>/');
