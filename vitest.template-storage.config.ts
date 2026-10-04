import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Opt-in actual HTTP/Storage audit. No jsdom setup: multipart uploads must use
// Node's matching native FormData, Blob and fetch implementations.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/template-input-storage.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve('src'),
      'server-only': path.resolve('src/__tests__/mocks/server-only.ts'),
    },
  },
});
