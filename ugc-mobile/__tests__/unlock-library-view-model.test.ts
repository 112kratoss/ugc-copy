import { describe, expect, it } from 'vitest';

import type { PostResourceBundleResources, PostResourceItem, ViewerUnlockDetail, ViewerUnlockItem } from '@/lib/types';
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
  hasResourcePictures,
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
    expect(summarizeUnlockCount(1)).toBe('1 recipe · yours permanently');
    expect(summarizeUnlockCount(4)).toBe('4 recipes · yours permanently');
  });

  it('degrades to an empty string on an unparseable date', () => {
    expect(formatUnlockDate('not-a-date')).toBe('');
  });
});

describe('what a purchase cost (03-2)', () => {
  it('names a credit unlock by the credits it took, on both platforms', () => {
    for (const platform of ['ios', 'android']) {
      expect(formatUnlockPaid(createUnlock({ paidWith: 'credits', paidAmountSubunits: 900 }), platform)).toBe('900 credits');
      expect(formatUnlockPaid(createUnlock({ paidWith: 'credits', paidAmountSubunits: 125000 }), platform)).toBe('1,25,000 credits');
      expect(formatUnlockPaidPill(createUnlock({ paidWith: 'credits', paidAmountSubunits: 900 }), platform)).toBe('900 credits paid');
    }
  });

  it('names a cash purchase in its own currency on Android, from minor units', () => {
    const rupees = createUnlock({ paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' });
    expect(formatUnlockPaid(rupees, 'android')).toBe('₹750 paid');
    expect(formatUnlockPaidPill(rupees, 'android')).toBe('₹750 paid');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: 74950, paidCurrency: 'INR' }), 'android')).toBe('₹749.50 paid');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: 12500000, paidCurrency: 'INR' }), 'android')).toBe('₹1,25,000 paid');

    const dollars = createUnlock({ paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: 'USD' });
    expect(formatUnlockPaid(dollars, 'android')).toBe('$9.00 paid');
    expect(formatUnlockPaidPill(dollars, 'android')).toBe('$9.00 paid');
  });

  it('says only "Paid" for a cash purchase on iOS, with no amount or currency (App Review 2.1(b), 0.1.6)', () => {
    for (const [amount, currency] of [[75000, 'INR'], [74950, 'INR'], [900, 'USD'], [null, 'INR'], [900, null]] as const) {
      const cash = createUnlock({ paidWith: 'cash', paidAmountSubunits: amount, paidCurrency: currency });
      expect(formatUnlockPaid(cash, 'ios')).toBe('Paid');
      expect(formatUnlockPaidPill(cash, 'ios')).toBe('Paid');
    }
  });

  it('calls a free unlock free, on both platforms', () => {
    const free = createUnlock({ accessMode: 'free', purchasePriceUsdCents: 0, paidWith: 'free', paidAmountSubunits: null });
    for (const platform of ['ios', 'android']) {
      expect(formatUnlockPaid(free, platform)).toBe('Free');
      expect(formatUnlockPaidPill(free, platform)).toBe('Free unlock');
    }
  });

  it('shows a currency only for a purchase paid in cash, and never on iOS', () => {
    const currency = /[$₹€£]|USD|INR/;
    for (const amount of [1, 99, 900, 250000]) {
      for (const paidWith of ['credits', 'free', 'cash'] as const) {
        const unlock = createUnlock({ paidWith, paidAmountSubunits: amount, purchasePriceUsdCents: amount, paidCurrency: paidWith === 'cash' ? 'INR' : null });
        expect(formatUnlockPaid(unlock, 'ios')).not.toMatch(currency);
        expect(formatUnlockPaidPill(unlock, 'ios')).not.toMatch(currency);
        if (paidWith !== 'cash') {
          expect(formatUnlockPaid(unlock, 'android')).not.toMatch(currency);
          expect(formatUnlockPaidPill(unlock, 'android')).not.toMatch(currency);
        }
      }
    }
  });

  it('reads a row from a server that sends no payment as it always did', () => {
    const legacy = createUnlock({ purchasePriceUsdCents: 900 }) as Partial<ViewerUnlockItem>;
    delete legacy.paidWith;
    delete legacy.paidAmountSubunits;
    delete legacy.paidCurrency;
    for (const platform of ['ios', 'android']) {
      expect(formatUnlockPaid(legacy as ViewerUnlockItem, platform)).toBe('900 credits');
      expect(formatUnlockPaidPill(legacy as ViewerUnlockItem, platform)).toBe('900 credits paid');
      expect(formatUnlockPaid({ ...(legacy as ViewerUnlockItem), purchasePriceUsdCents: 0 }, platform)).toBe('Free');
    }
  });

  it('keeps an unreadable cash amount from becoming a wrong one', () => {
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: null, paidCurrency: 'INR' }), 'android')).toBe('Paid');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: null }), 'android')).toBe('Paid');
    expect(formatUnlockPaid(createUnlock({ paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: 'XX1' }), 'android')).toBe('9.00 XX1 paid');
  });
});

describe('pictures among a purchase\'s resources', () => {
  const resources = (overrides: Partial<PostResourceBundleResources> = {}): PostResourceBundleResources => ({
    promptText: 'A prompt',
    notesMarkdown: null,
    workflowShareUrl: null,
    workflowSnapshot: null,
    attachments: [],
    allowRemix: false,
    ...overrides,
  });
  const item = (overrides: Partial<PostResourceItem>): PostResourceItem => ({
    type: 'reference_image',
    role: 'character_reference',
    sectionId: null,
    title: '@alisa',
    description: null,
    textContent: null,
    externalUrl: null,
    storagePath: 'references/alisa.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 120_000,
    workflowSnapshot: null,
    sortOrder: 0,
    isPrimary: true,
    remixUse: 'reference_only',
    ...overrides,
  });

  it('finds a stored picture among the items', () => {
    expect(hasResourcePictures(resources({ items: [item({ type: 'prompt', storagePath: null, contentType: null }), item({})] }))).toBe(true);
    expect(hasResourcePictures(resources({ items: [item({ type: 'source_file', contentType: 'image/png' })] }))).toBe(true);
  });

  // A mature purchase whose only visual references were clips kept no plate,
  // and once a clip's card drew its still that still showed uncovered.
  it('counts a stored clip, whose card draws its still and whose viewer plays it', () => {
    expect(hasResourcePictures(resources({
      items: [item({ type: 'reference_video', storagePath: 'references/clip.mp4', contentType: 'video/mp4' })],
    }))).toBe(true);
    expect(hasResourcePictures(resources({ items: [item({ type: 'source_file', storagePath: 'references/source.mov', contentType: 'video/quicktime' })] }))).toBe(true);
    expect(hasResourcePictures(resources({ items: [item({ type: 'reference_video', storagePath: 'references/clip', contentType: null })] }))).toBe(true);
    expect(hasResourcePictures(resources({
      attachments: [{ label: 'Take', kind: 'file', storagePath: 'references/take.mp4', contentType: 'video/mp4' }],
    }))).toBe(true);
  });

  it('ignores sounds, and pictures and clips that are only links', () => {
    expect(hasResourcePictures(resources({
      items: [
        item({ type: 'reference_audio', storagePath: 'references/track.mp3', contentType: 'audio/mpeg' }),
        item({ storagePath: null, externalUrl: 'https://example.com/board.jpg' }),
        item({ type: 'reference_video', storagePath: null, contentType: 'video/mp4', externalUrl: 'https://example.com/take.mp4' }),
      ],
    }))).toBe(false);
    expect(hasResourcePictures(resources())).toBe(false);
    expect(hasResourcePictures(null)).toBe(false);
  });

  it("reads a legacy bundle's attachments when it has no items, as the bundle content does", () => {
    const legacy = resources({ attachments: [{ label: 'Look', kind: 'file', storagePath: 'references/look.jpg', contentType: 'image/jpeg' }] });
    expect(hasResourcePictures(legacy)).toBe(true);
    expect(hasResourcePictures({ ...legacy, items: [] })).toBe(true);
    expect(hasResourcePictures({ ...legacy, items: [item({ type: 'prompt', storagePath: null, contentType: null })] })).toBe(false);
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
      .toBe("This post isn't available to you. Your recipe stays here.");
    expect(describeUnreachableUnlockedPost(detail({ post: { ...livePost, visibility: 'unlisted' }, postReachable: false })))
      .toBe("This post isn't available to you. Your recipe stays here.");
    expect(describeUnreachableUnlockedPost(detail({ post: { ...livePost, visibility: 'private' } })))
      .toBe('This post is no longer public. Your recipe stays available here.');
    expect(describeUnreachableUnlockedPost(detail({ post: { ...livePost, archivedAt: '2026-10-01T00:00:00.000Z' } })))
      .toBe('This post is no longer public. Your recipe stays available here.');
    expect(describeUnreachableUnlockedPost(detail({ post: null, postVisibility: null })))
      .toBe('This post is no longer public. Your recipe stays available here.');
  });
});
