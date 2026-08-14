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
      // Ratchet floors: set just under the measured baseline (2026-08-13 after
      // the SPEC-CUSTODY conformance files:
      // 82.1 / 78.11 / 84.13 / 83.6 across all src incl. the untested CLI and
      // extension UI scripts. Re-measured the same day after the SPEC-CUSTODY
      // promotions and the three keyword re-measurement tests, and unchanged
      // to the digit: those nine tests drive code the suites already covered,
      // so there is nothing to raise the floors onto. Earlier baselines were
      // 82.05 / 78.07 / 84.13 / 83.54 on 2026-08-13,
      // 81.97 / 77.94 / 84.13 / 83.45 on 2026-08-13,
      // 81.84 / 77.75 / 84.1 / 83.32 on 2026-08-13,
      // 81.71 / 77.54 / 84.1 / 83.26 on 2026-08-13,
      // 81.16 / 76.31 / 83.87 / 82.81 on 2026-08-12, and 80.02 / 74.69 /
      // 83.30 / 82.09 on 2026-08-10).
      // Raise deliberately as coverage grows; never lower to admit a regression.
      thresholds: {
        statements: 81.8,
        branches: 77.8,
        functions: 83.9,
        lines: 83.3,
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
