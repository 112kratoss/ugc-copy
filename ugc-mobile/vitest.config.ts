import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // expo-haptics imports expo-modules-core from a nested path vitest cannot
      // resolve; haptics are fire-and-forget, so a no-op double is faithful.
      'expo-haptics': path.resolve(__dirname, '__tests__/mocks/expo-haptics.ts'),
      // react-native-reanimated re-exports react-native/index.js, whose Flow
      // syntax vitest cannot parse. The double resolves animated styles once at
      // render time so layout intent stays assertable without a UI thread.
      'react-native-reanimated': path.resolve(__dirname, '__tests__/mocks/react-native-reanimated.ts'),
      // react-native-svg's entry re-exports react-native, same Flow problem.
      // Aliasing it lets a test render a real lucide icon and read the stroke
      // width the component actually resolved.
      'react-native-svg': path.resolve(__dirname, '__tests__/mocks/react-native-svg.ts'),
    },
  },
  test: {
    include: ['__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.spec.{ts,tsx}'],
    // Node's own loader would resolve lucide's CommonJS build and pull in
    // react-native before the alias above can apply. Transforming it here keeps
    // the icon components real while their svg backend stays a double.
    server: { deps: { inline: ['lucide-react-native'] } },
  },
});
