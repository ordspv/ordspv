import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts', 'extension/test/**/*.test.ts'] },
  resolve: {
    alias: {
      '@ord-resolver/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@ord-resolver/fetch': fileURLToPath(new URL('./packages/fetch/src/index.ts', import.meta.url)),
    },
  },
});
