// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { appState, authState, reportPostView } = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    appState: {
      currentState: 'active',
      listeners,
      addEventListener: (_type: string, listener: (state: string) => void) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
      change(state: string) {
        this.currentState = state;
        listeners.forEach((listener) => listener(state));
      },
    },
    authState: { identityUserId: 'reader-1' as string | null, isLoading: false },
    reportPostView: vi.fn(() => true),
  };
});

vi.mock('react-native', () => ({ AppState: appState, Platform: { OS: 'ios' } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/post-view-reporter', () => ({ reportPostView }));

import { usePostViewLook } from '@/lib/use-post-view-look';

type Props = Parameters<typeof usePostViewLook>[0];

function Probe(props: Props) {
  usePostViewLook(props);
  return null;
}

let tree: renderer.ReactTestRenderer | null = null;

function mount(props: Props) {
  act(() => {
    tree = renderer.create(<Probe {...props} />);
  });
}

function update(props: Props) {
  act(() => {
    tree?.update(<Probe {...props} />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  appState.currentState = 'active';
  appState.listeners.clear();
  authState.identityUserId = 'reader-1';
  authState.isLoading = false;
  reportPostView.mockClear();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  vi.useRealTimers();
});

describe('usePostViewLook', () => {
  it('reports the post a second after it comes on screen, under the reader and the surface', () => {
    mount({ postId: 'post-1', surface: 'post-page', onScreen: true });
    act(() => { vi.advanceTimersByTime(999); });
    expect(reportPostView).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(reportPostView).toHaveBeenCalledWith({ postId: 'post-1', surface: 'post-page', identity: 'reader-1' });
  });

  it('waits for the post to be on screen, half of it', () => {
    mount({ postId: 'post-1', surface: 'post-page', onScreen: false });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(reportPostView).not.toHaveBeenCalled();
    update({ postId: 'post-1', surface: 'post-page', onScreen: true });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(reportPostView).toHaveBeenCalledTimes(1);
  });

  it('pauses the second while the app is in the background', () => {
    mount({ postId: 'post-1', surface: 'reel', onScreen: true });
    act(() => { vi.advanceTimersByTime(700); });
    act(() => { appState.change('background'); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(reportPostView).not.toHaveBeenCalled();

    act(() => { appState.change('active'); });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(reportPostView).toHaveBeenCalledWith({ postId: 'post-1', surface: 'reel', identity: 'reader-1' });
  });

  it('starts no second for a page opened while the app is not in front', () => {
    appState.currentState = 'background';
    mount({ postId: 'post-1', surface: 'reel', onScreen: true });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(reportPostView).not.toHaveBeenCalled();
  });

  it('hands a look made before the session is known to the reporter with no identity, which holds it for the one to come', () => {
    authState.isLoading = true;
    authState.identityUserId = null;
    mount({ postId: 'post-1', surface: 'reel', onScreen: true });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(reportPostView).toHaveBeenCalledTimes(1);
    expect(reportPostView).toHaveBeenCalledWith({ postId: 'post-1', surface: 'reel', identity: null });

    // The session lands: the look is not reported again by the page.
    authState.isLoading = false;
    authState.identityUserId = 'guest-1';
    update({ postId: 'post-1', surface: 'reel', onScreen: true });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(reportPostView).toHaveBeenCalledTimes(1);
  });

  it('keeps no look of a post the page stopped reporting (review of #929)', () => {
    // A post looked at before the session was known, which turns out to be
    // the reader's own: the reporter got the look, and the page none after.
    authState.isLoading = true;
    authState.identityUserId = null;
    mount({ postId: 'post-1', surface: 'post-page', onScreen: true });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(reportPostView).toHaveBeenCalledWith({ postId: 'post-1', surface: 'post-page', identity: null });
    authState.isLoading = false;
    authState.identityUserId = 'creator-1';
    update({ postId: null, surface: 'post-page', onScreen: true });
    act(() => { vi.advanceTimersByTime(5_000); });
    // Someone else signs in on the phone and the page reports the post again:
    // nothing of the earlier look is theirs; a look of their own needs its second.
    authState.identityUserId = 'reader-2';
    update({ postId: 'post-1', surface: 'post-page', onScreen: true });
    expect(reportPostView).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(reportPostView).toHaveBeenCalledTimes(2);
    expect(reportPostView).toHaveBeenLastCalledWith({ postId: 'post-1', surface: 'post-page', identity: 'reader-2' });
  });

  it('reports nothing where the page reports no view', () => {
    mount({ postId: null, surface: 'reel', onScreen: true });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(reportPostView).not.toHaveBeenCalled();
  });

  it('starts a new look for the next post of a reel', () => {
    mount({ postId: 'post-1', surface: 'reel', onScreen: true });
    act(() => { vi.advanceTimersByTime(500); });
    update({ postId: 'post-2', surface: 'reel', onScreen: true });
    act(() => { vi.advanceTimersByTime(999); });
    expect(reportPostView).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(reportPostView).toHaveBeenCalledTimes(1);
    expect(reportPostView).toHaveBeenCalledWith({ postId: 'post-2', surface: 'reel', identity: 'reader-1' });
  });
});
