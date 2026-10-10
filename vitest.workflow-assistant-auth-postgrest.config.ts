import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: { environment: 'node', fileParallelism: false, include: ['src/__tests__/workflow-assistant-auth-postgrest.test.ts', 'src/__tests__/workflow-assistant-billing-postgrest.test.ts'] },
  resolve: { alias: { '@': path.resolve('src'), 'server-only': path.resolve('src/__tests__/mocks/server-only.ts') } },
});
