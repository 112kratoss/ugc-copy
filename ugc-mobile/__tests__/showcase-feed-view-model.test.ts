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
    commentCount: 0,
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
    ]);

    expect(cards.map((card) => card.id)).toEqual(['image-post', 'video-post']);
    expect(cards[0]).toMatchObject({
      accent: 'image',
      badge: 'Free unlock',
      creatorAvatar: null,
      creatorLabel: 'luna',
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
  });

  it('leaves text-only posts to the home feed', () => {
    const cards = buildShowcaseMasonry([
      item({ id: 'image-post', category: 'image', mediaKind: 'image' }),
      item({ id: 'text-post', category: 'text', postFormat: 'text', body: 'Caption framework for a food launch.' }),
    ]);

    expect(cards.map((card) => card.id)).toEqual(['image-post']);
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

  it('uses tight Pinterest-style masonry spacing without merging columns', () => {
    const layout = getShowcaseGridLayout(390);

    expect(layout.columnGap).toBeGreaterThanOrEqual(7);
    expect(layout.columnGap).toBeLessThanOrEqual(10);
    expect(layout.pinGap).toBeGreaterThanOrEqual(14);
    expect(layout.pinGap).toBeLessThanOrEqual(18);
    expect(layout.mediaRadius).toBeGreaterThanOrEqual(16);
  });

  it('replaces generic feed titles with useful post content', () => {
    const [mediaCard] = buildShowcaseMasonry([
      item({
        id: 'generic-media',
        title: 'Untitled Creation',
        prompt: 'Editorial portrait with a teal rim light',
      }),
    ]);

    expect(mediaCard?.title).toBe('Editorial portrait with a teal rim light');
  });

  it('keeps the original feed item available for cache seeding', () => {
    const sourceItem = item({ id: 'post-for-detail', title: 'Instant detail' });
    const cards = buildShowcaseMasonry([sourceItem]);

    expect(cards[0]?.item).toBe(sourceItem);
  });

  it('uses each media ratio for bounded masonry heights', () => {
    const [portrait, square, landscape, panorama] = buildShowcaseMasonry([
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
        id: 'square',
        mediaKind: 'image',
        mediaUrl: 'square.jpg',
        mediaItems: [{
          id: 'square-media',
          url: 'square.jpg',
          mediaKind: 'image',
          contentType: 'image/jpeg',
          originalName: 'square.jpg',
          width: 1200,
          height: 1200,
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
      item({
        id: 'panorama',
        mediaKind: 'image',
        mediaUrl: 'panorama.jpg',
        mediaItems: [{
          id: 'panorama-media',
          url: 'panorama.jpg',
          mediaKind: 'image',
          contentType: 'image/jpeg',
          originalName: 'panorama.jpg',
          width: 3200,
          height: 800,
          durationSeconds: null,
          sortOrder: 0,
        }],
      }),
    ]);

    expect(getShowcaseMediaHeight(portrait, 180)).toBe(320);
    expect(getShowcaseMediaHeight(square, 180)).toBe(180);
    expect(getShowcaseMediaHeight(landscape, 180)).toBe(104);
    expect(getShowcaseMediaHeight(panorama, 180)).toBe(104);
  });

  it('uses a clean landscape fallback for videos and accepts a resolved poster ratio', () => {
    const [video] = buildShowcaseMasonry([
      item({
        id: 'video-without-dimensions',
        category: 'video',
        mediaKind: 'video',
      }),
    ]);

    expect(video?.aspectRatio).toBeNull();
    expect(getShowcaseMediaHeight(video, 180)).toBe(104);
    expect(getShowcaseMediaHeight(video, 180, 9 / 16)).toBe(320);
  });
});
