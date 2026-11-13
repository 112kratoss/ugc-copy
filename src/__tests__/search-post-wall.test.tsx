import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  SearchPostCard,
  SearchPostWall,
  placeSearchPostWall,
  searchPostCardFacts,
  searchPostCoverRatio,
  searchPostWallColumns,
} from '@/components/search/SearchPostWall';
import type { ShowcaseFeedItem } from '@/lib/showcase';

// Search's posts drawn as Explore draws its own (search UX audit 2026-11-13,
// finding 3): the picture at its own shape, the creator by handle, a mark on a
// clip, the date, what it was made with and the recipe badges, in a wall that
// keeps the ranked order. A browser's view of it: tests/e2e/public-search.spec.ts.

function item(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    title: 'Mahabali',
    body: '',
    prompt: '',
    model: 'nano-banana-2',
    sourceTool: null,
    category: 'image',
    postFormat: 'media',
    mediaKind: 'image',
    mediaUrl: 'https://cdn.example.test/a.png',
    mediaItems: [{
      id: 'm1', url: 'https://cdn.example.test/a.png', previewUrl: 'https://cdn.example.test/a-720.webp', mediaKind: 'image',
      contentType: 'image/png', originalName: null, width: 900, height: 1600, durationSeconds: null, sortOrder: 0,
    }],
    saveCount: 1,
    remixCount: 0,
    commentCount: 4,
    createdAt: '2026-11-12T10:00:00.000Z',
    creator: { id: 'u1', username: 'batman', name: 'Sassy23b', avatar: null },
    sourceKind: 'generation',
    generationId: 'g1',
    asset: null,
    canRemix: false,
    ...overrides,
  } as ShowcaseFeedItem;
}

describe('search post card', () => {
  it('names the creator by handle, says what it was made with, and dates it', () => {
    const facts = searchPostCardFacts(item());
    expect(facts.creatorName).toBe('@batman');
    expect(facts.madeWith).toBeTruthy();
    expect(facts.date).toBe('Nov 12');
    expect(facts.video).toBe(false);
    render(<SearchPostCard item={item()} returnTo="/search?q=nano" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toBe(`Open post Mahabali by @batman, made with ${facts.madeWith}, Nov 12, 1 save, 4 comments`);
    expect(screen.getByText('@batman')).toBeTruthy();
    expect(screen.queryByText('Sassy23b')).toBeNull();
    expect(screen.getByText(`Made with ${facts.madeWith}`)).toBeTruthy();
    expect(link.getAttribute('href')).toContain('/showcase/post-1');
  });

  it('keeps the picture at its own shape, within a strip’s bounds, and Explore’s for one of unknown size', () => {
    expect(searchPostCoverRatio(item())).toBeCloseTo(9 / 16);
    const square = item({ mediaItems: [{ ...item().mediaItems![0], width: 1000, height: 1000 }] });
    expect(searchPostCoverRatio(square)).toBe(1);
    const strip = item({ mediaItems: [{ ...item().mediaItems![0], width: 4000, height: 500 }] });
    expect(searchPostCoverRatio(strip)).toBeCloseTo(16 / 9);
    const unknown = item({ mediaItems: [{ ...item().mediaItems![0], width: null, height: null }] });
    expect(searchPostCoverRatio(unknown)).toBeCloseTo(4 / 5);
    // The frame's drawn shape is held in a browser (jsdom drops aspect-ratio): public-search.spec.ts.
  });

  it('marks a clip, and draws the recipe’s badge and Remixable, all said in its name', () => {
    const clip = item({
      mediaKind: 'video',
      mediaItems: [{ ...item().mediaItems![0], mediaKind: 'video', previewUrl: 'https://cdn.example.test/poster.webp' }],
      asset: { id: 'a1', postId: 'post-1', title: 'Recipe', accessMode: 'free', priceUsdCents: 0 } as ShowcaseFeedItem['asset'],
      canRemix: true,
      model: 'manual',
      sourceTool: 'Midjourney',
    });
    render(<SearchPostCard item={clip} returnTo="/search" />);
    const label = screen.getByRole('link').getAttribute('aria-label');
    expect(label).toBe('Open post Mahabali by @batman, video, made with Midjourney, Free recipe, Remixable, Nov 12, 1 save, 4 comments');
    expect(screen.getByText('Free recipe')).toBeTruthy();
    expect(screen.getByText('Remixable')).toBeTruthy();
    // Every word the card shows is in its name.
    const link = screen.getByRole('link');
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('[aria-hidden="true"]')) continue;
      const text = node.textContent?.trim().toLowerCase();
      if (text) expect(label?.toLowerCase()).toContain(text);
    }
  });

  it('says "Your recipe" on the viewer’s own priced recipe, as Explore does', () => {
    const own = item({ asset: { id: 'a1', postId: 'post-1', title: 'Recipe', accessMode: 'paid', priceUsdCents: 250 } as ShowcaseFeedItem['asset'] });
    expect(searchPostCardFacts(own, 'u1').badges).toEqual(['Your recipe']);
    expect(searchPostCardFacts(own, 'someone-else').badges).not.toContain('Your recipe');
    expect(searchPostCardFacts(own).badges).not.toContain('Your recipe');
  });

  it('says nothing was made with anything for a text post, and does not repeat its title', () => {
    const text = item({ postFormat: 'text', category: 'text', mediaKind: null, mediaUrl: null, mediaItems: [], body: 'A note on light' });
    expect(searchPostCardFacts(text).madeWith).toBeNull();
    render(<SearchPostCard item={text} returnTo="/search" />);
    expect(screen.getAllByText('Mahabali')).toHaveLength(1);
    expect(screen.getByText('A note on light')).toBeTruthy();
  });

  it('names a creator with no handle by name', () => {
    expect(searchPostCardFacts(item({ creator: { id: null, username: null, name: 'Luna', avatar: null } })).creatorName).toBe('Luna');
  });
});

describe('search post wall', () => {
  it('is two across at a phone’s width, three and four as it widens', () => {
    expect(searchPostWallColumns(358)).toBe(2);
    expect(searchPostWallColumns(599)).toBe(2);
    expect(searchPostWallColumns(600)).toBe(3);
    expect(searchPostWallColumns(900)).toBe(4);
  });

  it('places each card in the shortest column, in order, and never moves one placed before', () => {
    // 358 px: two columns of 173 px with a 12 px gap.
    const first = placeSearchPostWall([300, 200, 150, 100], 358);
    expect(first.placed.map((at) => [at.x, at.y])).toEqual([[0, 0], [185, 0], [185, 212], [0, 312]]);
    expect(first.placed[0].width).toBe(173);
    expect(first.height).toBe(412);
    // "Show more" adds cards: the ones on screen stay where they were.
    const more = placeSearchPostWall([300, 200, 150, 100, 80, 90], 358);
    expect(more.placed.slice(0, 4)).toEqual(first.placed);
    expect(placeSearchPostWall([], 358)).toEqual({ placed: [], height: 0 });
  });

  it('keeps the ranked order in the document, for the Tab key and a screen reader', () => {
    const items = ['a', 'b', 'c'].map((id) => item({ id, title: `Post ${id}` }));
    render(<SearchPostWall items={items} returnTo="/search" />);
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href')?.split('?')[0])).toEqual(['/showcase/a', '/showcase/b', '/showcase/c']);
  });
});
