import { describe, expect, it } from 'vitest';

import { buildShowcaseMasonry, getShowcaseGridLayout } from '../lib/showcase-feed-view-model';
import type { ShowcaseFeedItem } from '../lib/types';

function item(overrides: Partial<ShowcaseFeedItem>): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: null,
    mediaKind: null,
    model: 'manual',
    title: 'Beauty hook',
    prompt: 'Launch the serum with an opening shelf shot',
    body: 'Reusable creator prompt',
    category: 'image',
    postFormat: 'media',
    saveCount: 1200,
    remixCount: 92,
    createdAt: '2026-05-13T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

describe('showcase feed view model', () => {
  it('builds a flat Pinterest-style feed with stable card metadata', () => {
    const cards = buildShowcaseMasonry([
      item({
        id: 'image-post',
        category: 'image',
        mediaKind: 'image',
        asset: {
          id: 'asset-1',
          postId: 'image-post',
          title: 'Prompt pack',
          accessMode: 'free',
          priceUsdCents: 0,
          previewText: 'Unlock',
          allowRemix: true,
        },
        canRemix: true,
      }),
      item({ id: 'video-post', category: 'video', mediaKind: 'video', saveCount: 34, remixCount: 8 }),
      item({ id: 'text-post', category: 'text', postFormat: 'text', body: 'Caption framework for a food launch.' }),
    ]);

    expect(cards.map((card) => card.id)).toEqual(['image-post', 'video-post', 'text-post']);
    expect(cards[0]).toMatchObject({
      accent: 'image',
      badge: 'Free unlock',
      creatorAvatar: null,
      creatorLabel: 'luna',
      previewKind: 'media',
      saveLabel: '1.2K',
      remixLabel: '92',
      viewerSource: 'showcase-feed',
      sourceId: 'image-post',
    });
    expect(cards[1]).toMatchObject({
      accent: 'video',
      badge: 'Video',
    });
    expect(cards[2]).toMatchObject({
      accent: 'amber',
      badge: 'Prompt',
      previewKind: 'text',
    });
    expect(new Set(cards.map((card) => card.height)).size).toBeGreaterThan(1);
  });

  it('keeps mobile masonry columns visually separated', () => {
    const layout = getShowcaseGridLayout(390);

    expect(layout.columnGap).toBeGreaterThanOrEqual(12);
    expect(layout.columnGap).toBeLessThanOrEqual(16);
    expect(layout.pinGap).toBeGreaterThanOrEqual(18);
    expect(layout.mediaRadius).toBeGreaterThanOrEqual(16);
  });

  it('keeps the original feed item available for cache seeding', () => {
    const sourceItem = item({ id: 'post-for-detail', title: 'Instant detail' });
    const cards = buildShowcaseMasonry([sourceItem]);

    expect(cards[0]?.item).toBe(sourceItem);
  });
});
