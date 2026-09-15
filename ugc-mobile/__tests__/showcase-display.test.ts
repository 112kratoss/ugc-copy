import { describe, expect, it } from 'vitest';

import {
  getShowcasePostDisplayText,
  isTextOnlyShowcasePost,
  selectActiveShowcaseVideoId,
  selectActiveShowcaseVideoIds,
  selectPreparedShowcaseVideoIds,
} from '../lib/showcase-display';
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
    commentCount: 0,
    createdAt: '2026-05-13T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

describe('showcase display helpers', () => {
  it('detects text-only posts only when there is no media URL', () => {
    expect(isTextOnlyShowcasePost(item({ category: 'text', postFormat: 'text', mediaUrl: null }))).toBe(true);
    expect(isTextOnlyShowcasePost(item({ category: 'image', postFormat: 'text', mediaUrl: null }))).toBe(true);
    expect(isTextOnlyShowcasePost(item({ category: 'text', postFormat: 'text', mediaUrl: 'https://cdn.example.com/post.png' }))).toBe(false);
    expect(isTextOnlyShowcasePost(item({ category: 'image', postFormat: 'media', mediaUrl: null }))).toBe(false);
  });

  it('chooses text post display content from body, prompt, then title', () => {
    expect(getShowcasePostDisplayText(item({ body: '  Body copy  ', prompt: 'Prompt', title: 'Title' }))).toBe('Body copy');
    expect(getShowcasePostDisplayText(item({ body: '', prompt: '  Prompt copy  ', title: 'Title' }))).toBe('Prompt copy');
    expect(getShowcasePostDisplayText(item({ body: '', prompt: '', title: '  Title copy  ' }))).toBe('Title copy');
    expect(getShowcasePostDisplayText(item({ body: '', prompt: '', title: '' }))).toBe('Community post');
  });

  it('selects only the first visible video with a usable media URL', () => {
    const visibleItems = [
      item({ id: 'image-post', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/image.png' }),
      item({ id: 'video-without-url', category: 'video', mediaKind: 'video', mediaUrl: null }),
      item({ id: 'first-video', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-1.mp4' }),
      item({ id: 'second-video', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-2.mp4' }),
    ];

    expect(selectActiveShowcaseVideoId(visibleItems)).toBe('first-video');
  });

  it('selects a capped set of visible videos for feed previews', () => {
    const visibleItems = [
      item({ id: 'image-post', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/image.png' }),
      item({ id: 'video-without-url', category: 'video', mediaKind: 'video', mediaUrl: null }),
      item({ id: 'first-video', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-1.mp4' }),
      item({ id: 'second-video', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-2.mp4' }),
      item({ id: 'third-video', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-3.mp4' }),
      item({ id: 'fourth-video', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-4.mp4' }),
    ];

    expect(selectActiveShowcaseVideoIds(visibleItems, 3)).toEqual([
      'first-video',
      'second-video',
      'third-video',
    ]);
  });

  it('holds a playing video that is still visible, even below a newer one', () => {
    const visibleItems = [
      item({ id: 'entering-at-top', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-1.mp4' }),
      item({ id: 'already-playing', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-2.mp4' }),
    ];

    // Position alone would promote the card sliding in at the top edge.
    expect(selectActiveShowcaseVideoIds(visibleItems, 1, ['already-playing'])).toEqual(['already-playing']);
  });

  it('promotes by position once the held video is no longer visible', () => {
    const visibleItems = [
      item({ id: 'next-video', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/video-1.mp4' }),
    ];

    expect(selectActiveShowcaseVideoIds(visibleItems, 1, ['scrolled-away'])).toEqual(['next-video']);
  });

  it('fills the slots left over by held videos', () => {
    const visibleItems = [
      item({ id: 'a', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/a.mp4' }),
      item({ id: 'b', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/b.mp4' }),
      item({ id: 'c', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/c.mp4' }),
    ];

    // 'c' is held; 'a' fills the remaining slot, and nothing is duplicated.
    expect(selectActiveShowcaseVideoIds(visibleItems, 2, ['c'])).toEqual(['c', 'a']);
  });

  it('does not select an active video when no visible item can preview', () => {
    expect(
      selectActiveShowcaseVideoId([
        item({ id: 'image-post', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/image.png' }),
        item({ id: 'video-without-url', category: 'video', mediaKind: 'video', mediaUrl: null }),
      ])
    ).toBeNull();
    expect(
      selectActiveShowcaseVideoIds([
        item({ id: 'image-post', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/image.png' }),
        item({ id: 'video-without-url', category: 'video', mediaKind: 'video', mediaUrl: null }),
      ])
    ).toEqual([]);
  });

  it('keeps the nearest video after and before the playing one ready', () => {
    const feed = [
      item({ id: 'video-far-above', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/far-above.mp4' }),
      item({ id: 'video-above', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/above.mp4' }),
      item({ id: 'image-above', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/above.png' }),
      item({ id: 'video-playing', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/playing.mp4' }),
      item({ id: 'image-below', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/below.png' }),
      item({ id: 'text-below', category: 'text', postFormat: 'text', mediaUrl: null }),
      item({ id: 'video-below', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/below.mp4' }),
      item({ id: 'video-far-below', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/far-below.mp4' }),
    ];

    // The playing video is not prepared again, and nothing past the nearest
    // video in either direction is held.
    expect(selectPreparedShowcaseVideoIds(feed, {
      viewableIds: ['video-playing', 'image-below'],
      anchorIds: ['video-playing'],
      activeIds: ['video-playing'],
    })).toEqual(['video-below', 'video-above']);
  });

  it('carries the destination player through the middle of a scroll back', () => {
    // The Home order the emulator scrolled: a scroll up from the boat to the cats.
    const feed = [
      item({ id: 'video-top', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/top.mp4' }),
      item({ id: 'image-between', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/between.png' }),
      item({ id: 'video-cats', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/cats.mp4' }),
      item({ id: 'video-boat', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/boat.mp4' }),
      item({ id: 'image-test', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/test.png' }),
      item({ id: 'video-dance', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/dance.mp4' }),
    ];
    const boatReport = { viewableIds: ['video-boat', 'image-test'], anchorIds: ['video-boat'] };

    expect(selectPreparedShowcaseVideoIds(feed, { ...boatReport, activeIds: ['video-boat'] }))
      .toEqual(['video-dance', 'video-cats']);
    // Mid-scroll nothing qualifies and playback stops, but the report is kept:
    // the boat holds its frame and the cats stay loaded for the arrival.
    expect(selectPreparedShowcaseVideoIds(feed, { ...boatReport, activeIds: [] }))
      .toEqual(['video-boat', 'video-dance', 'video-cats']);
    // Arriving, the cats play on the player they already had.
    expect(selectPreparedShowcaseVideoIds(feed, {
      viewableIds: ['video-cats'],
      anchorIds: ['video-cats'],
      activeIds: ['video-cats'],
    })).toEqual(['video-boat', 'video-top']);
  });

  it('keeps videos ready around image cards while nothing plays', () => {
    const feed = [
      item({ id: 'video-above', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/above.mp4' }),
      item({ id: 'image-a', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/a.png' }),
      item({ id: 'image-b', category: 'image', mediaKind: 'image', mediaUrl: 'https://cdn.example.com/b.png' }),
      item({ id: 'video-without-url', category: 'video', mediaKind: 'video', mediaUrl: null }),
      item({ id: 'video-below', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/below.mp4' }),
    ];

    // A video that cannot preview is skipped, so the next one below is held.
    expect(selectPreparedShowcaseVideoIds(feed, {
      viewableIds: ['image-a', 'image-b'],
      anchorIds: [],
      activeIds: [],
    })).toEqual(['video-below', 'video-above']);
  });

  it('holds only the neighbour ahead with a limit of one', () => {
    const feed = [
      item({ id: 'video-a', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/a.mp4' }),
      item({ id: 'video-b', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/b.mp4' }),
      item({ id: 'video-c', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/c.mp4' }),
    ];

    expect(selectPreparedShowcaseVideoIds(feed, {
      viewableIds: ['video-b'],
      anchorIds: ['video-b'],
      activeIds: ['video-b'],
    }, 1)).toEqual(['video-c']);
  });

  it('prepares nothing without a report from this feed or a free slot', () => {
    const feed = [
      item({ id: 'video-a', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/a.mp4' }),
      item({ id: 'video-b', category: 'video', mediaKind: 'video', mediaUrl: 'https://cdn.example.com/b.mp4' }),
    ];

    expect(selectPreparedShowcaseVideoIds(feed, { viewableIds: [], anchorIds: [], activeIds: [] })).toEqual([]);
    expect(selectPreparedShowcaseVideoIds(feed, {
      viewableIds: ['from-another-lane'],
      anchorIds: ['from-another-lane'],
      activeIds: [],
    })).toEqual([]);
    expect(selectPreparedShowcaseVideoIds(feed, {
      viewableIds: ['video-a'],
      anchorIds: ['video-a'],
      activeIds: ['video-a'],
    }, 0)).toEqual([]);
  });
});
