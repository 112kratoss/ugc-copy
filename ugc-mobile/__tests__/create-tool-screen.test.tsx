// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import { readFileSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeState = vi.hoisted(() => ({
  params: {} as Record<string, string | string[] | undefined>,
}));

const mediaCreationState = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

const navigationState = vi.hoisted(() => ({ dispatch: vi.fn(), prevent: vi.fn() }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ dispatch: navigationState.dispatch }), usePreventRemove: navigationState.prevent }));

const stackState = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeState.params,
  router: { replace: vi.fn(), back: vi.fn(), canGoBack: () => true },
  Stack: { Screen: (props: { options?: Record<string, unknown> }) => { stackState.options = props.options ?? null; return null; } },
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
    stackState.options = null;
    navigationState.dispatch.mockClear();
    navigationState.prevent.mockClear();
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
  it('waits for saving on native Back and does not leave after a refused exit', async () => {
    routeState.params = { tool: 'image' };
    renderer.act(() => { renderer.create(<CreateToolScreen />); });
    let finish!: (leave: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    (mediaCreationState.props!.registerBeforeClose as (guard: typeof save) => void)(save);
    const action = { type: 'GO_BACK' };
    navigationState.prevent.mock.lastCall![1]({ data: { action } });
    expect(navigationState.dispatch).not.toHaveBeenCalled();
    finish(false); await Promise.resolve();
    expect(navigationState.dispatch).not.toHaveBeenCalled();
    navigationState.prevent.mock.lastCall![1]({ data: { action } });
    finish(true); await Promise.resolve();
    expect(navigationState.dispatch).toHaveBeenCalledExactlyOnceWith(action);
  });

  /**
   * A native-stack pop finishes before JS is consulted, so the close guard
   * above cannot hold the screen against a back gesture — the draft flush and
   * the "save failed" choice would both be skipped. iOS 26 made that gesture a
   * full-screen pan, off statically in the layout; the edge swipe is withdrawn
   * here, and only for a session that has something to lose.
   */
  it('withdraws the back gesture once the draft is dirty, and not before', () => {
    routeState.params = { tool: 'image' };
    renderer.act(() => { renderer.create(<CreateToolScreen />); });
    expect(stackState.options).toMatchObject({ gestureEnabled: true });
    expect(navigationState.prevent.mock.lastCall![0]).toBe(false);

    renderer.act(() => {
      (mediaCreationState.props!.onDirtyChange as (dirty: boolean) => void)(true);
    });
    expect(stackState.options).toMatchObject({ gestureEnabled: false });
    expect(navigationState.prevent.mock.lastCall![0]).toBe(true);
  });

  it('takes the iOS 26 full-screen pan off the route entirely', () => {
    const layout = readFileSync(path.join(__dirname, '..', 'app/_layout.tsx'), 'utf8');
    const route = layout.slice(layout.indexOf('name="create/[tool]"'));
    expect(route.slice(0, route.indexOf('/>'))).toContain('fullScreenGestureEnabled: false');
  });
});
