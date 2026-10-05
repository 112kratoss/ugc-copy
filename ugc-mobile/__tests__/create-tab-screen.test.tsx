// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeState = vi.hoisted(() => ({
  params: {} as Record<string, string | string[] | undefined>,
  canGoBack: true,
  back: vi.fn(),
  replace: vi.fn(),
}));

const mediaCreationState = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

// The community-rules gate has its own tests (content-policy-gate.test.tsx);
// here it passes straight through to the screen under test.
vi.mock('@/components/content-policy-gate', () => ({
  ContentPolicyGate: ({ children }: { children: unknown }) => children,
}));

// The question it puts has its own tests (ai-data-consent-on-open.test.tsx);
// here it only has to be on the screen.
const aiDataConsentState = vi.hoisted(() => ({ mounted: 0 }));
vi.mock('@/components/ai-data-consent-on-open', () => ({
  AiDataConsentOnOpen: () => {
    aiDataConsentState.mounted += 1;
    return null;
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeState.params,
  router: {
    canGoBack: () => routeState.canGoBack,
    back: routeState.back,
    replace: routeState.replace,
  },
}));

vi.mock('@/components/media-creation-screen', () => ({
  MediaCreationScreen: (props: Record<string, unknown>) => {
    mediaCreationState.props = props;
    return null;
  },
}));

import CreateTabScreen from '../app/(tabs)/creator';

describe('create tab route', () => {
  beforeEach(() => {
    routeState.params = {};
    routeState.canGoBack = true;
    routeState.back.mockReset();
    routeState.replace.mockReset();
    mediaCreationState.props = null;
    aiDataConsentState.mounted = 0;
  });

  // App Review, 2026-10-05: the question was asked only at Generate, which a
  // balance below the price disables, so it has to come with the screen.
  it('puts the AI data-sharing question when the tab opens', () => {
    renderer.act(() => {
      renderer.create(<CreateTabScreen />);
    });

    expect(aiDataConsentState.mounted).toBe(1);
  });

  it('opens the regular image creator by default', () => {
    renderer.act(() => {
      renderer.create(<CreateTabScreen />);
    });

    expect(mediaCreationState.props).toMatchObject({
      initialTool: 'image',
      insideTab: true,
      guided: false,
      onClose: expect.any(Function),
    });
  });

  it('closes back to tab history and falls back to Home when history is unavailable', () => {
    renderer.act(() => {
      renderer.create(<CreateTabScreen />);
    });

    (mediaCreationState.props?.onClose as () => void)();
    expect(routeState.back).toHaveBeenCalledTimes(1);

    routeState.canGoBack = false;
    (mediaCreationState.props?.onClose as () => void)();
    expect(routeState.replace).toHaveBeenCalledWith('/(tabs)');
  });

  it('preserves the onboarding tool and guided state inside the tab shell', () => {
    routeState.params = { tool: ['motion', 'image'], guided: '1' };

    renderer.act(() => {
      renderer.create(<CreateTabScreen />);
    });

    expect(mediaCreationState.props).toMatchObject({
      initialTool: 'motion',
      insideTab: true,
      guided: true,
    });
  });
});
