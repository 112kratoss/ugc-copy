import { describe, expect, it } from 'vitest';

import { orderStartPosts, startPostRemix, type CreatorStartPost, type StartPostRemixForecast } from '@/lib/creator-start-posts';

/**
 * "Start from a post" (owner, 2026-10-28): each card's Remix is priced as the remix the page
 * will open, fitted to the balance by the page's own rule (Seedance 2 Mini first), from runs
 * the server priced ahead. These hold the card to that rule's answers.
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

const NAMES = { 'seedance-2-mini': 'Seedance 2 Mini', 'grok-imagine-video-1.5': 'Grok Imagine Video 1.5', 'kling-3.0-video': 'Kling 3.0 Cinematic' };

function forecast(overrides: Partial<StartPostRemixForecast> = {}): StartPostRemixForecast {
  return {
    original: { modelId: 'kling-3.0-video', cost: 42, durationSeconds: 5 },
    candidates: [
      { modelId: 'grok-imagine-video-1.5', cost: 12, durationSeconds: 5, takesInputs: true },
      { modelId: 'seedance-2-mini', cost: 19, durationSeconds: 5, takesInputs: true },
    ],
    shorter: { modelId: 'grok-imagine-video-1.5', prices: [{ durationSeconds: 4, cost: 10 }] },
    preferredModelId: 'seedance-2-mini',
    modelNames: NAMES,
    ...overrides,
  };
}

describe('the remix a start post offers', () => {
  it('keeps the shelf\'s own price where nothing was forecast (an image, a motion, an unreadable run)', () => {
    expect(startPostRemix(post({ tool: 'image', price: { kind: 'credits', credits: 8 } }), 25)).toEqual({ cost: 8, fitted: null });
    expect(startPostRemix(post({ price: { kind: 'clip-length' } }), 25)).toEqual({ cost: null, fitted: null });
    expect(startPostRemix(post({ price: null }), 25)).toEqual({ cost: null, fitted: null });
  });

  it('opens on the original while the balance covers it, and without a balance', () => {
    expect(startPostRemix(post({ remix: forecast() }), 50)).toEqual({ cost: 42, fitted: null });
    expect(startPostRemix(post({ remix: forecast() }), null)).toEqual({ cost: 42, fitted: null });
  });

  // Owner, 2026-10-28: "Seedance 2 Mini first": Mini whenever it takes the post's inputs and
  // fits the balance, though Grok Imagine Video 1.5 costs less.
  it('fits a remix the balance is short of to Seedance 2 Mini first', () => {
    expect(startPostRemix(post({ remix: forecast() }), 25)).toEqual({
      cost: 19,
      fitted: { modelId: 'seedance-2-mini', modelName: 'Seedance 2 Mini', durationSeconds: 5, sameLength: true },
    });
  });

  it('fits it to the cheapest model that takes it where Mini does not fit or cannot take it', () => {
    const grok = { cost: 12, fitted: { modelId: 'grok-imagine-video-1.5', modelName: 'Grok Imagine Video 1.5', durationSeconds: 5, sameLength: true } };
    expect(startPostRemix(post({ remix: forecast() }), 15)).toEqual(grok);
    const noSound = forecast({
      candidates: [
        { modelId: 'grok-imagine-video-1.5', cost: 12, durationSeconds: 5, takesInputs: true },
        { modelId: 'seedance-2-mini', cost: 19, durationSeconds: 5, takesInputs: false },
      ],
    });
    expect(startPostRemix(post({ remix: noSound }), 25)).toEqual(grok);
  });

  // The artboard Main's "Trending": a 12s original; Mini at 12s is past the balance, at 5s it fits.
  it('shortens the cheapest model\'s run to the longest length the balance covers', () => {
    const twelveSeconds = forecast({
      original: { modelId: 'seedance-2', cost: 160, durationSeconds: 12 },
      candidates: [{ modelId: 'seedance-2-mini', cost: 46, durationSeconds: 12, takesInputs: true }],
      shorter: { modelId: 'seedance-2-mini', prices: [{ durationSeconds: 4, cost: 16 }, { durationSeconds: 5, cost: 19 }, { durationSeconds: 6, cost: 23 }] },
    });
    expect(startPostRemix(post({ remix: twelveSeconds }), 22)).toEqual({
      cost: 19,
      fitted: { modelId: 'seedance-2-mini', modelName: 'Seedance 2 Mini', durationSeconds: 5, sameLength: false },
    });
  });

  it('opens on the original where no model fits at any length', () => {
    expect(startPostRemix(post({ remix: forecast() }), 5)).toEqual({ cost: 42, fitted: null });
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
