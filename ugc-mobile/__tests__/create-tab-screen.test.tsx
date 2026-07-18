// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeState = vi.hoisted(() => ({
  params: {} as Record<string, string | string[] | undefined>,
}));

const mediaCreationState = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeState.params,
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
    mediaCreationState.props = null;
  });

  it('opens the regular image creator by default', () => {
    renderer.act(() => {
      renderer.create(<CreateTabScreen />);
    });

    expect(mediaCreationState.props).toMatchObject({
      initialTool: 'image',
      insideTab: true,
      guided: false,
    });
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
