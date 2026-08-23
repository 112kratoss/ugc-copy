import { describe, expect, it } from 'vitest';

import { pickHomeSlidePreviews, type HomeFeedCard } from '../lib/home-feed-view-model';

function card(overrides: Partial<HomeFeedCard>): HomeFeedCard {
  return {
    accent: 'image',
    previewUrl: null,
    mediaUrl: null,
    mediaKind: null,
    ...overrides,
  } as HomeFeedCard;
}

describe('pickHomeSlidePreviews', () => {
  it('keeps the newest preview per tool, in feed order', () => {
    const previews = pickHomeSlidePreviews([
      card({ accent: 'image', previewUrl: 'image-new.jpg' }),
      card({ accent: 'video', previewUrl: 'video-new.jpg', mediaKind: 'video' }),
      card({ accent: 'image', previewUrl: 'image-old.jpg' }),
    ]);

    expect(previews).toEqual({ image: 'image-new.jpg', video: 'video-new.jpg' });
  });

  it('falls back to the media url for images but never to a raw video file', () => {
    expect(pickHomeSlidePreviews([card({ accent: 'image', mediaUrl: 'still.jpg', mediaKind: 'image' })])).toEqual({ image: 'still.jpg' });
    expect(pickHomeSlidePreviews([card({ accent: 'video', mediaUrl: 'clip.mp4', mediaKind: 'video' })])).toEqual({});
  });

  it('skips cards with nothing to show', () => {
    expect(pickHomeSlidePreviews([card({ accent: 'motion' }), card({ accent: 'image', previewUrl: '' })])).toEqual({});
  });
});
