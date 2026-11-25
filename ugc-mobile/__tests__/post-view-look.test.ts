import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildImmersiveShowcaseItems } from '../lib/immersive-preview-view-model';
import {
  createPostViewLook,
  createPostViewLookSet,
  isPostLookOnScreen,
  isReelSlideOnScreen,
  POST_VIEW_QUALIFY_MS,
  POST_VIEW_VISIBLE_SHARE,
  viewReportPostId,
} from '../lib/post-view-look';
import { SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY } from '../lib/showcase-feed-events';
import type { ShowcaseFeedItem } from '../lib/types';

/**
 * A view is the feed's qualified impression (owner, 2026-11-23: "Seen 1 s,
 * shown large"): half the post on screen for a second while the app is in
 * front, on Home's cards, the post page and every reel slide, as the web
 * reports them. The server's per-day mark dedupes a view against the feed's
 * impression of the same post.
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

describe("a look's second, asked before its timer fires", () => {
  it('says whether the look under way has lasted its second, and not once it ends', () => {
    // A busy thread can run a timer late: a caller ending the look asks the clock.
    let clock = 0;
    const onLooked = vi.fn();
    const look = createPostViewLook({ onLooked, now: () => clock });
    look.setForeground(true);
    look.setOnScreen(true);
    clock = 999;
    expect(look.hasQualified()).toBe(false);
    clock = 1_000;
    expect(look.hasQualified()).toBe(true);
    expect(onLooked).not.toHaveBeenCalled();

    // Covered or in the background, the look ends, and the next needs its own second.
    look.setOnScreen(false);
    expect(look.hasQualified()).toBe(false);
    look.setOnScreen(true);
    clock = 1_500;
    expect(look.hasQualified()).toBe(false);
    clock = 2_000;
    expect(look.hasQualified()).toBe(true);
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

describe('which post a page, a card or a reel slide reports', () => {
  const post = {
    showcasePostId: 'post-1',
    creatorId: 'creator-1',
    sourceType: 'showcase',
    viewsCountable: true,
  };

  it('reports someone else’s public post', () => {
    expect(viewReportPostId(post, { viewerIdentity: 'reader-1' })).toBe('post-1');
  });

  it('reports none for the reader’s own post, one not known to be public, or a creation', () => {
    expect(viewReportPostId(post, { viewerIdentity: 'creator-1' })).toBeNull();
    expect(viewReportPostId({ ...post, viewsCountable: false }, { viewerIdentity: 'reader-1' })).toBeNull();
    expect(viewReportPostId({ ...post, viewsCountable: undefined }, { viewerIdentity: 'reader-1' })).toBeNull();
    expect(viewReportPostId({ ...post, showcasePostId: null }, { viewerIdentity: 'reader-1' })).toBeNull();
    expect(viewReportPostId(null, { viewerIdentity: 'reader-1' })).toBeNull();
    // A creation in its owner's library, linked to a post: never the post's view
    // (review of #929, 10), even with no creator id to compare.
    expect(viewReportPostId({ ...post, sourceType: 'generation', creatorId: null }, { viewerIdentity: 'reader-1' })).toBeNull();
    expect(viewReportPostId({ ...post, sourceType: 'owner-post' }, { viewerIdentity: 'reader-1' })).toBeNull();
  });

  it('reports a slide a feed delivered too: the impression may never count (review of #929, 1)', () => {
    // Explore's tile already filed the delivery's impression, the lane's session
    // expired, or the device has no session: the reel's own view is the one
    // that counts, and where the impression did, the per-day mark keeps one.
    const [delivered] = buildImmersiveShowcaseItems('showcase-feed', [feedItem({ recommendation: { deliveryId: '9001', position: 0 } as ShowcaseFeedItem['recommendation'] })]);
    expect(viewReportPostId(delivered, { viewerIdentity: 'reader-1' })).toBe('post-1');
  });
});

/** A card as a feed, a creator page or Saved lists it: no `visibility`, which only the read by id sets. */
function feedItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://cdn.example.test/post-1.png',
    mediaKind: 'image',
    mediaItems: [],
    model: 'manual',
    title: 'Launch frame',
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    viewCount: 42,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-25T08:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  } as ShowcaseFeedItem;
}

describe('whether a reel post is known to be public (review of #929, 3)', () => {
  it('takes a post of a feed or a creator page as public: those list public posts only', () => {
    for (const source of ['showcase-feed', 'creator-profile'] as const) {
      const [item] = buildImmersiveShowcaseItems(source, [feedItem()]);
      expect(item.viewsCountable).toBe(true);
      expect(item.viewLabels?.compact).toBe('42');
    }
  });

  it('takes a Saved post of unknown visibility as not public: no count, no view', () => {
    // Saved lists unlisted posts too and says which only through the read by id.
    const [saved] = buildImmersiveShowcaseItems('profile-saved', [feedItem()]);
    expect(saved.viewsCountable).toBe(false);
    expect(saved.viewLabels).toBeNull();
    expect(viewReportPostId(saved, { viewerIdentity: 'reader-1' })).toBeNull();

    // Read by id, it says.
    const [known] = buildImmersiveShowcaseItems('profile-saved', [feedItem({ visibility: 'public' })]);
    expect(known.viewsCountable).toBe(true);
    expect(known.viewLabels?.compact).toBe('42');
    const [unlisted] = buildImmersiveShowcaseItems('showcase-feed', [feedItem({ visibility: 'unlisted' })]);
    expect(unlisted.viewsCountable).toBe(false);
    expect(unlisted.viewLabels).toBeNull();
  });
});

describe('whether a reel slide is looked at (review of #929, 4)', () => {
  const settled = { initialPositionReady: true, focused: true, onEndSlide: false, overlayOpen: false };

  it('takes the slide on screen, the reel in front', () => {
    expect(isReelSlideOnScreen(settled)).toBe(true);
  });

  it('takes nothing while Details, the comments or a sheet covers it, or before the reel lands', () => {
    expect(isReelSlideOnScreen({ ...settled, overlayOpen: true })).toBe(false);
    expect(isReelSlideOnScreen({ ...settled, initialPositionReady: false })).toBe(false);
    expect(isReelSlideOnScreen({ ...settled, focused: false })).toBe(false);
    expect(isReelSlideOnScreen({ ...settled, onEndSlide: true })).toBe(false);
  });
});

describe("Home's looks, one a card (review of #929, 2)", () => {
  it('reports each card half on screen for a second, delivered or not', () => {
    const onLooked = vi.fn();
    const looks = createPostViewLookSet({ onLooked });
    looks.setForeground(true);
    looks.setOnScreen(['post-1', 'post-2']);
    vi.advanceTimersByTime(999);
    expect(onLooked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLooked.mock.calls.map(([postId]) => postId).sort()).toEqual(['post-1', 'post-2']);
  });

  it('ends a card’s look when it leaves the screen, and starts one for a card that comes on', () => {
    const onLooked = vi.fn();
    const looks = createPostViewLookSet({ onLooked });
    looks.setForeground(true);
    looks.setOnScreen(['post-1']);
    vi.advanceTimersByTime(600);
    looks.setOnScreen(['post-2']);
    vi.advanceTimersByTime(999);
    expect(onLooked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLooked).toHaveBeenCalledWith('post-2');
    expect(onLooked).toHaveBeenCalledTimes(1);
  });

  it('counts no time while Home is not in front', () => {
    const onLooked = vi.fn();
    const looks = createPostViewLookSet({ onLooked });
    looks.setOnScreen(['post-1']);
    vi.advanceTimersByTime(5_000);
    expect(onLooked).not.toHaveBeenCalled();
    looks.setForeground(true);
    vi.advanceTimersByTime(500);
    looks.setForeground(false);
    vi.advanceTimersByTime(5_000);
    expect(onLooked).not.toHaveBeenCalled();
    looks.setForeground(true);
    vi.advanceTimersByTime(1_000);
    expect(onLooked).toHaveBeenCalledWith('post-1');
  });

  it('reports nothing once disposed', () => {
    const onLooked = vi.fn();
    const looks = createPostViewLookSet({ onLooked });
    looks.setForeground(true);
    looks.setOnScreen(['post-1']);
    looks.dispose();
    vi.advanceTimersByTime(5_000);
    expect(onLooked).not.toHaveBeenCalled();
  });
});
