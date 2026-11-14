// Define React Native development globals for react-test-renderer.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


// app/search.tsx itself (review of #795, N9): the params it reads, the control
// it grows out of (owner, 2026-11-14), one pop per Close, and the shared opener
// told while the screen is up. The search body is
// ExploreSearchOverlay's suite.
const mocks = vi.hoisted(() => {
  const listeners: Array<(event: { data?: { closing?: boolean } }) => void> = [];
  return {
    listeners,
    params: { value: {} as Record<string, string | string[]> },
    canGoBack: { value: true },
    focused: { value: true },
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
    isFocused: () => mocks.focused.value,
    addListener: (_name: string, listener: (event: { data?: { closing?: boolean } }) => void) => {
      mocks.listeners.push(listener);
      return () => {
        const at = mocks.listeners.indexOf(listener);
        if (at >= 0) mocks.listeners.splice(at, 1);
      };
    },
  }),
}));
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }) }));
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

  it('grows out of the control the opener was pressed from, and out of nothing for a link', async () => {
    searchScreenOpener.reset();
    const from = { x: 233, y: 57, width: 48, height: 48, kind: 'button' as const };
    expect(searchScreenOpener.open(from)).toBe(true);
    const tree = await render();
    expect(props().entranceFrom).toEqual(from);
    await act(async () => tree.unmount());

    // Nothing pressed (a link): no control, and none left over from before.
    const link = await render();
    expect(props().entranceFrom).toBeNull();
    await act(async () => link.unmount());

    // A frame off the screen is not grown out of.
    searchScreenOpener.reset();
    searchScreenOpener.open({ ...from, x: -400 });
    const off = await render();
    expect(props().entranceFrom).toBeNull();
    await act(async () => off.unmount());
    searchScreenOpener.reset();
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

  it('never pops once the screen is leaving another way, nor when it is not in front (review of #812, 1)', async () => {
    // Android's back key or the back swipe during Close's short wait before its pop.
    const tree = await render();
    await act(async () => { mocks.listeners.forEach((listener) => listener({})); });
    await act(async () => { (props().onClose as () => void)(); });
    expect(mocks.router.back).not.toHaveBeenCalled();
    await act(async () => tree.unmount());

    mocks.focused.value = false;
    const covered = await render();
    await act(async () => { (props().onClose as () => void)(); });
    expect(mocks.router.back).not.toHaveBeenCalled();
    mocks.focused.value = true;
    await act(async () => covered.unmount());
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
