import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/__tests__/workflow-authoring-postgrest.test.ts'] },
  resolve: { alias: { '@': path.resolve('src'), 'server-only': path.resolve('src/__tests__/mocks/server-only.ts') } },
});
