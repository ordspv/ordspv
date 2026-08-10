import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'extension/test/**/*.test.ts'],
    // heavy-budget fuzz runs (fuzz.yml sets FUZZ_ITERS) need room beyond the 5s default
    testTimeout: process.env.FUZZ_ITERS ? 900_000 : 5_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'extension/src/**/*.ts'],
      reporter: ['text', 'text-summary'],
      // Ratchet floors: set just under the measured baseline (2026-08-10
      // after the property tests moved into the suite: 80.02 / 74.69 / 83.30 /
      // 82.09 across all src incl. the untested CLI and extension UI scripts;
      // the previous baseline was 75.24 / 66.17 / 80.11 / 78.23 on 2026-07-19).
      // Raise deliberately as coverage grows; never lower to admit a regression.
      thresholds: {
        statements: 79.8,
        branches: 74.4,
        functions: 83,
        lines: 81.8,
      },
    },
  },
  resolve: {
    // the subpath entry sits first: alias entries match in order, and the
    // barrel entry would otherwise swallow the subpath id
    alias: {
      '@ordspv/fetch/headersync': fileURLToPath(
        new URL('./packages/fetch/src/headersync.ts', import.meta.url),
      ),
      '@ordspv/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@ordspv/fetch': fileURLToPath(new URL('./packages/fetch/src/index.ts', import.meta.url)),
    },
  },
});
