import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: { environment: 'node', fileParallelism: false, testTimeout: 15000, include: ['src/__tests__/mobile-push-claims-postgrest.test.ts', 'src/__tests__/mobile-push-budget-postgrest.test.ts'] },
  resolve: { alias: { '@': path.resolve('src'), 'server-only': path.resolve('src/__tests__/mocks/server-only.ts') } },
});
