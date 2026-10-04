import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Explicit local PostgREST integration, separate from normal unit CI.
export default defineConfig({
  test: { environment: 'node', include: ['src/__tests__/profile-follow-postgrest.test.ts'] },
  resolve: {
    alias: {
      '@': path.resolve('src'),
      'server-only': path.resolve('src/__tests__/mocks/server-only.ts'),
    },
  },
});
