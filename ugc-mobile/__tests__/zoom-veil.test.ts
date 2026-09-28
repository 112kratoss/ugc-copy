import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The black a screen is covered in while UIKit's zoom grows a reel out of one
 * of its tiles or shrinks it back (lib/zoom-veil.ts): what puts it up, what
 * takes it down, the deadline for a veil no reel ever claims, and whose veil
 * each reel may touch.
 */
vi.mock('../lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => available }));
let available = true;

import {
  claimZoomVeil,
  clearZoomVeil,
  closeZoomVeilHole,
  createScreenVeil,
  dropZoomVeil,
  followZoomVeilTransition,
  getZoomVeilOpacity,
  holdZoomVeil,
  liftZoomVeil,
  registerScreenVeil,
  releaseZoomVeil,
  resetZoomVeil,
  settleZoomVeil,
  subscribeToZoomVeilOpacity,
  ZOOM_VEIL_DEADLINE_MS,
  ZOOM_VEIL_LIFT_DELAY_MS,
  ZOOM_VEIL_LIFT_MS,
  type ScreenVeil,
  type ZoomVeilTransition,
} from '../lib/zoom-veil';

const TILE = { x: 16, y: 300, width: 370, height: 460, radius: 18 };
/** Stands in for the reel's native transition progress; only its identity matters here. */
const transition = (name: string) => ({ name }) as unknown as ZoomVeilTransition;

let feed: ScreenVeil;

beforeEach(() => {
  feed = createScreenVeil();
  registerScreenVeil('feed', feed);
});

afterEach(() => {
  resetZoomVeil();
  available = true;
  vi.useRealTimers();
});

describe('the veil under the zoom', () => {
  it('goes up around the tile at the tap, covers it once the push begins, and comes down as the close begins', () => {
    vi.useFakeTimers();
    const drop = dropZoomVeil('feed', TILE);
    // The test double resolves every timing at once.
    expect(feed.cover.get()).toBe(1);
    expect(feed.hole.get()).toEqual(TILE);
    claimZoomVeil(drop);
    closeZoomVeilHole(drop);
    expect(feed.hole.get()).toBeNull();
    vi.advanceTimersByTime(ZOOM_VEIL_DEADLINE_MS + 1);
    expect(feed.cover.get()).toBe(1);
    liftZoomVeil(drop);
    expect(feed.cover.get()).toBe(0);
  });

  it('waits for the reel\'s transition to darken, instead of blacking the feed out while the reel is built', () => {
    const drop = dropZoomVeil('feed', TILE)!;
    // Following a transition not bound yet: nothing shows.
    expect(getZoomVeilOpacity('feed')).toBe(0);
    const opening = transition('reel');
    const unfollow = followZoomVeilTransition(drop, opening);
    expect(getZoomVeilOpacity('feed')).toBe(opening);
    unfollow();
    expect(getZoomVeilOpacity('feed')).toBeNull();
  });

  it('rests at full cover once the reel has landed, whatever the reel\'s own screen does later', () => {
    const drop = dropZoomVeil('feed', TILE)!;
    claimZoomVeil(drop);
    followZoomVeilTransition(drop, transition('reel'));
    settleZoomVeil(drop);
    // A screen pushed over the reel moves the reel's transition, not this veil.
    expect(getZoomVeilOpacity('feed')).toBeNull();
    expect(feed.cover.get()).toBe(1);
  });

  it('follows a dismissal gesture, and goes back up, whole, when the gesture is let go of', () => {
    const drop = dropZoomVeil('feed', TILE)!;
    claimZoomVeil(drop);
    const reel = transition('reel');
    followZoomVeilTransition(drop, reel);
    settleZoomVeil(drop);
    liftZoomVeil(drop, true);
    expect(getZoomVeilOpacity('feed')).toBe(reel);
    expect(feed.cover.get()).toBe(1);
    holdZoomVeil(drop);
    expect(getZoomVeilOpacity('feed')).toBeNull();
    expect(feed.cover.get()).toBe(1);
    expect(feed.hole.get()).toBeNull();
  });

  it('fades out over the shrink on Back, even once the reel has left React', () => {
    vi.useFakeTimers();
    const drop = dropZoomVeil('feed', TILE)!;
    claimZoomVeil(drop);
    liftZoomVeil(drop);
    const set = vi.spyOn(feed.cover, 'set');
    releaseZoomVeil(drop);
    expect(set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ZOOM_VEIL_LIFT_DELAY_MS + ZOOM_VEIL_LIFT_MS);
    expect(set).toHaveBeenCalledWith(0);
    set.mockRestore();
  });

  it('clears when the reel leaves React any other way', () => {
    const drop = dropZoomVeil('feed', TILE)!;
    claimZoomVeil(drop);
    releaseZoomVeil(drop);
    expect(feed.cover.get()).toBe(0);
    expect(getZoomVeilOpacity('feed')).toBeNull();
  });

  it('comes down by itself when no reel claims it', () => {
    vi.useFakeTimers();
    dropZoomVeil('feed', TILE);
    vi.advanceTimersByTime(ZOOM_VEIL_DEADLINE_MS - 1);
    expect(feed.cover.get()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(feed.cover.get()).toBe(0);
    expect(feed.hole.get()).toBeNull();
  });

  it('does nothing where the zoom does not run, or for a tile on no veiled screen', () => {
    available = false;
    expect(dropZoomVeil('feed', TILE)).toBeNull();
    expect(feed.cover.get()).toBe(0);
    available = true;
    expect(dropZoomVeil(null, TILE)).toBeNull();
    expect(dropZoomVeil('gone', TILE)).toBeNull();
    expect(feed.cover.get()).toBe(0);
  });
});

describe('a veil per screen', () => {
  let creator: ScreenVeil;

  beforeEach(() => {
    creator = createScreenVeil();
    registerScreenVeil('creator', creator);
  });

  it('leaves a creator page opened from a reel clear', () => {
    const drop = dropZoomVeil('feed', TILE)!;
    claimZoomVeil(drop);
    followZoomVeilTransition(drop, transition('first reel'));
    expect(creator.cover.get()).toBe(0);
    expect(getZoomVeilOpacity('creator')).toBeNull();
  });

  it('keeps the first reel\'s veil up while a reel opened from a page above it opens and closes', () => {
    vi.useFakeTimers();
    // Explore → a reel → the creator page pushed from it → a second reel from that page.
    const first = dropZoomVeil('feed', TILE)!;
    claimZoomVeil(first);
    followZoomVeilTransition(first, transition('first reel'));
    settleZoomVeil(first);

    const second = dropZoomVeil('creator', TILE)!;
    claimZoomVeil(second);
    const unfollowSecond = followZoomVeilTransition(second, transition('second reel'));
    expect(creator.cover.get()).toBe(1);
    expect(getZoomVeilOpacity('feed')).toBeNull();

    // Back on the second reel: the creator page comes back behind it.
    liftZoomVeil(second);
    releaseZoomVeil(second);
    unfollowSecond();
    vi.advanceTimersByTime(ZOOM_VEIL_LIFT_DELAY_MS + ZOOM_VEIL_LIFT_MS);
    expect(creator.cover.get()).toBe(0);

    // The page is popped, and the first reel closes over black, not the lit feed.
    expect(feed.cover.get()).toBe(1);
    expect(getZoomVeilOpacity('feed')).toBeNull();
    liftZoomVeil(first);
    expect(feed.cover.get()).toBe(0);
  });

  it('lets a reel touch only the veil its own tap dropped', () => {
    const earlier = dropZoomVeil('feed', TILE)!;
    const later = dropZoomVeil('feed', TILE)!;
    claimZoomVeil(later);
    // The earlier reel, leaving late, takes nothing down with it.
    releaseZoomVeil(earlier);
    liftZoomVeil(earlier);
    clearZoomVeil(earlier);
    expect(feed.cover.get()).toBe(1);
    expect(followZoomVeilTransition(earlier, transition('earlier reel'))).toBeTypeOf('function');
    expect(getZoomVeilOpacity('feed')).toBe(0);
  });

  it('tells only the screen whose veil changed', () => {
    const feedListener = vi.fn();
    const creatorListener = vi.fn();
    subscribeToZoomVeilOpacity('feed', feedListener);
    subscribeToZoomVeilOpacity('creator', creatorListener);
    const drop = dropZoomVeil('creator', TILE)!;
    followZoomVeilTransition(drop, transition('reel'));
    expect(creatorListener).toHaveBeenCalled();
    expect(feedListener).not.toHaveBeenCalled();
  });

  it('forgets a screen that has gone, and leaves one registered since alone', () => {
    const replacement = createScreenVeil();
    const unregisterOld = registerScreenVeil('creator', creator);
    const unregisterNew = registerScreenVeil('creator', replacement);
    unregisterOld();
    const drop = dropZoomVeil('creator', TILE);
    expect(drop).not.toBeNull();
    expect(replacement.cover.get()).toBe(1);
    unregisterNew();
    expect(dropZoomVeil('creator', TILE)).toBeNull();
  });
});
