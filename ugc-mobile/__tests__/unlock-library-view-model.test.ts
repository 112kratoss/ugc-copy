import { describe, expect, it } from 'vitest';

import type { ViewerUnlockDetail, ViewerUnlockItem } from '@/lib/types';
import {
  canOpenUnlockedPost,
  describeUnreachableUnlockedPost,
  formatUnlockDate,
  formatUnlockPaid,
  formatUnlockPaidPill,
  formatUnlockPrice,
  getUnlockCover,
  getUnlockDestination,
  getUnlockStateBadge,
  getUnlockThumbnailUrl,
  summarizeUnlockCount,
} from '@/lib/unlock-library-view-model';

function createUnlock(overrides: Partial<ViewerUnlockItem> = {}): ViewerUnlockItem {
  return {
    unlockId: '11111111-1111-4111-8111-111111111111',
    bundleId: 'bundle-1',
    postId: 'post-1',
    title: 'Launch hook recipe',
    previewText: 'The prompt behind the hook.',
    accessMode: 'paid',
    priceUsdCents: 500,
    purchasedAt: '2026-07-01T00:00:00.000Z',
    purchasePriceUsdCents: 500,
    hasNewerRevision: false,
    retired: false,
    tombstoned: false,
    detached: false,
    isNsfw: false,
    paidWith: 'credits',
    paidAmountSubunits: 500,
    paidCurrency: null,
    post: {
      title: 'Launch post',
      category: 'image',
      postFormat: 'media',
      mediaUrl: null,
      mediaKind: 'image',
      previewUrl: null,
      previewThumbhash: null,
    },
    creator: { username: 'creator', displayName: 'Creator', avatarUrl: null },
    ...overrides,
  };
}

describe('unlock library view model', () => {
  it('tells a buyer their unlock survived the creator deleting the post', () => {
    // The whole point of the tombstone is that nothing was lost; an unlabelled
    // entry would read as a bug.
    expect(getUnlockStateBadge(createUnlock({ tombstoned: true }))).toEqual({
      tone: 'kept',
      label: 'Creator removed the post — yours to keep',
    });
  });

  it('tells a buyer their unlock survived the creator retiring it', () => {
    expect(getUnlockStateBadge(createUnlock({ retired: true }))).toEqual({
      tone: 'kept',
      label: 'No longer sold — yours to keep',
    });
  });

  it('says the creator left on a detached row, which carries neither flag', () => {
    // Account deletion detaches the purchase and leaves `retired` and
    // `tombstoned` false (finding 03-8), so this row used to show nothing.
    expect(getUnlockStateBadge(createUnlock({ detached: true, bundleId: null, postId: null, post: null }))).toEqual({
      tone: 'kept',
      label: 'Creator left',
    });
    expect(getUnlockStateBadge(createUnlock({ detached: true, tombstoned: true, hasNewerRevision: true }))?.label)
      .toBe('Creator left');
  });

  it('prefers the removal notice over the update notice', () => {
    const badge = getUnlockStateBadge(createUnlock({ tombstoned: true, hasNewerRevision: true }));

    expect(badge?.label).toBe('Creator removed the post — yours to keep');
  });

  it('surfaces a newer version as an upside, not a warning', () => {
    expect(getUnlockStateBadge(createUnlock({ hasNewerRevision: true }))).toEqual({
      tone: 'updated',
      label: 'Creator added an update',
    });
  });

  it('shows no badge for an untouched unlock', () => {
    expect(getUnlockStateBadge(createUnlock())).toBeNull();
  });

  it('prices unlocks in credits alone, matching what the buyer spent', () => {
    expect(formatUnlockPrice(500)).toBe('500 credits');
    expect(formatUnlockPrice(10)).toBe('10 credits');
    // Grouped like every other credit amount in the app.
    expect(formatUnlockPrice(125000)).toBe('1,25,000 credits');
  });

  it('never shows a cash price beside an unlock (App Review 2.1(b), 0.1.6)', () => {
    for (const cents of [1, 10, 99, 900, 1234, 250000]) {
      expect(formatUnlockPrice(cents)).not.toMatch(/[$₹€£]|USD|INR/);
    }
  });

  it('labels a free unlock rather than showing zero', () => {
    expect(formatUnlockPrice(0)).toBe('Free');
  });

  it('opens the resource screen, not the generic feed', () => {
    // The immersive viewer reads initialId and silently falls back to the
    // showcase feed for an unknown source, so the old
    // /viewer?postId=…&source=unlocks link dropped every buyer into the feed.
    expect(getUnlockDestination(createUnlock())).toBe('/unlock/11111111-1111-4111-8111-111111111111');
  });

  it('still opens when the post is gone, since the unlock is what was bought', () => {
    expect(getUnlockDestination(createUnlock({ bundleId: null, postId: null }))).toBe('/unlock/11111111-1111-4111-8111-111111111111');
  });

  it('pluralizes the count', () => {
    expect(summarizeUnlockCount(1)).toBe('1 unlock · yours permanently');
    expect(summarizeUnlockCount(4)).toBe('4 unlocks · yours permanently');
  });

  it('degrades to an empty string on an unparseable date', () => {
    expect(formatUnlockDate('not-a-date')).toBe('');
  });
});

describe('what a purchase cost (03-2)', () => {
  it('names a credit unlock by the credits it took', () => {
    expect(formatUnlockPaid(createUnlock({ paidWith: 'credits', paidAmountSubunits: 900 }))).toBe('900 credits');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'credits', paidAmountSubunits: 125000 }))).toBe('1,25,000 credits');
    expect(formatUnlockPaidPill(createUnlock({ paidWith: 'credits', paidAmountSubunits: 900 }))).toBe('900 credits paid');
  });

  it('names a cash purchase in its own currency, from minor units', () => {
    const rupees = createUnlock({ paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' });
    expect(formatUnlockPaid(rupees)).toBe('₹750 paid');
    expect(formatUnlockPaidPill(rupees)).toBe('₹750 paid');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: 74950, paidCurrency: 'INR' }))).toBe('₹749.50 paid');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: 12500000, paidCurrency: 'INR' }))).toBe('₹1,25,000 paid');

    const dollars = createUnlock({ paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: 'USD' });
    expect(formatUnlockPaid(dollars)).toBe('$9.00 paid');
    expect(formatUnlockPaidPill(dollars)).toBe('$9.00 paid');
  });

  it('calls a free unlock free', () => {
    const free = createUnlock({ accessMode: 'free', purchasePriceUsdCents: 0, paidWith: 'free', paidAmountSubunits: null });
    expect(formatUnlockPaid(free)).toBe('Free');
    expect(formatUnlockPaidPill(free)).toBe('Free unlock');
  });

  it('shows a currency only for a purchase that was paid in cash', () => {
    for (const amount of [1, 99, 900, 250000]) {
      for (const paidWith of ['credits', 'free'] as const) {
        const unlock = createUnlock({ paidWith, paidAmountSubunits: amount, purchasePriceUsdCents: amount });
        expect(formatUnlockPaid(unlock)).not.toMatch(/[$₹€£]|USD|INR/);
        expect(formatUnlockPaidPill(unlock)).not.toMatch(/[$₹€£]|USD|INR/);
      }
    }
  });

  it('reads a row from a server that sends no payment as it always did', () => {
    const legacy = createUnlock({ purchasePriceUsdCents: 900 }) as Partial<ViewerUnlockItem>;
    delete legacy.paidWith;
    delete legacy.paidAmountSubunits;
    delete legacy.paidCurrency;
    expect(formatUnlockPaid(legacy as ViewerUnlockItem)).toBe('900 credits');
    expect(formatUnlockPaidPill(legacy as ViewerUnlockItem)).toBe('900 credits paid');
    expect(formatUnlockPaid({ ...(legacy as ViewerUnlockItem), purchasePriceUsdCents: 0 })).toBe('Free');
  });

  it('keeps an unreadable cash amount from becoming a wrong one', () => {
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: null, paidCurrency: 'INR' }))).toBe('Paid');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: null }))).toBe('Paid');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: 'XX1' }))).toBe('9.00 XX1 paid');
  });
});

describe('unlock thumbnails (03-3 / 03-4)', () => {
  const post = createUnlock().post!;

  it("draws the purchase's still, a video's poster included", () => {
    expect(getUnlockThumbnailUrl(createUnlock({
      post: { ...post, mediaKind: 'video', mediaUrl: 'https://cdn.test/clip.mp4', previewUrl: '/api/media?bucket=post_media&path=poster.webp' },
    }))).toBe('/api/media?bucket=post_media&path=poster.webp');
  });

  it('falls back to the original only when it is a picture', () => {
    expect(getUnlockThumbnailUrl(createUnlock({ post: { ...post, mediaUrl: '/api/media?bucket=post_media&path=look.jpg' } })))
      .toBe('/api/media?bucket=post_media&path=look.jpg');
    // Never an MP4: expo-image cannot draw one.
    expect(getUnlockThumbnailUrl(createUnlock({ post: { ...post, mediaKind: 'video', mediaUrl: 'https://cdn.test/clip.mp4' } })))
      .toBeNull();
    expect(getUnlockThumbnailUrl(createUnlock({ post: null }))).toBeNull();
  });
});

describe('unlock detail cover', () => {
  const coverPost = (overrides: Partial<NonNullable<ViewerUnlockDetail['post']>> = {}): ViewerUnlockDetail['post'] => ({
    id: 'post-1',
    title: 'Launch',
    body: '',
    mediaUrl: 'https://cdn.test/look.jpg',
    mediaKind: 'image',
    mediaPreviewUrl: null,
    ...overrides,
  });

  it("draws a picture from its still, else from the picture itself", () => {
    expect(getUnlockCover(coverPost({ mediaPreviewUrl: '/api/media?path=still.webp' })))
      .toEqual({ kind: 'image', stillUrl: '/api/media?path=still.webp' });
    expect(getUnlockCover(coverPost())).toEqual({ kind: 'image', stillUrl: 'https://cdn.test/look.jpg' });
  });

  it('keeps a video behind its poster, with the clip for the player', () => {
    expect(getUnlockCover(coverPost({ mediaKind: 'video', mediaUrl: 'https://cdn.test/clip.mp4', mediaPreviewUrl: '/api/media?path=poster.webp' })))
      .toEqual({ kind: 'video', stillUrl: '/api/media?path=poster.webp', videoUrl: 'https://cdn.test/clip.mp4' });
    expect(getUnlockCover(coverPost({ mediaKind: 'video', mediaUrl: 'https://cdn.test/clip.mp4' })))
      .toEqual({ kind: 'video', stillUrl: null, videoUrl: 'https://cdn.test/clip.mp4' });
  });

  it('has nothing to draw without a post or its media', () => {
    expect(getUnlockCover(null)).toEqual({ kind: 'none' });
    expect(getUnlockCover(coverPost({ mediaUrl: null }))).toEqual({ kind: 'none' });
  });
});

describe('canOpenUnlockedPost', () => {
  const livePost = { id: 'post-1', title: 'Launch', body: '', mediaUrl: null, mediaKind: null, mediaPreviewUrl: null, visibility: 'public', archivedAt: null, tombstoned: false };
  const detail = (overrides: Partial<ViewerUnlockDetail> = {}) => ({
    postId: 'post-1',
    postVisibility: 'public',
    detached: false,
    postReachable: true,
    post: livePost,
    ...overrides,
  }) as Pick<ViewerUnlockDetail, 'postId' | 'post' | 'postVisibility' | 'detached' | 'postReachable'>;

  it('leads to a post the server says this buyer can open', () => {
    expect(canOpenUnlockedPost(detail())).toBe(true);
  });

  it('leads nowhere across a block, for a private, archived or removed post, or without one', () => {
    // A block either way: the post is still public, and the post read drops it (03-7).
    expect(canOpenUnlockedPost(detail({ postReachable: false }))).toBe(false);
    expect(canOpenUnlockedPost(detail({ detached: true }))).toBe(false);
    expect(canOpenUnlockedPost(detail({ post: null }))).toBe(false);
    expect(canOpenUnlockedPost(detail({ postId: null }))).toBe(false);
  });

  it('gives a block the neutral reason, and a private or archived post its own', () => {
    expect(describeUnreachableUnlockedPost(detail({ postReachable: false })))
      .toBe("This post isn't available to you. Your unlock stays here.");
    expect(describeUnreachableUnlockedPost(detail({ post: { ...livePost, visibility: 'unlisted' }, postReachable: false })))
      .toBe("This post isn't available to you. Your unlock stays here.");
    expect(describeUnreachableUnlockedPost(detail({ post: { ...livePost, visibility: 'private' } })))
      .toBe('This post is no longer public. Your unlock stays available here.');
    expect(describeUnreachableUnlockedPost(detail({ post: { ...livePost, archivedAt: '2026-10-01T00:00:00.000Z' } })))
      .toBe('This post is no longer public. Your unlock stays available here.');
    expect(describeUnreachableUnlockedPost(detail({ post: null, postVisibility: null })))
      .toBe('This post is no longer public. Your unlock stays available here.');
  });
});
