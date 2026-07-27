import { describe, expect, it } from 'vitest';

import {
  HOME_FEED_CHIPS,
  buildHomeFeedCards,
  getHomeFeedChip,
  getHomeFeedMediaHeight,
  getHomeFeedSlides,
  showcaseToHomeFeedCard,
} from '@/lib/home-feed-view-model';
import { createShowcaseFeedQueryKey } from '@/lib/showcase-feed-query';
import type { ShowcaseFeedItem } from '@/lib/types';

function item(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://cdn.example.test/post-1.png',
    mediaKind: 'image',
    model: 'Nano Banana',
    title: 'A launch frame',
    prompt: 'a cinematic product frame',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 1200,
    remixCount: 8,
    commentCount: 34,
    createdAt: new Date().toISOString(),
    creator: { id: 'creator-1', username: 'batman', name: 'Batman', avatar: null },
    generationId: 'gen-1',
    asset: null,
    canRemix: true,
    ...overrides,
  } as ShowcaseFeedItem;
}

describe('home feed view model', () => {
  describe('chips', () => {
    it('maps each chip to feed params the API already supports', () => {
      expect(HOME_FEED_CHIPS.map((chip) => chip.id)).toEqual(['for-you', 'recent', 'unlocks']);
      expect(getHomeFeedChip('recent').filters).toEqual({ sort: 'recent' });
      expect(getHomeFeedChip('unlocks').filters).toEqual({ sort: 'for-you', unlock: 'with-unlock' });
    });

    it('falls back to For You for an unknown chip', () => {
      expect(getHomeFeedChip('nonsense').id).toBe('for-you');
      expect(getHomeFeedChip(null).id).toBe('for-you');
    });

    it('keeps chip query keys under the shared showcase-feed prefix', () => {
      // The viewer scans this prefix for cached items, so home cards open instantly.
      for (const chip of HOME_FEED_CHIPS) {
        const key = createShowcaseFeedQueryKey(chip.filters, 'viewer-1');
        expect(key.slice(0, 3)).toEqual(['showcase-feed', 'infinite', 'viewer-1']);
      }
    });

    it('gives the unlocks chip the same key the showcase unlocks filter uses', () => {
      expect(createShowcaseFeedQueryKey(getHomeFeedChip('unlocks').filters, 'viewer-1'))
        .toEqual(createShowcaseFeedQueryKey({ sort: 'for-you', unlock: 'with-unlock' }, 'viewer-1'));
    });
  });

  describe('top slider', () => {
    it('leads with the workspace slide then the enabled tool shortcuts', () => {
      const slides = getHomeFeedSlides();

      expect(slides[0]).toMatchObject({ kind: 'workspace', ctaLabel: 'Create new' });
      expect(slides.slice(1).map((slide) => slide.id)).toEqual(['image', 'video', 'motion']);
    });

    it('omits shortcuts that have no destination yet', () => {
      expect(getHomeFeedSlides().some((slide) => slide.id === 'workflow')).toBe(false);
    });
  });

  describe('card building', () => {
    it('keeps every post format, including previews that are not grid ready', () => {
      const cards = buildHomeFeedCards([
        item(),
        item({ id: 'text-post', mediaUrl: null, mediaKind: null, category: 'text', postFormat: 'text', body: 'A note' }),
      ]);

      expect(cards.map((card) => card.id)).toEqual(['post-1', 'text-post']);
    });

    it('renders a mixed post as title plus body plus media', () => {
      const card = showcaseToHomeFeedCard(item({
        postFormat: 'mixed',
        title: 'Behind the shot',
        body: 'Here is how I lit this scene.',
      }));

      expect(card.previewKind).toBe('mixed');
      expect(card.title).toBe('Behind the shot');
      expect(card.bodyText).toBe('Here is how I lit this scene.');
      expect(card.mediaUrl).toBeTruthy();
    });

    it('treats a post with no media as text even when the format says otherwise', () => {
      const card = showcaseToHomeFeedCard(item({
        mediaUrl: null,
        mediaKind: null,
        postFormat: 'mixed',
        body: 'Just words',
      }));

      expect(card.previewKind).toBe('text');
      expect(card.bodyLines).toBe(6);
    });

    it('never repeats the title as the body', () => {
      const card = showcaseToHomeFeedCard(item({
        title: '',
        prompt: 'a cinematic product frame',
        body: '',
      }));

      expect(card.title).toBe('a cinematic product frame');
      expect(card.bodyText).toBe('');
    });

    it('labels category, accent, and compact counts', () => {
      const card = showcaseToHomeFeedCard(item());

      expect(card.categoryLabel).toBe('Image');
      expect(card.accent).toBe('image');
      expect(card.saveLabel).toBe('1.2K');
      expect(card.commentLabel).toBe('34');
      expect(card.creatorLabel).toBe('@batman');
    });

    it('accents video and text posts differently', () => {
      expect(showcaseToHomeFeedCard(item({ category: 'video', mediaKind: 'video' })).accent).toBe('video');
      expect(showcaseToHomeFeedCard(item({ creationMode: 'motion' })).accent).toBe('motion');
      expect(showcaseToHomeFeedCard(item({
        mediaUrl: null, mediaKind: null, category: 'text', postFormat: 'text', body: 'note',
      })).accent).toBe('amber');
    });

    it('opens into the shared showcase viewer source', () => {
      expect(showcaseToHomeFeedCard(item()).viewerSource).toBe('showcase-feed');
    });
  });

  describe('media height', () => {
    it('uses the real aspect ratio when the server reported dimensions', () => {
      const card = showcaseToHomeFeedCard(item({
        mediaItems: [{ id: 'media-1', url: 'https://cdn.example.test/post-1.png', width: 1000, height: 500 }],
      } as Partial<ShowcaseFeedItem>));

      expect(getHomeFeedMediaHeight(card, 400)).toBe(200);
    });

    it('clamps a very tall portrait so the next card stays reachable', () => {
      const card = showcaseToHomeFeedCard(item({
        mediaItems: [{ id: 'media-1', url: 'https://cdn.example.test/post-1.png', width: 200, height: 2000 }],
      } as Partial<ShowcaseFeedItem>));

      expect(getHomeFeedMediaHeight(card, 400)).toBe(500);
    });

    it('enforces a minimum height for very wide media', () => {
      const card = showcaseToHomeFeedCard(item({
        mediaItems: [{ id: 'media-1', url: 'https://cdn.example.test/post-1.png', width: 4000, height: 200 }],
      } as Partial<ShowcaseFeedItem>));

      expect(getHomeFeedMediaHeight(card, 400)).toBe(180);
    });

    it('falls back to a video ratio when dimensions are unknown', () => {
      const card = showcaseToHomeFeedCard(item({ mediaKind: 'video', category: 'video' }));

      expect(getHomeFeedMediaHeight(card, 400)).toBe(225);
    });
  });
});
