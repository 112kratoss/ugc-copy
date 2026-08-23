import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // expo-haptics imports expo-modules-core from a nested path vitest cannot
      // resolve; haptics are fire-and-forget, so a no-op double is faithful.
      'expo-haptics': path.resolve(__dirname, '__tests__/mocks/expo-haptics.ts'),
    },
  },
  test: {
    include: ['__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.spec.{ts,tsx}'],
  },
});
