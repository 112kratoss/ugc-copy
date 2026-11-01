import { describe, expect, it } from 'vitest';

import { orderStartPosts, startPostRemixCost, type CreatorStartPost } from '@/lib/creator-start-posts';

/**
 * "Start from a post" (owner, 2026-10-28): each card's Remix is priced as the remix the page
 * will open, from the run the server priced ahead. Since 2026-11-01 (owner) a remix opens on
 * its original's model and settings whatever the balance, so the price is that run's.
 */

function post(overrides: Partial<CreatorStartPost> = {}): CreatorStartPost {
  return {
    kind: 'creation',
    id: 'post-1',
    title: 'Kung fu cats',
    tool: 'video',
    posterUrl: 'https://cdn.example/poster.webp',
    posterThumbhash: null,
    clipUrl: 'https://cdn.example/clip.mp4',
    modelName: 'Kling 3.0 Cinematic',
    price: { kind: 'credits', credits: 42 },
    fitsWelcomeCredits: false,
    badge: null,
    creator: { id: 'creator-1', username: 'fluffy', name: 'Fluffy' },
    makeHref: '/create-video?remix=gen-1&remixPost=post-1',
    remix: null,
    ...overrides,
  };
}

describe('the remix a start post offers', () => {
  it('costs the run on the post\'s own model, as the server priced it', () => {
    expect(startPostRemixCost(post({ remix: { cost: 140 } }))).toBe(140);
  });

  it('keeps the shelf\'s own price where nothing was forecast (an image, a motion, an unreadable run)', () => {
    expect(startPostRemixCost(post({ tool: 'image', price: { kind: 'credits', credits: 8 } }))).toBe(8);
    expect(startPostRemixCost(post({ price: { kind: 'clip-length' } }))).toBeNull();
    expect(startPostRemixCost(post({ price: null }))).toBeNull();
  });
});

describe('the order of the start posts', () => {
  it('puts the creator\'s own tool first, then the rest, each in the shelf\'s order (owner, 2026-10-28)', () => {
    const shelf = [
      post({ id: 'image-1', tool: 'image' }),
      post({ id: 'video-1', tool: 'video' }),
      post({ id: 'image-2', tool: 'image' }),
      post({ id: 'video-2', tool: 'video' }),
    ];
    expect(orderStartPosts(shelf, 'video').map((item) => item.id)).toEqual(['video-1', 'video-2', 'image-1', 'image-2']);
    expect(orderStartPosts(shelf, 'image').map((item) => item.id)).toEqual(['image-1', 'image-2', 'video-1', 'video-2']);
    expect(orderStartPosts(shelf, 'motion').map((item) => item.id)).toEqual(['image-1', 'video-1', 'image-2', 'video-2']);
  });
});
