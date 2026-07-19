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
      // Ratchet floors: set just under the measured baseline (2026-07-19
      // after the second fixture wave: 75.24 / 66.17 / 80.11 / 78.23 across
      // all src incl. the untested CLI and extension UI scripts). Raise
      // deliberately as coverage grows; never lower to admit a regression.
      thresholds: {
        statements: 75,
        branches: 65.9,
        functions: 79.9,
        lines: 78,
      },
    },
  },
  resolve: {
    alias: {
      '@ordspv/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@ordspv/fetch': fileURLToPath(new URL('./packages/fetch/src/index.ts', import.meta.url)),
    },
  },
});
