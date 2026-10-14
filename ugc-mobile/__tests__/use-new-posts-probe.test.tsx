(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
  currentState: 'active' as string,
  listeners: [] as Array<(state: string) => void>,
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return {
        remove: () => {
          appState.listeners = appState.listeners.filter((entry) => entry !== listener);
        },
      };
    },
  },
}));

import type { ShowcaseFeedItem, ShowcaseFeedNewestResponse } from '../lib/types';
import {
  NEW_POSTS_PROBE_MIN_LANE_AGE_MS,
  newPostsProbeCategory,
  newestFeedPostIn,
  useNewPostsProbe,
} from '../lib/use-new-posts-probe';

type ProbeProps = Parameters<typeof useNewPostsProbe>[0];

const NOW = Date.parse('2026-10-14T06:00:00.000Z');
const HELD = { id: 'post-held', createdAt: '2026-10-14T05:30:00.123456+00:00' };
const NEWER: ShowcaseFeedNewestResponse = { newestPostId: 'post-new', newestPublishedAt: '2026-10-14T05:40:00.000Z' };

let probe: ReturnType<typeof useNewPostsProbe>;

function Probe(props: ProbeProps) {
  probe = useNewPostsProbe(props);
  return null;
}

function apiAnswering(answer: () => Promise<ShowcaseFeedNewestResponse>) {
  return { getShowcaseFeedNewest: vi.fn((_params?: { category?: 'media' | 'text' | 'all' }) => answer()) };
}

function props(overrides: Partial<ProbeProps> = {}): ProbeProps {
  return {
    api: apiAnswering(async () => NEWER),
    category: 'all',
    enabled: true,
    laneFetchedAt: NOW - NEW_POSTS_PROBE_MIN_LANE_AGE_MS,
    newestKnownPublishedAt: HELD.createdAt,
    newestKnownPostId: HELD.id,
    ...overrides,
  };
}

async function render(initial: ProbeProps) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<Probe {...initial} />);
  });
  return tree;
}

function setAppState(state: string) {
  appState.currentState = state;
  renderer.act(() => {
    appState.listeners.forEach((listener) => listener(state));
  });
}

async function returnToApp(awayMs = 0) {
  setAppState('background');
  vi.setSystemTime(Date.now() + awayMs);
  setAppState('active');
  await renderer.act(async () => {
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
  });
}

function feedItem(id: string, createdAt: string): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: null,
    mediaKind: null,
    model: 'manual',
    title: id,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt,
    creator: { id: 'creator-1', username: 'maya', name: 'Maya', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

describe('useNewPostsProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    appState.currentState = 'active';
    appState.listeners = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks once on a return five minutes after the lane was fetched, and raises the pill for a newer post', async () => {
    const initial = props();
    const tree = await render(initial);
    // Nothing on mount: only a return to the app asks.
    expect(initial.api.getShowcaseFeedNewest).not.toHaveBeenCalled();
    expect(probe.hasNewer).toBe(false);

    await returnToApp();

    expect(initial.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
    expect(initial.api.getShowcaseFeedNewest).toHaveBeenCalledWith({ category: 'all' });
    expect(probe.hasNewer).toBe(true);
    renderer.act(() => tree.unmount());
  });

  it('asks nothing within five minutes of the fetch, and asks on the first return after', async () => {
    const initial = props({ laneFetchedAt: NOW - NEW_POSTS_PROBE_MIN_LANE_AGE_MS + 1_000 });
    const tree = await render(initial);

    await returnToApp();
    expect(initial.api.getShowcaseFeedNewest).not.toHaveBeenCalled();

    await returnToApp(1_000);
    expect(initial.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  it('asks at most once per return to the app', async () => {
    const older = apiAnswering(async () => ({ newestPostId: 'post-old', newestPublishedAt: '2026-10-14T05:00:00.000Z' }));
    const initial = props({ api: older });
    const tree = await render(initial);

    await returnToApp();
    expect(older.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);

    // A repeated report of the same state, and renders, are not a return.
    setAppState('active');
    await renderer.act(async () => {
      tree.update(<Probe {...initial} />);
    });
    expect(older.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);

    // Nothing newer the first time, so the next return asks again.
    await returnToApp();
    expect(older.getShowcaseFeedNewest).toHaveBeenCalledTimes(2);
    expect(probe.hasNewer).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it('does not ask again while the pill is up', async () => {
    const initial = props();
    const tree = await render(initial);

    await returnToApp();
    expect(probe.hasNewer).toBe(true);
    await returnToApp();

    expect(initial.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
    expect(probe.hasNewer).toBe(true);
    renderer.act(() => tree.unmount());
  });

  it.each([
    ['the newest post is the one the lane holds', { newestPostId: HELD.id, newestPublishedAt: '2026-10-14T05:30:00.123Z' }],
    ['the newest post is as old as the one the lane holds', { newestPostId: 'post-twin', newestPublishedAt: '2026-10-14T05:30:00.123Z' }],
    ['the newest post is older', { newestPostId: 'post-old', newestPublishedAt: '2026-10-14T05:00:00.000Z' }],
    ['the lane is empty on the server', { newestPostId: null, newestPublishedAt: null }],
  ])('shows nothing when %s', async (_case, answer) => {
    const initial = props({ api: apiAnswering(async () => answer) });
    const tree = await render(initial);

    await returnToApp();

    expect(initial.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
    expect(probe.hasNewer).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it('counts a post a millisecond newer than the microsecond time the lane holds', async () => {
    const initial = props({
      api: apiAnswering(async () => ({ newestPostId: 'post-new', newestPublishedAt: '2026-10-14T05:30:00.124Z' })),
    });
    const tree = await render(initial);

    await returnToApp();

    expect(probe.hasNewer).toBe(true);
    renderer.act(() => tree.unmount());
  });

  it('asks nothing while disabled: the Recent lane, or a screen behind another', async () => {
    const initial = props({ enabled: false });
    const tree = await render(initial);

    await returnToApp();

    expect(initial.api.getShowcaseFeedNewest).not.toHaveBeenCalled();
    expect(probe.hasNewer).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it('asks nothing for a lane not yet fetched or holding no dated post', async () => {
    const unfetched = props({ laneFetchedAt: 0 });
    const undated = props({ newestKnownPublishedAt: null });
    const first = await render(unfetched);
    const second = await render(undated);

    await returnToApp(NEW_POSTS_PROBE_MIN_LANE_AGE_MS);

    expect(unfetched.api.getShowcaseFeedNewest).not.toHaveBeenCalled();
    expect(undated.api.getShowcaseFeedNewest).not.toHaveBeenCalled();
    renderer.act(() => {
      first.unmount();
      second.unmount();
    });
  });

  it('takes the pill down on dismiss, on a refresh and on another lane', async () => {
    const initial = props();
    const tree = await render(initial);

    await returnToApp();
    expect(probe.hasNewer).toBe(true);
    renderer.act(() => probe.dismiss());
    expect(probe.hasNewer).toBe(false);

    await returnToApp();
    expect(probe.hasNewer).toBe(true);
    // The screen refreshed: the lane's fetch is a new one.
    const refreshedAt = Date.now();
    await renderer.act(async () => {
      tree.update(<Probe {...initial} laneFetchedAt={refreshedAt} />);
    });
    expect(probe.hasNewer).toBe(false);

    await returnToApp(NEW_POSTS_PROBE_MIN_LANE_AGE_MS);
    expect(initial.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(3);
    expect(probe.hasNewer).toBe(true);
    await renderer.act(async () => {
      tree.update(<Probe {...initial} laneFetchedAt={refreshedAt} category="text" />);
    });
    expect(probe.hasNewer).toBe(false);
    await renderer.act(async () => {
      tree.update(<Probe {...initial} laneFetchedAt={refreshedAt} />);
    });
    expect(probe.hasNewer).toBe(true);
    // A screen that loses the front hides the pill while it is away.
    await renderer.act(async () => {
      tree.update(<Probe {...initial} laneFetchedAt={refreshedAt} enabled={false} />);
    });
    expect(probe.hasNewer).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it('drops an answer that lands after the lane was fetched again', async () => {
    let answer!: (value: ShowcaseFeedNewestResponse) => void;
    const api = apiAnswering(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const initial = props({ api });
    const tree = await render(initial);

    await returnToApp();
    expect(api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
    await renderer.act(async () => {
      tree.update(<Probe {...initial} laneFetchedAt={Date.now()} />);
    });
    await renderer.act(async () => {
      answer(NEWER);
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });

    expect(probe.hasNewer).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it('shows nothing when the probe fails, and asks again on the next return', async () => {
    const api = apiAnswering(async () => {
      throw Object.assign(new Error('Network request failed'), { status: 0 });
    });
    const initial = props({ api });
    const tree = await render(initial);

    await returnToApp();
    expect(probe.hasNewer).toBe(false);
    await returnToApp();
    expect(api.getShowcaseFeedNewest).toHaveBeenCalledTimes(2);
    renderer.act(() => tree.unmount());
  });
});

describe('what the probe asks about', () => {
  it("names the server's lane for a feed's category", () => {
    expect(newPostsProbeCategory(undefined)).toBe('all');
    expect(newPostsProbeCategory(null)).toBe('all');
    expect(newPostsProbeCategory('all')).toBe('all');
    expect(newPostsProbeCategory('media')).toBe('media');
    expect(newPostsProbeCategory('image')).toBe('media');
    expect(newPostsProbeCategory('video')).toBe('media');
    expect(newPostsProbeCategory('text')).toBe('text');
  });

  it('finds the newest post a lane holds across its pages', () => {
    const data = {
      pages: [
        { items: [feedItem('a', '2026-10-14T05:00:00.000Z'), feedItem('b', '2026-10-14T05:30:00.123456+00:00')] },
        { items: [feedItem('c', '2026-10-14T05:30:00.120999+00:00'), feedItem('d', 'not a date')] },
      ],
      pageParams: [0, 1],
    };

    expect(newestFeedPostIn(data)).toEqual({ postId: 'b', publishedAt: '2026-10-14T05:30:00.123456+00:00' });
    expect(newestFeedPostIn(undefined)).toEqual({ postId: null, publishedAt: null });
  });
});
