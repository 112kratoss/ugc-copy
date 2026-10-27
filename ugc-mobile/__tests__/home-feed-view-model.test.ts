import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// `lib/tab-bar-ambient.ts` reads `Platform.OS`, and vitest cannot parse
// react-native's own entry point.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import feedRecipeChipContract from '../../contracts/feed-recipe-chip-v1.json';
import {
  HOME_FEED_CHIPS,
  buildHomeFeedCards,
  canExpandHomeFeedBody,
  estimateWrappedLineCount,
  getHomeFeedCardOpenTarget,
  getHomeFeedMediaHeight,
  homeRecipeChip,
  showcaseToHomeFeedCard,
  type HomeFeedChipId,
} from '@/lib/home-feed-view-model';
import { FREE_RECIPE_LABEL } from '@/lib/pricing';
import { createShowcaseFeedQueryKey, getShowcaseFeedPageParams } from '@/lib/showcase-feed-query';
import { applyShowcaseSaveStateToFeedResponse } from '@/lib/showcase-save-cache';
import { selectBottomVisibleAmbientSource } from '@/lib/tab-bar-ambient';
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
    const chipFilters = (id: HomeFeedChipId) => HOME_FEED_CHIPS.find((chip) => chip.id === id)!.filters;

    it('maps each chip to feed params the API already supports', () => {
      expect(HOME_FEED_CHIPS.map(({ id, filters }) => [id, filters])).toEqual([
        ['for-you', { sort: 'for-you' }],
        ['notes', { sort: 'for-you', category: 'text' }],
        ['recent', { sort: 'recent' }],
        ['unlocks', { sort: 'for-you', unlock: 'with-unlock' }],
      ]);
    });

    it('asks the API for the text category on the notes chip and nothing else', () => {
      // Home is the only client sending `category=text`; the showcase grid has
      // no text lane, so this is the contract that keeps the chip working.
      const params = getShowcaseFeedPageParams(chipFilters('notes'));

      expect(params).toMatchObject({ category: 'text', sort: 'for-you' });
      expect(params).not.toHaveProperty('unlock');
      expect(params).not.toHaveProperty('resource');
      expect(params).not.toHaveProperty('tool');
    });

    it('keeps chip query keys under the shared showcase-feed prefix', () => {
      // The viewer scans this prefix for cached items, so home cards open instantly.
      for (const chip of HOME_FEED_CHIPS) {
        const key = createShowcaseFeedQueryKey(chip.filters, 'viewer-1');
        expect(key.slice(0, 3)).toEqual(['showcase-feed', 'infinite', 'viewer-1']);
      }
    });

    it('gives the unlocks chip the same key the showcase unlocks filter uses', () => {
      expect(createShowcaseFeedQueryKey(chipFilters('unlocks'), 'viewer-1'))
        .toEqual(createShowcaseFeedQueryKey({ sort: 'for-you', unlock: 'with-unlock' }, 'viewer-1'));
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

    it('names the model after the category as the web card does, never a slug', () => {
      // Mirrors the web's getPostModelDisplayName cases (post-feed-presentation.test.ts).
      expect(showcaseToHomeFeedCard(item({ model: 'imagen-4' })).modelLabel).toBe('Imagen 4');
      expect(showcaseToHomeFeedCard(item({ model: 'magicbooklet' })).modelLabel).toBeNull();
      expect(showcaseToHomeFeedCard(item({ model: 'manual' })).modelLabel).toBeNull();
      expect(showcaseToHomeFeedCard(item({ model: 'some-unknown-model' })).modelLabel).toBeNull();
      expect(showcaseToHomeFeedCard(item({ model: undefined })).modelLabel).toBeNull();
      expect(showcaseToHomeFeedCard(item({
        model: 'imagen-4',
        postFormat: 'text',
        mediaUrl: null,
        mediaKind: null,
        body: 'A note with no media.',
      })).modelLabel).toBeNull();
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

    // Nothing on the card draws the thumbhash, which makes it look unused: the
    // tab bar reads it off the list's viewability tokens to take its tint.
    it("carries its cover's thumbhash to the tab bar's tint", () => {
      const card = showcaseToHomeFeedCard(item({
        mediaItems: [{ id: 'media-1', url: 'https://cdn.example.test/post-1.png', previewThumbhash: 'cover-hash' }],
      } as Partial<ShowcaseFeedItem>));

      expect(selectBottomVisibleAmbientSource([{ index: 0, isViewable: true, item: card }]))
        .toEqual({ thumbhash: 'cover-hash' });
    });
  });

  // FlashList re-renders a cell whose item is a new object, so a card that is
  // rebuilt for an unchanged post re-renders that post's cell for nothing.
  describe('card identity across rebuilds', () => {
    it('hands back the card it built for the same item', () => {
      const post = item();
      const [first] = buildHomeFeedCards([post]);
      // The next page landing rebuilds the list with the same item object.
      const [again, appended] = buildHomeFeedCards([post, item({ id: 'post-2' })]);

      expect(again).toBe(first);
      expect(appended.id).toBe('post-2');
    });

    it('builds a new card only for the post a save changed', () => {
      const page = { items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] };
      const before = buildHomeFeedCards(page.items);
      const saved = applyShowcaseSaveStateToFeedResponse(page, { postId: 'b', isSaved: true, saveCount: 1201 })!;
      const after = buildHomeFeedCards(saved.items);

      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
      expect(after[1]).toMatchObject({ id: 'b', isSaved: true });
      expect(after[2]).toBe(before[2]);
    });

    it('builds a new card when the clock moves its time label, and only then', () => {
      // The clock is the one input a card has besides its item: the viewer's
      // own state (saved, remixable) arrives on the item.
      const post = item({ createdAt: '2026-10-14T10:00:00.000Z' });
      const [atFive] = buildHomeFeedCards([post], new Date('2026-10-14T10:05:00.000Z'));
      const [laterInTheMinute] = buildHomeFeedCards([post], new Date('2026-10-14T10:05:59.000Z'));
      const [atSix] = buildHomeFeedCards([post], new Date('2026-10-14T10:06:00.000Z'));

      expect(atFive.timeLabel).toBe('5m ago');
      expect(laterInTheMinute).toBe(atFive);
      expect(atSix).not.toBe(atFive);
      expect(atSix.timeLabel).toBe('6m ago');
      expect(buildHomeFeedCards([post], new Date('2026-10-14T10:06:30.000Z'))[0]).toBe(atSix);
    });
  });

  describe('remix action', () => {
    const bundle = {
      id: 'asset-1',
      postId: 'post-1',
      title: 'A launch frame',
      accessMode: 'free' as const,
      priceUsdCents: 0,
      previewText: 'The prompt behind this frame.',
      allowRemix: true,
      resourceKinds: ['prompt'],
    };

    it('offers Remix on a post anyone may remix', () => {
      const card = showcaseToHomeFeedCard(item());

      expect(card.remixAccess).toBe('open');
      expect(card.remixAccessibilityLabel).toBe('Remix A launch frame');
    });

    it('keeps offering Remix when it sits behind a free unlock', () => {
      // The card used to drop the button here, with nothing in its place.
      const card = showcaseToHomeFeedCard(item({
        canRemix: false,
        remixCapability: 'unlock_required',
        remixTarget: 'image',
        asset: bundle,
      }));

      expect(card.remixAccess).toBe('free-unlock');
      // Nothing is asked of the viewer, so it reads as any other Remix.
      expect(card.remixLabel).toBe('Remix · 8');
      expect(card.remixAccessibilityLabel).toBe('Remix A launch frame');
    });

    it('says a paid unlock comes first before the viewer taps', () => {
      const card = showcaseToHomeFeedCard(item({
        canRemix: false,
        remixCapability: 'unlock_required',
        remixTarget: 'image',
        asset: { ...bundle, accessMode: 'paid', priceUsdCents: 900 },
      }));

      expect(card.remixAccess).toBe('paid-unlock');
      // The price stands where "Remix · 8" would: the lock says the rest.
      expect(card.remixLabel).toBe('900 credits');
      expect(card.remixAccessibilityLabel).toBe('Unlock A launch frame to remix it, 900 credits');
    });

    it('offers nothing where there is nothing to remix', () => {
      // An upload from the camera roll, and a written note.
      expect(showcaseToHomeFeedCard(item({ generationId: null })).remixAccess).toBeNull();
      expect(showcaseToHomeFeedCard(item({
        mediaUrl: null,
        mediaKind: null,
        category: 'text',
        postFormat: 'text',
        body: 'A note',
        generationId: null,
        canRemix: false,
        remixCapability: 'none',
      })).remixAccess).toBeNull();
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
});

// A Home card used to carry a full-width row under its media: "Free unlock",
// then the post's own title again. The recipe is a chip at the end of the
// action row now, drawn only where it says something the row does not. The
// web's card follows the same cases (`getPostFeedRecipeChip`, asked by
// src/__tests__/feed-recipe-chip-parity.test.ts).
describe("a Home card's recipe chip", () => {
  const read = (name: string) => readFileSync(path.resolve(__dirname, '..', name), 'utf8');

  function recipePost({ asset, remix }: {
    asset: { accessMode: string; priceUsdCents: number; viewerHasUnlocked?: boolean } | null;
    remix: boolean;
  }) {
    return item({
      // `none` is the server saying there is nothing to remix, whatever is attached.
      canRemix: remix,
      remixCapability: remix ? 'public' : 'none',
      asset: asset ? {
        id: 'asset-1',
        postId: 'post-1',
        title: 'A launch frame',
        previewText: '',
        allowRemix: false,
        ...asset,
      } : null,
    } as Partial<ShowcaseFeedItem>);
  }

  it.each(feedRecipeChipContract.cases)('draws $name as the contract says', (entry) => {
    const { asset, remix, chip } = entry;
    const post = recipePost({ asset, remix });
    // Whose post it is is the viewer's to know, not the item's: the card is
    // built for the signed-in viewer, here the post's creator or someone else.
    const viewerIsOwner = 'viewerIsOwner' in entry && entry.viewerIsOwner === true;
    const card = showcaseToHomeFeedCard(post, new Date(), viewerIsOwner ? post.creator.id : 'someone-else');

    expect(Boolean(card.remixAccess)).toBe(remix);
    expect(card.recipeChip?.tone ?? null).toBe(chip?.tone ?? null);
    expect(card.recipeChip?.kind ?? null).toBe(chip?.kind ?? null);
    expect(card.recipeChip?.label ?? null).toBe(chip?.label.mobile ?? null);
  });

  it("says Your recipe on the viewer's own card, and builds the card again for another viewer", () => {
    const own = recipePost({ asset: { accessMode: 'paid', priceUsdCents: 250 }, remix: false });
    const now = new Date();

    expect(buildHomeFeedCards([own], now, own.creator.id)[0].recipeChip)
      .toMatchObject({ kind: 'owner', label: 'Your recipe' });
    // The same item object, read for someone else or signed out: not theirs.
    expect(buildHomeFeedCards([own], now, 'viewer-2')[0].recipeChip).toMatchObject({ kind: 'price', label: '250 credits' });
    expect(buildHomeFeedCards([own], now)[0].recipeChip).toMatchObject({ kind: 'price', label: '250 credits' });
  });

  it('calls a recipe the viewer has, and their own, what the web calls them', () => {
    const paid = { accessMode: 'paid', priceUsdCents: 250 };

    expect(homeRecipeChip(recipePost({ asset: { ...paid, viewerHasUnlocked: true }, remix: false }), 'A launch frame', null))
      .toMatchObject({ label: feedRecipeChipContract.unlockedLabel, kind: 'unlocked' });
    expect(homeRecipeChip(recipePost({ asset: paid, remix: false }), 'A launch frame', null, { isOwner: true }))
      .toMatchObject({ label: feedRecipeChipContract.ownerLabel, kind: 'owner' });
  });

  it('calls a recipe that costs nothing what the web calls it', () => {
    expect(FREE_RECIPE_LABEL).toBe(feedRecipeChipContract.freeLabel);
  });

  it('leaves a free recipe to Remix when that tap takes the unlock on its way', () => {
    // The web card takes the free unlock on the Remix tap too, so neither
    // client draws the chip beside Remix.
    const card = showcaseToHomeFeedCard(item({
      canRemix: false,
      remixCapability: 'unlock_required',
      remixTarget: 'image',
      asset: {
        id: 'asset-1',
        postId: 'post-1',
        title: 'A launch frame',
        accessMode: 'free',
        priceUsdCents: 0,
        previewText: '',
        allowRemix: true,
      },
    }));

    expect(card.remixAccess).toBe('free-unlock');
    expect(card.recipeChip).toBeNull();
  });

  it('puts the price on the locked Remix where the recipe is what locks it', () => {
    // Two pills would not fit on a phone's row, and both would open one unlock.
    const card = showcaseToHomeFeedCard(item({
      canRemix: false,
      remixCapability: 'unlock_required',
      remixTarget: 'image',
      asset: {
        id: 'asset-1',
        postId: 'post-1',
        title: 'A launch frame',
        accessMode: 'paid',
        priceUsdCents: 900,
        previewText: '',
        allowRemix: true,
      },
    }));

    expect(card.remixAccess).toBe('paid-unlock');
    expect(card.remixLabel).toBe('900 credits');
    expect(card.recipeChip).toBeNull();
  });

  it('keeps the price on a chip where the paid recipe does not lock Remix', () => {
    const paid = { accessMode: 'paid', priceUsdCents: 900 };

    expect(showcaseToHomeFeedCard(recipePost({ asset: paid, remix: true }))).toMatchObject({
      remixAccess: 'open',
      remixLabel: 'Remix · 8',
      recipeChip: { label: '900 credits', accessibilityLabel: 'Recipe for A launch frame, 900 credits', tone: 'paid' },
    });
    expect(showcaseToHomeFeedCard(recipePost({ asset: paid, remix: false }))).toMatchObject({
      remixAccess: null,
      recipeChip: { label: '900 credits', tone: 'paid' },
    });
  });

  it('says whose recipe it is to a screen reader', () => {
    expect(homeRecipeChip(recipePost({ asset: { accessMode: 'free', priceUsdCents: 0 }, remix: false }), 'A launch frame', null))
      .toEqual({ label: 'Free recipe', accessibilityLabel: 'Free recipe for A launch frame', tone: 'free', kind: 'free' });
  });

  it('draws the chip as the last action of the row, and no row of its own', () => {
    const card = read('components/home-feed-card.tsx');
    const shell = read('components/feed-card-shell.tsx');
    const share = card.indexOf('onPress={onShare}');
    const chip = card.indexOf('{card.recipeChip ? (');

    expect(share).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(share);
    expect(card.slice(chip)).toContain('label={card.recipeChip.label}');
    expect(card.slice(chip)).toContain('onPress={onAssetPress}');
    // A price is drawn in the commerce colour, on the chip and on a locked Remix.
    expect(card).toContain("tone={card.recipeChip.tone === 'paid' ? 'commerce' : 'default'}");
    expect(card).toContain("tone={card.remixAccess === 'paid-unlock' ? 'commerce' : 'default'}");
    // The row named the recipe by its title, which is the post's title again.
    expect(card).not.toContain('asset?.title');
    expect(card).not.toContain('cardUnlock');
    expect(shell).not.toMatch(/\bunlock\b/);
  });
});
