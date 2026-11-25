import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPostViewLook,
  isCountedByReelImpression,
  isPostLookOnScreen,
  POST_VIEW_QUALIFY_MS,
  POST_VIEW_VISIBLE_SHARE,
  viewReportPostId,
} from '../lib/post-view-look';
import { SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY } from '../lib/showcase-feed-events';

/**
 * A view is the feed's qualified impression (owner, 2026-11-23: "Seen 1 s,
 * shown large"): half the post on screen for a second while the app is in
 * front, on the post page and in a reel opened outside the feed.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a post view look', () => {
  it('is the feed’s qualified impression: half the post for a second', () => {
    expect(POST_VIEW_QUALIFY_MS).toBe(SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime);
    expect(POST_VIEW_QUALIFY_MS).toBe(1_000);
    expect(POST_VIEW_VISIBLE_SHARE).toBe(0.5);
  });

  it('reports a look once it has lasted a second, and not a moment before', () => {
    const onLooked = vi.fn();
    const look = createPostViewLook({ onLooked });
    look.setForeground(true);
    look.setOnScreen(true);
    vi.advanceTimersByTime(POST_VIEW_QUALIFY_MS - 1);
    expect(onLooked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLooked).toHaveBeenCalledTimes(1);
    // One report a look, however long it lasts.
    vi.advanceTimersByTime(60_000);
    expect(onLooked).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a post that leaves the screen before its second', () => {
    const onLooked = vi.fn();
    const look = createPostViewLook({ onLooked });
    look.setForeground(true);
    look.setOnScreen(true);
    vi.advanceTimersByTime(900);
    look.setOnScreen(false);
    vi.advanceTimersByTime(5_000);
    expect(onLooked).not.toHaveBeenCalled();

    // A new look needs a whole second of its own.
    look.setOnScreen(true);
    vi.advanceTimersByTime(999);
    expect(onLooked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLooked).toHaveBeenCalledTimes(1);
  });

  it('stops the second while the app is in the background, and starts it over on return', () => {
    const onLooked = vi.fn();
    const look = createPostViewLook({ onLooked });
    look.setForeground(true);
    look.setOnScreen(true);
    vi.advanceTimersByTime(600);
    look.setForeground(false);
    // Time in the background counts for nothing.
    vi.advanceTimersByTime(10_000);
    expect(onLooked).not.toHaveBeenCalled();

    look.setForeground(true);
    vi.advanceTimersByTime(600);
    expect(onLooked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(onLooked).toHaveBeenCalledTimes(1);
  });

  it('starts no second while the app is not in front, the post on screen or not', () => {
    const onLooked = vi.fn();
    const look = createPostViewLook({ onLooked });
    look.setOnScreen(true);
    vi.advanceTimersByTime(5_000);
    expect(onLooked).not.toHaveBeenCalled();
  });

  it('reports each new look: the reporter keeps one a reader, post and day', () => {
    const onLooked = vi.fn();
    const look = createPostViewLook({ onLooked });
    look.setForeground(true);
    look.setOnScreen(true);
    vi.advanceTimersByTime(POST_VIEW_QUALIFY_MS);
    look.setForeground(false);
    look.setForeground(true);
    vi.advanceTimersByTime(POST_VIEW_QUALIFY_MS);
    expect(onLooked).toHaveBeenCalledTimes(2);
  });

  it('reports nothing once the post is gone from the page', () => {
    const onLooked = vi.fn();
    const look = createPostViewLook({ onLooked });
    look.setForeground(true);
    look.setOnScreen(true);
    look.dispose();
    vi.advanceTimersByTime(5_000);
    look.setOnScreen(false);
    look.setOnScreen(true);
    vi.advanceTimersByTime(5_000);
    expect(onLooked).not.toHaveBeenCalled();
  });
});

describe('whether a post is on screen', () => {
  const screen = { scrollOffset: 0, viewportHeight: 800 };

  it('takes half the post on screen', () => {
    expect(isPostLookOnScreen({ top: 0, height: 600, ...screen })).toBe(true);
    // Scrolled until exactly half of it shows.
    expect(isPostLookOnScreen({ top: 0, height: 600, scrollOffset: 300, viewportHeight: 800 })).toBe(true);
    expect(isPostLookOnScreen({ top: 0, height: 600, scrollOffset: 301, viewportHeight: 800 })).toBe(false);
    // Past it, on the thread below.
    expect(isPostLookOnScreen({ top: 0, height: 600, scrollOffset: 700, viewportHeight: 800 })).toBe(false);
  });

  it('takes a post taller than the screen while it crosses the screen’s middle', () => {
    // A long read: a fifth of it on screen, filling it.
    expect(isPostLookOnScreen({ top: 0, height: 4_000, scrollOffset: 1_500, viewportHeight: 800 })).toBe(true);
    // Its last lines at the top of the screen, the thread below the middle.
    expect(isPostLookOnScreen({ top: 0, height: 4_000, scrollOffset: 3_700, viewportHeight: 800 })).toBe(false);
  });

  it('takes nothing before the post and the screen have been measured', () => {
    expect(isPostLookOnScreen({ top: 0, height: 0, ...screen })).toBe(false);
    expect(isPostLookOnScreen({ top: 0, height: 600, scrollOffset: 0, viewportHeight: 0 })).toBe(false);
  });
});

describe('which post a page or a reel reports', () => {
  const post = {
    showcasePostId: 'post-1',
    creatorId: 'creator-1',
    visibility: 'public',
    archivedAt: null,
    recommendation: null,
  };

  it('reports someone else’s public post', () => {
    expect(viewReportPostId(post, { viewerIdentity: 'reader-1' })).toBe('post-1');
    // A list of public posts may leave the visibility out.
    expect(viewReportPostId({ ...post, visibility: null }, { viewerIdentity: 'reader-1' })).toBe('post-1');
  });

  it('reports none for the reader’s own post, one not public, one taken down, or a creation', () => {
    expect(viewReportPostId(post, { viewerIdentity: 'creator-1' })).toBeNull();
    expect(viewReportPostId({ ...post, visibility: 'unlisted' }, { viewerIdentity: 'reader-1' })).toBeNull();
    expect(viewReportPostId({ ...post, visibility: 'private' }, { viewerIdentity: 'reader-1' })).toBeNull();
    expect(viewReportPostId({ ...post, archivedAt: '2026-11-20T00:00:00.000Z' }, { viewerIdentity: 'reader-1' })).toBeNull();
    expect(viewReportPostId({ ...post, showcasePostId: null }, { viewerIdentity: 'reader-1' })).toBeNull();
    expect(viewReportPostId(null, { viewerIdentity: 'reader-1' })).toBeNull();
  });

  it('leaves a post the feed delivered, on the feed’s own reel, to its impression', () => {
    const delivered = { ...post, recommendation: { deliveryId: '9001' } };
    expect(isCountedByReelImpression('showcase-feed', delivered)).toBe(true);
    expect(viewReportPostId(delivered, {
      viewerIdentity: 'reader-1',
      countedByFeedImpression: isCountedByReelImpression('showcase-feed', delivered),
    })).toBeNull();

    // A link, a notification or search opens the feed's reel on a post no feed delivered.
    expect(isCountedByReelImpression('showcase-feed', post)).toBe(false);
    // A profile's, a creator's or Saved's reel files no impression at all.
    expect(isCountedByReelImpression('creator-profile', delivered)).toBe(false);
    expect(isCountedByReelImpression('profile-saved', delivered)).toBe(false);
    expect(viewReportPostId(post, {
      viewerIdentity: 'reader-1',
      countedByFeedImpression: isCountedByReelImpression('creator-profile', post),
    })).toBe('post-1');
  });
});
