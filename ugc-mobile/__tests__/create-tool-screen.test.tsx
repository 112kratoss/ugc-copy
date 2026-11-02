// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import { readFileSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// How expo-router's `getStateFromPath` reads a pushed link's query into the route's params.
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';

const routeState = vi.hoisted(() => ({
  params: {} as Record<string, string | string[] | undefined>,
  /**
   * What expo-router 55's `useLocalSearchParams` (build/hooks.js) returns for these
   * params: each one through `decodeURIComponent` again, one it cannot decode as it is
   * (`auth-screen-return-to.test.tsx` checks the installed hook still does). The route
   * no longer calls it: one that went back to reading its params through it fails the
   * link cases here as on a phone.
   */
  localSearchParams(params: Record<string, string | string[] | undefined> | undefined) {
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    return Object.fromEntries(Object.entries(params ?? {}).map(([key, value]) => [
      key,
      value === undefined ? value : Array.isArray(value) ? value.map(decode) : decode(value),
    ]));
  },
}));

const mediaCreationState = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

const navigationState = vi.hoisted(() => ({ dispatch: vi.fn(), prevent: vi.fn() }));
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

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: navigationState.dispatch }),
  usePreventRemove: navigationState.prevent,
  useRoute: () => ({ key: 'create-1', name: 'create/[tool]', params: routeState.params }),
}));

const stackState = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeState.localSearchParams(routeState.params),
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
import { getNativeRemixCreateHref } from '../lib/viewer-actions';

/**
 * The creator route's params after `router.push(href)`: its `[tool]` segment and its query. A pushed
 * string reaches `getStateFromPath` as it was built (`resolveHref` returns a string unchanged).
 */
function creatorRoute(href: string) {
  const tool = href.split('?', 1)[0].split('/').pop()!;
  return { tool, ...parseQueryParams(href, { name: 'create/[tool]', params: { tool } }) };
}

/** Text a decode once too many alters: a valid %XX, as in a pasted link. */
const PROMPT = 'Split it 50%50, logo from example.com/brand%20kit';

describe('create tool route', () => {
  beforeEach(() => {
    routeState.params = {};
    mediaCreationState.props = null;
    stackState.options = null;
    navigationState.dispatch.mockClear();
    navigationState.prevent.mockClear();
    aiDataConsentState.mounted = 0;
  });

  // App Review, 2026-10-05: the question was asked only at Generate, which a
  // balance below the price disables, so it has to come with the screen.
  it('puts the AI data-sharing question when a creation tool opens', () => {
    routeState.params = { tool: 'video' };

    renderer.act(() => {
      renderer.create(<CreateToolScreen />);
    });

    expect(aiDataConsentState.mounted).toBe(1);
    expect(mediaCreationState.props).toMatchObject({ initialTool: 'video' });
  });

  it('asks nothing on the screen that only says the mode is unavailable', () => {
    routeState.params = { tool: 'audio' };

    renderer.act(() => {
      renderer.create(<CreateToolScreen />);
    });

    expect(aiDataConsentState.mounted).toBe(0);
    expect(mediaCreationState.props).toBeNull();
  });

  // React Navigation gives a route opened with no params no params object at all.
  it('reads a route with no params as no mode', () => {
    routeState.params = undefined as unknown as Record<string, string>;

    renderer.act(() => {
      renderer.create(<CreateToolScreen />);
    });

    expect(mediaCreationState.props).toBeNull();
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

  // Sign-in goes back to the creator by giving this route the creator's return as its params
  // (`router.dismissTo`), the source row's words with them: a remix with no post has no other.
  it('passes the source row a link or a return brings into the native create screen', () => {
    routeState.params = {
      tool: 'video',
      remix: 'gen-1',
      sourceTitle: 'Night run & co',
      sourceCreator: '@ana',
      sourceThumbnail: 'https://cdn.example.com/t.jpg?x=1&y=2',
    };

    renderer.act(() => {
      renderer.create(<CreateToolScreen />);
    });

    expect(mediaCreationState.props?.remixSource).toEqual({
      generationId: 'gen-1',
      postId: null,
      title: 'Night run & co',
      creatorLabel: '@ana',
      thumbnailUrl: 'https://cdn.example.com/t.jpg?x=1&y=2',
    });
  });

  // The links encode their text once (a Recreate's prompt with `encodeURIComponent`, a remix's
  // with `URLSearchParams`) and the URL parse decodes it once. A second decode turned every valid
  // %XX in the text into another character on every open: "50%50" became "50P".
  it('opens a Recreate prompt exactly as its link carried it', () => {
    routeState.params = creatorRoute(getNativeRemixCreateHref({ recreateTool: 'image', prompt: PROMPT, context: null })!);

    renderer.act(() => {
      renderer.create(<CreateToolScreen />);
    });

    expect(mediaCreationState.props).toMatchObject({ initialTool: 'image', initialPrompt: PROMPT });
  });

  it("draws a remix's source row exactly as its link carried it", () => {
    const context = {
      postId: 'post-1',
      title: 'Split it 50%50',
      creatorLabel: '@ana',
      thumbnailUrl: 'https://cdn.example.com/posters/a%20b.jpg?path=x%2Fy',
    };
    routeState.params = creatorRoute(getNativeRemixCreateHref({ generationId: 'gen-1', recreateTool: 'video', prompt: PROMPT, context })!);

    renderer.act(() => {
      renderer.create(<CreateToolScreen />);
    });

    const { initialTool, initialPrompt, remixSource } = mediaCreationState.props!;
    expect({ initialTool, initialPrompt, remixSource }).toEqual({
      initialTool: 'video',
      initialPrompt: PROMPT,
      remixSource: { generationId: 'gen-1', ...context },
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
