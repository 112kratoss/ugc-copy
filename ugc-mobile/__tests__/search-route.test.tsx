// Define React Native development globals for react-test-renderer.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEARCH_SCREEN_FOCUS_FALLBACK_MS } from '@/lib/search-screen-route';

// app/search.tsx itself (review of #795, N9): the params it reads, when the
// field may take the focus, one pop per Close, and the shared opener told
// while the screen is up. The search body is ExploreSearchOverlay's suite.
const mocks = vi.hoisted(() => {
  const listeners: Array<(event: { data?: { closing?: boolean } }) => void> = [];
  return {
    listeners,
    params: { value: {} as Record<string, string | string[]> },
    canGoBack: { value: true },
    router: { back: vi.fn(), replace: vi.fn(), push: vi.fn() },
    overlayProps: { value: null as null | Record<string, unknown> },
  };
});

vi.mock('expo-router', () => ({
  router: {
    back: mocks.router.back,
    replace: mocks.router.replace,
    push: mocks.router.push,
    canGoBack: () => mocks.canGoBack.value,
  },
  useLocalSearchParams: () => mocks.params.value,
  useNavigation: () => ({
    addListener: (_name: string, listener: (event: { data?: { closing?: boolean } }) => void) => {
      mocks.listeners.push(listener);
      return () => {
        const at = mocks.listeners.indexOf(listener);
        if (at >= 0) mocks.listeners.splice(at, 1);
      };
    },
  }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ api: { name: 'api' } }) }));
vi.mock('@/components/explore-search-overlay', () => ({
  ExploreSearchOverlay: (props: Record<string, unknown>) => {
    mocks.overlayProps.value = props;
    return React.createElement('explore-search-overlay', props);
  },
}));

import SearchRoute from '../app/search';
import { searchScreenOpener } from '../lib/open-search-screen';

async function render() {
  let tree: renderer.ReactTestRenderer | null = null;
  await act(async () => { tree = renderer.create(React.createElement(SearchRoute)); });
  return tree!;
}
const props = () => mocks.overlayProps.value!;

describe('the search route', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.length = 0;
    mocks.params.value = {};
    mocks.canGoBack.value = true;
    mocks.router.back.mockClear();
    mocks.router.replace.mockClear();
    mocks.router.push.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on a link\'s search: its text, clamped, and its tab', async () => {
    mocks.params.value = { q: `nano ${'x'.repeat(300)}`, type: 'posts' };
    const tree = await render();
    expect(String(props().initialQuery)).toMatch(/^nano x/);
    expect(String(props().initialQuery)).toHaveLength(100);
    expect(props().initialType).toBe('posts');
    await act(async () => tree.unmount());
  });

  it('lets the field take the focus once the push has slid in, or after a fallback', async () => {
    const tree = await render();
    expect(props().focusReady).toBe(false);
    // The pop's end says nothing of the entrance.
    await act(async () => { mocks.listeners.forEach((listener) => listener({ data: { closing: true } })); });
    expect(props().focusReady).toBe(false);
    await act(async () => { mocks.listeners.forEach((listener) => listener({ data: { closing: false } })); });
    expect(props().focusReady).toBe(true);
    await act(async () => tree.unmount());

    const quiet = await render();
    expect(props().focusReady).toBe(false);
    await act(async () => { vi.advanceTimersByTime(SEARCH_SCREEN_FOCUS_FALLBACK_MS); });
    expect(props().focusReady).toBe(true);
    await act(async () => quiet.unmount());
  });

  it('pops once for two presses of Close, and lands on Home with nothing under it', async () => {
    const tree = await render();
    await act(async () => { (props().onClose as () => void)(); (props().onClose as () => void)(); });
    expect(mocks.router.back).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());

    mocks.canGoBack.value = false;
    const alone = await render();
    await act(async () => { (props().onClose as () => void)(); });
    expect(mocks.router.replace).toHaveBeenCalledWith('/');
    expect(mocks.router.back).toHaveBeenCalledTimes(1);
    await act(async () => alone.unmount());
  });

  it('holds the shared opener while it is up, so no entry under it pushes another', async () => {
    const tree = await render();
    vi.advanceTimersByTime(10_000);
    expect(searchScreenOpener.open()).toBe(false);
    await act(async () => tree.unmount());
    expect(searchScreenOpener.open()).toBe(true);
    expect(mocks.router.push).toHaveBeenCalledWith('/search');
  });
});
