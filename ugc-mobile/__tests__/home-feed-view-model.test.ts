import { describe, expect, it } from 'vitest';

import {
  HOME_FEED_CHIPS,
  advanceHomeSlide,
  buildHomeFeedCards,
  buildLoopedHomeSlides,
  canExpandHomeFeedBody,
  estimateWrappedLineCount,
  getHomeFeedCardOpenTarget,
  getHomeFeedChip,
  getHomeFeedMediaHeight,
  getHomeFeedSlides,
  getHomeSlideIndexFromOffset,
  getHomeSlideOffset,
  getHomeSlidePassWidth,
  getInitialHomeSlideIndex,
  foldHomeSlideOffset,
  shouldAutoAdvanceHomeSlides,
  showcaseToHomeFeedCard,
} from '@/lib/home-feed-view-model';
import { createShowcaseFeedQueryKey, getShowcaseFeedPageParams } from '@/lib/showcase-feed-query';
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
      expect(HOME_FEED_CHIPS.map((chip) => chip.id)).toEqual(['for-you', 'notes', 'recent', 'unlocks']);
      expect(getHomeFeedChip('recent').filters).toEqual({ sort: 'recent' });
      expect(getHomeFeedChip('unlocks').filters).toEqual({ sort: 'for-you', unlock: 'with-unlock' });
      expect(getHomeFeedChip('notes').filters).toEqual({ sort: 'for-you', category: 'text' });
    });

    it('asks the API for the text category on the notes chip and nothing else', () => {
      // Home is the only client sending `category=text`; the showcase grid has
      // no text lane, so this is the contract that keeps the chip working.
      const params = getShowcaseFeedPageParams(getHomeFeedChip('notes').filters);

      expect(params).toMatchObject({ category: 'text', sort: 'for-you' });
      expect(params).not.toHaveProperty('unlock');
      expect(params).not.toHaveProperty('resource');
      expect(params).not.toHaveProperty('tool');
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

    // Mirrored on web in post-feed-presentation.test.ts — the two clients
    // duplicate these rules on purpose.
    it('reads action labels as verbs until there is social proof', () => {
      const quiet = showcaseToHomeFeedCard(item({ saveCount: 0, commentCount: 0, remixCount: 0 }));

      expect(quiet.saveLabel).toBe('Save');
      expect(quiet.commentLabel).toBe('Comment');
      expect(quiet.remixLabel).toBe('Remix');

      expect(showcaseToHomeFeedCard(item({ remixCount: 8 })).remixLabel).toBe('Remix · 8');
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

  describe('body clamping', () => {
    const textCard = () => showcaseToHomeFeedCard(item({
      mediaUrl: null,
      mediaKind: null,
      category: 'text',
      postFormat: 'text',
      title: 'Hook framework',
      prompt: '',
      body: 'A reusable note for framing a launch post.',
    }));

    const mixedCard = () => showcaseToHomeFeedCard(item({
      postFormat: 'mixed',
      title: 'Behind the shot',
      body: 'Here is how I lit this scene.',
    }));

    it('gives a text post the most room and a caption the least', () => {
      expect(textCard().bodyLines).toBe(6);
      expect(mixedCard().bodyLines).toBe(3);
      expect(showcaseToHomeFeedCard(item()).bodyLines).toBe(2);
    });

    it('opens a text post on its own screen, not in the showcase reel', () => {
      expect(getHomeFeedCardOpenTarget(textCard())).toBe('post');
      expect(getHomeFeedCardOpenTarget(mixedCard())).toBe('viewer');
      expect(getHomeFeedCardOpenTarget(showcaseToHomeFeedCard(item()))).toBe('viewer');
    });

    it('counts a hard newline as its own line', () => {
      expect(estimateWrappedLineCount('one\ntwo\nthree', 400, 16)).toBe(3);
      expect(estimateWrappedLineCount('para\n\npara', 400, 16)).toBe(3);
    });

    it('wraps long text by the available width', () => {
      const text = 'x'.repeat(200);

      expect(estimateWrappedLineCount(text, 400, 16)).toBeGreaterThan(
        estimateWrappedLineCount(text, 800, 16)
      );
    });

    it('reports no lines for empty text or a zero width', () => {
      expect(estimateWrappedLineCount('', 400, 16)).toBe(0);
      expect(estimateWrappedLineCount('words', 0, 16)).toBe(0);
    });

    it('offers Read more only when the clamp actually hides part of a caption', () => {
      const caption = (body: string) => showcaseToHomeFeedCard(item({ postFormat: 'mixed', body }));

      expect(canExpandHomeFeedBody(caption('One line.'), 360)).toBe(false);
      expect(canExpandHomeFeedBody(caption('sentence. '.repeat(400)), 360)).toBe(true);
    });

    it('never offers Read more for a text post — the card opens the post', () => {
      const note = (body: string) => showcaseToHomeFeedCard(item({
        mediaUrl: null, mediaKind: null, category: 'text', postFormat: 'text',
        title: 'A note', prompt: '', body,
      }));

      expect(canExpandHomeFeedBody(note('One line.'), 360)).toBe(false);
      expect(canExpandHomeFeedBody(note('sentence. '.repeat(400)), 360)).toBe(false);
    });

    it('never offers Read more for a post with no body', () => {
      const card = showcaseToHomeFeedCard(item({ title: 'A launch frame', prompt: '', body: '' }));

      expect(card.bodyText).toBe('');
      expect(canExpandHomeFeedBody(card, 360)).toBe(false);
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
  describe('slide rotation', () => {
    const SLIDE_WIDTH = 300;
    const GAP = 10;

    it('advances one slide at a time', () => {
      expect(advanceHomeSlide(0, 4)).toBe(1);
      expect(advanceHomeSlide(2, 4)).toBe(3);
    });

    it('keeps going forward past the last slide instead of rewinding', () => {
      // Index 8 is the next pass's copy of the first slide, so the carousel
      // travels on in the same direction rather than sweeping back.
      expect(advanceHomeSlide(7, 4)).toBe(8);
    });

    it('stays put when there is nothing to rotate through', () => {
      expect(advanceHomeSlide(0, 1)).toBe(0);
      expect(advanceHomeSlide(0, 0)).toBe(0);
    });

    it('starts in the middle pass so a backward swipe has somewhere to go', () => {
      expect(getInitialHomeSlideIndex(4)).toBe(4);
      expect(getInitialHomeSlideIndex(1)).toBe(0);
    });

    it('measures the rail period from the snap interval', () => {
      expect(getHomeSlidePassWidth(4, SLIDE_WIDTH, GAP)).toBe(1240);
    });

    it('folds a wrapped offset back by exactly one pass', () => {
      // Forward wrap: settled in pass three, translated into the middle pass.
      expect(foldHomeSlideOffset(2480, 1240)).toBe(1240);
      // Backward wrap: settled in pass one after a back-swipe from the first slide.
      expect(foldHomeSlideOffset(930, 1240)).toBe(2170);
    });

    it('leaves an offset already inside the middle pass untouched', () => {
      // No scroll is issued on an unchanged offset, so at-rest settles are free.
      expect(foldHomeSlideOffset(1240, 1240)).toBe(1240);
      expect(foldHomeSlideOffset(1550, 1240)).toBe(1550);
      expect(foldHomeSlideOffset(2479, 1240)).toBe(2479);
    });

    it('preserves a few pixels of snap error instead of folding it into the jump', () => {
      // The scroll rested 3px past the snap point; the translation keeps that
      // remainder so the teleport moves no pixels. Snapping to the canonical
      // slide offset here is what showed up as a flick.
      expect(foldHomeSlideOffset(2483, 1240)).toBe(1243);
      expect(foldHomeSlideOffset(927, 1240)).toBe(2167);
    });

    it('is a no-op without a real pass width', () => {
      expect(foldHomeSlideOffset(640, 0)).toBe(640);
    });

    it('always folds into the middle pass by whole passes', () => {
      const passWidth = 1240;

      // Whatever the scroll settles on — flung far, overscrolled negative —
      // the corrected offset sits in the middle pass and differs from the
      // original by an exact number of passes, so every visible pixel lands
      // on its own copy.
      for (let offset = -passWidth; offset < passWidth * 4; offset += 173) {
        const folded = foldHomeSlideOffset(offset, passWidth);

        expect(folded).toBeGreaterThanOrEqual(passWidth);
        expect(folded).toBeLessThan(passWidth * 2);
        expect(Math.abs((folded - offset) % passWidth)).toBe(0);
      }
    });

    it('lays the slides out three times with unique keys', () => {
      const slides = getHomeFeedSlides();
      const looped = buildLoopedHomeSlides(slides);

      expect(looped).toHaveLength(slides.length * 3);
      expect(new Set(looped.map((entry) => entry.key)).size).toBe(looped.length);
      expect(looped[slides.length].slide).toBe(slides[0]);
      expect(looped[slides.length - 1].slide).toBe(slides[slides.length - 1]);
    });

    it('leaves a single slide unrepeated', () => {
      const [only] = getHomeFeedSlides();

      expect(buildLoopedHomeSlides([only])).toHaveLength(1);
    });

    it('places each slide on the snap interval', () => {
      expect(getHomeSlideOffset(0, SLIDE_WIDTH, GAP)).toBe(0);
      expect(getHomeSlideOffset(2, SLIDE_WIDTH, GAP)).toBe(620);
    });

    it('reads the settled slide back from a scroll offset', () => {
      expect(getHomeSlideIndexFromOffset(0, SLIDE_WIDTH, GAP, 12)).toBe(0);
      expect(getHomeSlideIndexFromOffset(620, SLIDE_WIDTH, GAP, 12)).toBe(2);
      // Snapping settles a few pixels off often enough to round, not floor.
      expect(getHomeSlideIndexFromOffset(618, SLIDE_WIDTH, GAP, 12)).toBe(2);
    });

    it('clamps an overscrolled offset to a laid-out position', () => {
      expect(getHomeSlideIndexFromOffset(-40, SLIDE_WIDTH, GAP, 12)).toBe(0);
      expect(getHomeSlideIndexFromOffset(9000, SLIDE_WIDTH, GAP, 12)).toBe(11);
    });

    it('resolves a settle outside the middle pass back to the centre', () => {
      // The rotation runs off the middle pass and settles on pass three; the
      // offset is folded home, then the timer's index re-read from it.
      const folded = foldHomeSlideOffset(getHomeSlideOffset(8, SLIDE_WIDTH, GAP), 1240);

      expect(folded).toBe(getHomeSlideOffset(4, SLIDE_WIDTH, GAP));
      expect(getHomeSlideIndexFromOffset(folded, SLIDE_WIDTH, GAP, 12)).toBe(4);
    });

    it('rotates only while focused, untouched, and motion is allowed', () => {
      const running = { slideCount: 4, isFocused: true, isInteracting: false, reduceMotion: false };

      expect(shouldAutoAdvanceHomeSlides(running)).toBe(true);
      expect(shouldAutoAdvanceHomeSlides({ ...running, isFocused: false })).toBe(false);
      expect(shouldAutoAdvanceHomeSlides({ ...running, isInteracting: true })).toBe(false);
      expect(shouldAutoAdvanceHomeSlides({ ...running, reduceMotion: true })).toBe(false);
      expect(shouldAutoAdvanceHomeSlides({ ...running, slideCount: 1 })).toBe(false);
    });
  });
});
