import { describe, expect, it } from 'vitest';

import type { ViewerUnlockItem } from '@/lib/types';
import {
  formatUnlockDate,
  formatUnlockPrice,
  getUnlockDestination,
  getUnlockStateBadge,
  summarizeUnlockCount,
} from '@/lib/unlock-library-view-model';

function createUnlock(overrides: Partial<ViewerUnlockItem> = {}): ViewerUnlockItem {
  return {
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
    post: {
      title: 'Launch post',
      category: 'image',
      postFormat: 'media',
      mediaUrl: null,
      mediaKind: 'image',
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

  it('prices unlocks in tokens with the dollar equivalent', () => {
    expect(formatUnlockPrice(500)).toBe('500 tokens ($5.00)');
    expect(formatUnlockPrice(10)).toBe('10 tokens ($0.10)');
  });

  it('labels a free unlock rather than showing zero', () => {
    expect(formatUnlockPrice(0)).toBe('Free');
  });

  it('offers no destination when the post is gone', () => {
    expect(getUnlockDestination(createUnlock({ postId: null }))).toBeNull();
    expect(getUnlockDestination(createUnlock())).toBe('/viewer?postId=post-1&source=unlocks');
  });

  it('pluralizes the count', () => {
    expect(summarizeUnlockCount(1)).toBe('1 unlock · yours permanently');
    expect(summarizeUnlockCount(4)).toBe('4 unlocks · yours permanently');
  });

  it('degrades to an empty string on an unparseable date', () => {
    expect(formatUnlockDate('not-a-date')).toBe('');
  });
});
