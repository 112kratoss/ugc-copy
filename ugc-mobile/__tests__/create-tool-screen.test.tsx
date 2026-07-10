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
  router: { replace: vi.fn() },
}));

vi.mock('@/components/media-creation-screen', () => ({
  MediaCreationScreen: (props: Record<string, unknown>) => {
    mediaCreationState.props = props;
    return null;
  },
}));

vi.mock('@/components/ui', () => ({
  Screen: ({ children }: { children: unknown }) => children,
  SectionTitle: () => null,
  PrimaryButton: () => null,
  SecondaryButton: () => null,
}));

import CreateToolScreen from '../app/create/[tool]';

describe('create tool route', () => {
  beforeEach(() => {
    routeState.params = {};
    mediaCreationState.props = null;
  });

  it('passes remix source route params into the native create screen', () => {
    routeState.params = {
      tool: 'image',
      remix: 'gen-1',
      remixPost: 'post-1',
    };

    renderer.act(() => {
      renderer.create(<CreateToolScreen />);
    });

    expect(mediaCreationState.props).toMatchObject({
      initialTool: 'image',
      remixSource: {
        generationId: 'gen-1',
        postId: 'post-1',
      },
    });
  });

  it('passes prompt-only create route params into the native create screen', () => {
    routeState.params = {
      tool: 'image',
      prompt: ['hello', 'ignored'],
    };

    renderer.act(() => {
      renderer.create(<CreateToolScreen />);
    });

    expect(mediaCreationState.props).toMatchObject({
      initialTool: 'image',
      initialPrompt: 'hello',
    });
    expect(mediaCreationState.props?.remixSource).toBeUndefined();
  });
});
