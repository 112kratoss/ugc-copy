import { describe, expect, it } from 'vitest';

import { buildShowcaseMasonry, getShowcaseGridLayout, getShowcaseMediaHeight } from '../lib/showcase-feed-view-model';
import type { ShowcaseFeedItem } from '../lib/types';

function item(overrides: Partial<ShowcaseFeedItem>): ShowcaseFeedItem {
  const result: ShowcaseFeedItem = {
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

  if (result.postFormat === 'text' || result.category === 'text') {
    return { ...result, mediaUrl: null, mediaKind: null, mediaItems: undefined };
  }

  const mediaKind = result.mediaKind ?? 'image';
  const mediaUrl = result.mediaUrl ?? `https://cdn.example.com/${result.id}.${mediaKind === 'video' ? 'mp4' : 'jpg'}`;
  return {
    ...result,
    mediaKind,
    mediaUrl,
    mediaItems: (result.mediaItems ?? [{
      id: `${result.id}:media`,
      url: mediaUrl,
      mediaKind,
      contentType: null,
      originalName: null,
      width: null,
      height: null,
      durationSeconds: null,
      sortOrder: 0,
    }]).map((media) => ({
      ...media,
      previewUrl: media.previewUrl ?? `${media.url}.preview.webp`,
      gridReady: media.gridReady ?? true,
    })),
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
          resourceKinds: ['prompt', 'files'],
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
      unlock: {
        accent: 'workflow',
        ctaLabel: 'Get resources — Free',
        label: 'Free unlock',
        summary: 'Prompt + Files + Remix',
      },
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

  it('describes paid unlocks and remixable posts for feed card CTAs', () => {
    const cards = buildShowcaseMasonry([
      item({
        id: 'paid-post',
        asset: {
          id: 'asset-paid',
          postId: 'paid-post',
          title: 'Launch kit',
          accessMode: 'paid',
          priceUsdCents: 900,
          previewText: 'Includes prompt and notes',
          allowRemix: false,
          resourceKinds: ['prompt', 'notes'],
          priceQuote: { formatted: '$9' },
        },
      }),
      item({
        id: 'remix-post',
        generationId: 'gen-remix',
        canRemix: true,
      }),
    ]);

    expect(cards[0]?.unlock).toEqual({
      accent: 'commerce',
      ctaLabel: 'View unlock',
      label: '$9',
      summary: 'Prompt + Notes',
    });
    expect(cards[1]?.unlock).toEqual({
      accent: 'motion',
      ctaLabel: 'Remix',
      label: 'Remixable',
      summary: 'Use this post as a starting point',
    });
  });

  it('does not show a remix CTA for manual or external posts without an app generation', () => {
    const [card] = buildShowcaseMasonry([
      item({
        id: 'external-remix-post',
        generationId: null,
        canRemix: true,
      }),
    ]);

    expect(card?.badge).toBe('Image');
    expect(card?.unlock).toBeNull();
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

  it('uses media dimensions for bounded masonry heights', () => {
    const [portrait, landscape] = buildShowcaseMasonry([
      item({
        id: 'portrait',
        mediaKind: 'image',
        mediaUrl: 'portrait.jpg',
        mediaItems: [{
          id: 'portrait-media',
          url: 'portrait.jpg',
          mediaKind: 'image',
          contentType: 'image/jpeg',
          originalName: 'portrait.jpg',
          width: 900,
          height: 1600,
          durationSeconds: null,
          sortOrder: 0,
        }],
      }),
      item({
        id: 'landscape',
        mediaKind: 'image',
        mediaUrl: 'landscape.jpg',
        mediaItems: [{
          id: 'landscape-media',
          url: 'landscape.jpg',
          mediaKind: 'image',
          contentType: 'image/jpeg',
          originalName: 'landscape.jpg',
          width: 1600,
          height: 900,
          durationSeconds: null,
          sortOrder: 0,
        }],
      }),
    ]);

    expect(getShowcaseMediaHeight(portrait, 170)).toBeGreaterThan(getShowcaseMediaHeight(landscape, 170));
    expect(getShowcaseMediaHeight(portrait, 170)).toBeLessThanOrEqual(320);
    expect(getShowcaseMediaHeight(landscape, 170)).toBeGreaterThanOrEqual(180);
  });
});
