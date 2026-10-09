import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/__tests__/media-upload-reclaim-postgrest.test.ts', 'src/__tests__/media-upload-reclaim-progress-postgrest.test.ts', 'src/__tests__/media-upload-reclaim-worker-death-postgrest.test.ts', 'src/__tests__/media-upload-reclaim-leases-postgrest.test.ts', 'src/__tests__/media-upload-reclaim-managed-postgrest.test.ts'], fileParallelism: false },
  resolve: { alias: { '@': path.resolve('src'), 'server-only': path.resolve('src/__tests__/mocks/server-only.ts') } },
});
