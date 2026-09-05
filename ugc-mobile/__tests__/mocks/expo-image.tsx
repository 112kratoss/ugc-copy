import React from 'react';

/**
 * Test double for `expo-image`. The real package imports `expo-modules-core`
 * from a path vitest cannot resolve, and since the shared avatar in
 * `components/ui.tsx` moved onto expo-image (phase 5a of
 * docs/android-app-optimization-plan-2026-09-05.md) every suite that renders a
 * UI primitive would otherwise fail to load. The component renders as a host
 * `image` element with its props intact, the shape the per-suite
 * `vi.mock('expo-image', factory)` doubles already used; those factories still
 * take precedence where a suite needs to observe calls.
 */
type MockProps = Record<string, unknown> & { children?: React.ReactNode };

function ImageComponent({ children, ...props }: MockProps) {
  return React.createElement('image', props, children);
}

async function loadAsync() {
  return { width: 0, height: 0, release() {} };
}

export const Image = Object.assign(ImageComponent, {
  loadAsync,
  prefetch: async () => true,
  clearMemoryCache: async () => true,
  clearDiskCache: async () => true,
});

export function ImageBackground({ children, ...props }: MockProps) {
  return React.createElement('image-background', props, children);
}

export type ImageProps = MockProps;
export type ImageSource = { uri?: string; cacheKey?: string };
