import { describe, expect, it } from 'vitest';

import { searchPostPinLabel } from '../lib/public-search-policy/public-search-policy';
import {
  SEARCH_TEXT_PIN_ASPECT_RATIO,
  buildSearchPostPin,
  searchPostMadeWithLabel,
  searchPostPinMediaHeight,
  splitSearchPostColumns,
} from '../lib/search-post-masonry';
import type { ShowcaseFeedItem } from '../lib/types';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const DAY = 86_400_000;

function item(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'p1',
    title: 'Neon portrait',
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    mediaKind: 'image',
    mediaUrl: 'https://cdn.example.test/p1.jpg',
    mediaItems: [{ id: 'm1', sortOrder: 0, mediaKind: 'image', url: 'https://cdn.example.test/p1.jpg', previewUrl: null, width: 1000, height: 1500 }],
    model: 'nano-banana-2',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
    creator: { id: 'c1', name: 'Luna Studio', username: 'luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  } as unknown as ShowcaseFeedItem;
}

describe('a search post drawn as a feed pin', () => {
  it('names the creator by handle, the model it was made with and when, all in its label', () => {
    const pin = buildSearchPostPin(item(), { now: NOW });
    expect(pin.handle).toBe('@luna');
    expect(pin.madeWith).toBe('Made with Nano Banana 2.0');
    expect(pin.date).toBe('3d ago');
    expect(pin.badge).toBeNull();
    expect(pin.video).toBe(false);
    expect(pin.label).toBe('Open post Neon portrait by @luna. Made with Nano Banana 2.0. 3d ago');
  });

  it('wears Explore\'s badge and the video mark, and says them', () => {
    const pin = buildSearchPostPin(item({
      mediaKind: 'video',
      mediaUrl: 'https://cdn.example.test/p1.mp4',
      asset: { accessMode: 'paid', priceUsdCents: 40, resourceKinds: ['prompt'], allowRemix: false } as ShowcaseFeedItem['asset'],
    }), { now: NOW });
    expect(pin.video).toBe(true);
    expect(pin.badge).toMatch(/credits?$/);
    expect(pin.label).toBe(`Open post Neon portrait by @luna. ${pin.badge}. Video. Made with Nano Banana 2.0. 3d ago`);
  });

  it('falls back to the display name for a creator with no handle', () => {
    expect(buildSearchPostPin(item({ creator: { id: 'c1', name: 'Luna Studio', username: null, avatar: null } as unknown as ShowcaseFeedItem['creator'] }), { now: NOW }).handle)
      .toBe('Luna Studio');
  });

  it('says what a post was made with only where the post says it: the narrowed entity, a named model, a tool, else nothing', () => {
    // The model or tool the search is narrowed to, when the post carries it, by the name the filter shows.
    expect(searchPostMadeWithLabel(item({ model: 'luma-ray-2' }), { id: 'model:luma-ray-2', label: 'Luma Ray 2' })).toBe('Luma Ray 2');
    expect(searchPostMadeWithLabel(
      item({ model: 'manual', sourceTools: [{ toolLabel: 'Midjourney', toolSlug: 'midjourney' }] }),
      { id: 'tool:midjourney', label: 'Midjourney v7' },
    )).toBe('Midjourney v7');
    // Narrowed to another one: the post's own model.
    expect(searchPostMadeWithLabel(item(), { id: 'model:luma-ray-2', label: 'Luma Ray 2' })).toBe('Nano Banana 2.0');
    // An outside tool the creator named.
    expect(searchPostMadeWithLabel(item({ model: 'manual', sourceTools: [{ toolLabel: 'Midjourney', toolSlug: 'midjourney' }] }))).toBe('Midjourney');
    expect(searchPostMadeWithLabel(item({ model: 'manual', sourceTool: 'Photoshop' }))).toBe('Photoshop');
    // A slug the feed does not name is never shown.
    expect(searchPostMadeWithLabel(item({ model: 'magicbooklet' }))).toBeNull();
    expect(buildSearchPostPin(item({ model: 'an-unknown-slug' }), { now: NOW }).madeWith).toBeNull();
  });

  it('draws a picture at its own shape and a text post at a fixed one', () => {
    const portrait = buildSearchPostPin(item(), { now: NOW });
    expect(searchPostPinMediaHeight(portrait, 180)).toBe(270);
    const note = buildSearchPostPin(item({ category: 'text', postFormat: 'text', mediaKind: null, mediaUrl: null, mediaItems: [], body: 'Words' }), { now: NOW });
    expect(note.card).toBeNull();
    expect(searchPostPinMediaHeight(note, 180)).toBe(Math.round(180 / SEARCH_TEXT_PIN_ASPECT_RATIO));
  });

  it('labels hold every part given, and only those', () => {
    expect(searchPostPinLabel({ title: 'A', creator: '@b' })).toBe('Open post A by @b');
    expect(searchPostPinLabel({ title: 'A', creator: '@b', badge: 'Free recipe', video: true, madeWith: 'Made with X', date: 'Oct 1' }))
      .toBe('Open post A by @b. Free recipe. Video. Made with X. Oct 1');
  });
});

describe('the search masonry', () => {
  it('puts each pin in the shortest column so far, the first on a tie, keeping the answer\'s order', () => {
    const heights: Record<string, number> = { a: 300, b: 100, c: 100, d: 100, e: 50 };
    const split = splitSearchPostColumns(['a', 'b', 'c', 'd', 'e'], 2, (pin) => heights[pin]);
    expect(split).toEqual([['a', 'e'], ['b', 'c', 'd']]);
  });

  it('keeps every pin in order in one column', () => {
    expect(splitSearchPostColumns(['a', 'b', 'c'], 1, () => 100)).toEqual([['a', 'b', 'c']]);
    expect(splitSearchPostColumns(['a'], 0, () => 100)).toEqual([['a']]);
  });
});
