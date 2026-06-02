import { describe, expect, it } from 'vitest';

import {
  getShowcasePostDisplayText,
  isTextOnlyShowcasePost,
  selectActiveShowcaseVideoId,
  selectActiveShowcaseVideoIds,
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
});
