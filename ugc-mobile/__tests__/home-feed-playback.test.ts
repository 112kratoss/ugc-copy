import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFeedVideoActivationStore,
  type FeedVideoActivationSnapshot,
  type FeedVideoActivationStore,
} from '../lib/feed-video-activation';
import { createHomeFeedPlaybackController, fastCoastHoldMs } from '../lib/home-feed-playback';
import { FEED_PREPARED_WINDOW_STEP_MS, SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS } from '../lib/media-performance';
import { SHOWCASE_SETTLE_CONFIRM_MS } from '../lib/showcase-feed-activation';
import type { ShowcaseFeedItem } from '../lib/types';

const item = (id: string, video = true) => ({
  id, mediaUrl: `https://example.com/${id}`, category: video ? 'video' : 'image',
  mediaKind: video ? 'video' : 'image',
}) as ShowcaseFeedItem;
const feed = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id));
const see = (...ids: string[]) => ({ type: 'viewableItemsChanged' as const, items: ids.map((id) => item(id)) });

/** Tiles holding a player: everything playing or prepared. The release grace adds one more, outside the store. */
const mounted = (snapshot: FeedVideoActivationSnapshot) => new Set([...snapshot.activeIds, ...snapshot.preparedIds]);
const withinBudget = (publishes: FeedVideoActivationSnapshot[]) => publishes.every((snapshot) => (
  snapshot.activeIds.length <= 1 && mounted(snapshot).size <= 1 + SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS
));

function setup(items = feed) {
  vi.useFakeTimers();
  const store = createFeedVideoActivationStore();
  // Every state the store announced, in order.
  const publishes: FeedVideoActivationSnapshot[] = [];
  const publish = store.publish;
  store.publish = (next) => {
    publish(next);
    publishes.push(store.snapshot());
  };
  const controller = createHomeFeedPlaybackController(store);
  const disconnect = controller.connect();
  controller.dispatch({ type: 'itemsChanged', items });
  const step = () => vi.advanceTimersByTime(FEED_PREPARED_WINDOW_STEP_MS);
  const settle = () => vi.advanceTimersByTime(FEED_PREPARED_WINDOW_STEP_MS * 8);
  return { store, controller, disconnect, publishes, step, settle };
}

/** Rest on 'b' with its neighbours prepared and drawn: the state a scroll starts from. */
function restingOnB(ready = ['a', 'b', 'c']) {
  const lab = setup();
  lab.controller.dispatch(see('b'));
  lab.settle();
  for (const id of ready) lab.store.setReady(id, true);
  lab.publishes.length = 0;
  return lab;
}

/**
 * Stands in for the tiles: a tile given a player reports it drawn `drawMs`
 * later, and one that loses its player withdraws at once, both after the
 * commit, the way FeedVideoPreview's effect does.
 */
function fakeTiles(store: FeedVideoActivationStore, drawMs: number) {
  const holding = new Set<string>();
  return () => setTimeout(() => {
    const now = mounted(store.snapshot());
    for (const id of [...holding]) {
      if (now.has(id)) continue;
      holding.delete(id);
      store.setReady(id, false);
    }
    for (const id of now) {
      if (holding.has(id)) continue;
      holding.add(id);
      setTimeout(() => {
        if (holding.has(id)) store.setReady(id, true);
      }, drawMs);
    }
  }, 0);
}

afterEach(() => vi.useRealTimers());

describe('Home feed playback', () => {
  it('reports motion from the first drag until the feed confirms its rest', () => {
    const { controller, disconnect } = setup();
    expect(controller.isMoving()).toBe(false);

    controller.dispatch({ type: 'dragBegin' });
    expect(controller.isMoving()).toBe(true);
    controller.dispatch({ type: 'dragEnd', velocityY: 2 });
    controller.dispatch({ type: 'momentumBegin' });
    expect(controller.isMoving()).toBe(true);
    controller.dispatch({ type: 'momentumEnd' });
    expect(controller.isMoving()).toBe(false);

    // A drag released at rest is resting at once.
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch({ type: 'dragEnd', velocityY: 0 });
    expect(controller.isMoving()).toBe(false);

    // A release of unknown speed counts as moving until the settle confirmation.
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch({ type: 'dragEnd' });
    expect(controller.isMoving()).toBe(true);
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS);
    expect(controller.isMoving()).toBe(false);

    // A blur or backgrounding may drop the end events; the feed counts as resting.
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch({ type: 'stop' });
    expect(controller.isMoving()).toBe(false);
    disconnect();
  });

  it('elects at rest at once and brings the neighbours in one tile per step', () => {
    const { store, controller, disconnect, publishes, step } = setup();
    controller.dispatch(see('b'));
    expect(store.snapshot()).toEqual({ activeIds: ['b'], preparedIds: [] });
    step();
    expect(store.snapshot().preparedIds).toEqual(['c']);
    step();
    expect(store.snapshot().preparedIds).toEqual(['c', 'a']);
    step();
    expect(publishes).toHaveLength(3);
    disconnect();
  });

  it('starts a drawn video while scrolling, then moves the window afterwards, releases first', () => {
    const { store, controller, disconnect, publishes, step } = restingOnB();
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch(see('c'));
    // The election commit flips 'c' on and keeps 'b' prepared: nothing unmounts in it.
    expect(store.snapshot()).toEqual({ activeIds: ['c'], preparedIds: ['a', 'b'] });
    expect(publishes).toHaveLength(1);
    step();
    expect(store.snapshot().preparedIds).toEqual(['b']);
    step();
    expect(store.snapshot().preparedIds).toEqual(['b', 'd']);
    step();
    expect(publishes).toHaveLength(3);
    expect(withinBudget(publishes)).toBe(true);
    disconnect();
  });

  it('never mounts a cold winner mid-scroll: it starts once its player has drawn', () => {
    const { store, controller, disconnect, publishes, step } = restingOnB(['b']);
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch(see('c'));
    // 'c' has no frame yet, so nothing plays; 'b' pauses but keeps its player.
    expect(store.snapshot()).toEqual({ activeIds: [], preparedIds: ['c', 'a', 'b'] });
    // The window moves around the card the reader has reached, so its player
    // is kept and its own neighbours are staged while it draws.
    step();
    expect(store.snapshot().preparedIds).toEqual(['c', 'b']);
    step();
    expect(store.snapshot().preparedIds).toEqual(['c', 'b', 'd']);
    store.setReady('c', true);
    expect(store.snapshot()).toEqual({ activeIds: ['c'], preparedIds: ['b', 'd'] });
    step();
    expect(store.snapshot()).toEqual({ activeIds: ['c'], preparedIds: ['b', 'd'] });
    expect(withinBudget(publishes)).toBe(true);
    disconnect();
  });

  it('elects a cold winner only once the feed rests', () => {
    const { store, controller, disconnect } = restingOnB(['b']);
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch(see('d'));
    controller.dispatch({ type: 'dragEnd', velocityY: 3 });
    controller.dispatch({ type: 'momentumBegin' });
    controller.dispatch(see('d'));
    expect(store.snapshot().activeIds).toEqual([]);
    controller.dispatch({ type: 'momentumEnd' });
    expect(store.snapshot().activeIds).toEqual(['d']);
    disconnect();
  });

  it('falls back to the confirm timer when momentum never arrives', () => {
    const { store, controller, disconnect } = restingOnB(['b']);
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch(see('c'));
    controller.dispatch({ type: 'dragEnd', velocityY: 2 });
    vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS - 1);
    expect(store.snapshot().activeIds).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(store.snapshot().activeIds).toEqual(['c']);
    disconnect();
  });

  it('keeps the window through the empty reports between two cards', () => {
    const { store, controller, disconnect, settle } = restingOnB();
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch(see());
    settle();
    expect(store.snapshot()).toEqual({ activeIds: [], preparedIds: ['c', 'a', 'b'] });
    // Scrolling back onto 'b' resumes it without rebuilding anything.
    controller.dispatch(see('b'));
    settle();
    expect(store.snapshot()).toEqual({ activeIds: ['b'], preparedIds: ['c', 'a'] });
    disconnect();
  });

  it('holds the playing video while it stays on screen, in motion as at rest', () => {
    const { store, controller, disconnect } = restingOnB();
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch(see('c', 'b'));
    expect(store.snapshot().activeIds).toEqual(['b']);
    disconnect();
  });

  it('extends the window when a new page adds a neighbour ahead', () => {
    const { store, controller, disconnect, settle } = setup(feed.slice(0, 2));
    controller.dispatch(see('b'));
    settle();
    expect(store.snapshot()).toEqual({ activeIds: ['b'], preparedIds: ['a'] });
    controller.dispatch({ type: 'itemsChanged', items: feed.slice(0, 3) });
    settle();
    expect(store.snapshot().preparedIds).toEqual(['a', 'c']);
    disconnect();
  });

  it('reanchors on an image card: the videos around it stay prepared, the rest let go', () => {
    const photo = item('x', false);
    const { store, controller, disconnect, settle } = setup([item('a'), item('b'), photo, item('c'), item('d')]);
    controller.dispatch(see('b'));
    settle();
    expect(store.snapshot()).toEqual({ activeIds: ['b'], preparedIds: ['c', 'a'] });
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch({ type: 'viewableItemsChanged', items: [photo] });
    controller.dispatch({ type: 'dragEnd', velocityY: 0 });
    settle();
    expect(store.snapshot()).toEqual({ activeIds: [], preparedIds: ['c', 'b'] });
    disconnect();
  });

  it('settles on what it holds when interrupted, and clears on reset', () => {
    const { store, controller, disconnect, settle } = restingOnB(['b']);
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch(see('c'));
    controller.dispatch({ type: 'stop' });
    expect(store.snapshot().activeIds).toEqual(['c']);
    controller.dispatch({ type: 'reset' });
    settle();
    expect(store.snapshot()).toEqual({ activeIds: [], preparedIds: [] });
    disconnect();
  });

  it('stops acting on readiness once disconnected and works again after reconnecting', () => {
    const { store, controller, disconnect } = restingOnB(['b']);
    controller.dispatch({ type: 'dragBegin' });
    controller.dispatch(see('c'));
    disconnect();
    expect(vi.getTimerCount()).toBe(0);
    store.setReady('c', true);
    expect(store.snapshot().activeIds).toEqual([]);
    // A remount or Fast Refresh runs the effect again: the controller must not stay dead.
    const reconnect = controller.connect();
    store.setReady('c', false);
    store.setReady('c', true);
    expect(store.snapshot().activeIds).toEqual(['c']);
    reconnect();
  });

  it('reads how long a release keeps the feed coasting fast from its velocity', () => {
    // UIScrollView's normal deceleration keeps 0.998 of the speed per millisecond.
    expect(fastCoastHoldMs(undefined)).toBe(0);
    expect(fastCoastHoldMs(0.8)).toBe(0);
    expect(fastCoastHoldMs(1)).toBe(0);
    expect(fastCoastHoldMs(2)).toBeCloseTo(346.2, 0);
    expect(fastCoastHoldMs(-4)).toBeCloseTo(692.5, 0);
  });

  /** Rest on 'b', then fling towards 'd', whose player has not been created. */
  function flingTowardsD(velocityY: number) {
    const lab = restingOnB();
    lab.controller.dispatch({ type: 'dragBegin' });
    lab.controller.dispatch(see('d'));
    lab.controller.dispatch({ type: 'dragEnd', velocityY });
    lab.controller.dispatch({ type: 'momentumBegin' });
    return { ...lab, before: lab.store.snapshot().preparedIds };
  }

  it('holds the prepared window while a fling coasts fast, then moves it', () => {
    const { store, controller, disconnect, publishes, before } = flingTowardsD(4);
    // About 692 ms of coasting faster than a screen a second: no player is
    // created or released for the cards it passes.
    vi.advanceTimersByTime(680);
    expect(store.snapshot().preparedIds).toEqual(before);
    // Slower than the threshold, still coasting: the window moves again.
    vi.advanceTimersByTime(FEED_PREPARED_WINDOW_STEP_MS);
    expect(store.snapshot().preparedIds).not.toEqual(before);
    vi.advanceTimersByTime(FEED_PREPARED_WINDOW_STEP_MS * 8);
    expect(store.snapshot().preparedIds).toContain('d');
    expect(withinBudget(publishes)).toBe(true);
    controller.dispatch({ type: 'momentumEnd' });
    disconnect();
  });

  it('moves the window at once when a finger stops the coast, or the coast ends', () => {
    for (const end of ['dragBegin', 'momentumEnd'] as const) {
      const { store, controller, disconnect, before } = flingTowardsD(4);
      vi.advanceTimersByTime(100);
      expect(store.snapshot().preparedIds).toEqual(before);
      controller.dispatch({ type: end });
      vi.advanceTimersByTime(FEED_PREPARED_WINDOW_STEP_MS);
      expect(store.snapshot().preparedIds).not.toEqual(before);
      disconnect();
      vi.useRealTimers();
    }
  });

  it('keeps preparing through a slow release, as for a finger', () => {
    const { store, disconnect, before } = flingTowardsD(0.8);
    vi.advanceTimersByTime(FEED_PREPARED_WINDOW_STEP_MS);
    expect(store.snapshot().preparedIds).not.toEqual(before);
    disconnect();
  });

  it('rocks between two drawn cards without creating or releasing a player', () => {
    const { store, controller, disconnect, publishes, settle } = restingOnB();
    const players = (snapshot: FeedVideoActivationSnapshot) => [...mounted(snapshot)].sort().join();
    controller.dispatch({ type: 'dragBegin' });
    // Reaching 'c' moves the window once: 'a' goes, 'd' comes.
    controller.dispatch(see('c'));
    settle();
    const afterMove = players(store.snapshot());
    expect(afterMove).toBe('b,c,d');
    publishes.length = 0;
    // Up and down between 'b' and 'c': each flip only plays one and pauses the other.
    for (let flip = 0; flip < 6; flip += 1) {
      controller.dispatch(see(flip % 2 === 0 ? 'b' : 'c'));
      settle();
    }
    expect(publishes.map((snapshot) => snapshot.activeIds.join())).toEqual(['b', 'c', 'b', 'c', 'b', 'c']);
    expect(publishes.every((snapshot) => players(snapshot) === afterMove)).toBe(true);
    // Coming to rest between them keeps the same players too.
    controller.dispatch({ type: 'dragEnd', velocityY: 0 });
    settle();
    expect(players(store.snapshot())).toBe(afterMove);
    disconnect();
  });

  it('scrolls the whole feed starting each video in motion, one native view change at a time', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => item(id));
    const lab = setup(items);
    const { store, controller, disconnect } = lab;
    let moving = false;
    const log: Array<{ snapshot: FeedVideoActivationSnapshot; moving: boolean }> = [];
    const syncTiles = fakeTiles(store, 90);
    const publish = store.publish;
    store.publish = (next) => {
      publish(next);
      log.push({ snapshot: store.snapshot(), moving });
      syncTiles();
    };
    const wait = (ms: number) => vi.advanceTimersByTime(ms);

    controller.dispatch(see('a'));
    wait(600);
    const electedInMotion: string[] = [];
    moving = true;
    controller.dispatch({ type: 'dragBegin' });
    for (const id of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      // Between two cards the report is empty, then the next one qualifies.
      controller.dispatch(see());
      wait(120);
      controller.dispatch(see(id));
      if (store.snapshot().activeIds[0] === id) electedInMotion.push(id);
      wait(400);
    }
    controller.dispatch({ type: 'dragEnd', velocityY: 0 });
    moving = false;
    wait(600);

    // Every video started while the finger was still moving…
    expect(electedInMotion).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h']);
    // …the budget held throughout…
    expect(withinBudget(log.map((entry) => entry.snapshot))).toBe(true);
    // …and while moving, no commit mounted or unmounted more than one player,
    // and an election mounted and unmounted none.
    for (let index = 1; index < log.length; index += 1) {
      const { snapshot, moving: inMotion } = log[index];
      if (!inMotion) continue;
      const before = mounted(log[index - 1].snapshot);
      const after = mounted(snapshot);
      const changes = [...before].filter((id) => !after.has(id)).length + [...after].filter((id) => !before.has(id)).length;
      const elected = snapshot.activeIds.join() !== log[index - 1].snapshot.activeIds.join();
      expect(changes).toBeLessThanOrEqual(elected ? 0 : 1);
    }
    expect(store.snapshot().activeIds).toEqual(['h']);
    disconnect();
  });
});
