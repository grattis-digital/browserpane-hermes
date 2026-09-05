import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'jsdom', include: ['js/__tests__/**/*.test.ts'], maxWorkers: 4,
    // Administration CLI sources are intentionally not part of this derivative.
    exclude: ['js/__tests__/bpane-cli.test.ts', 'js/__tests__/workflow-endpoint-conformance.test.ts'],
    setupFiles: [fileURLToPath(new URL('./test/client-setup.mjs', import.meta.url))],
  },
});
