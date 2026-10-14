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

  // The answer is the rail's extraData: a new object re-renders every slide.
  it('hands back the same object while the picks stay the same', () => {
    const first = pickHomeSlidePreviews([card({ accent: 'image', previewUrl: 'image-new.jpg' })]);
    // A page landed with an older picture for the same tool: the pick holds.
    const again = pickHomeSlidePreviews([
      card({ accent: 'image', previewUrl: 'image-new.jpg' }),
      card({ accent: 'image', previewUrl: 'image-old.jpg' }),
    ]);

    expect(again).toBe(first);
  });

  it('gives a new object once a pick changes, appears or goes', () => {
    const first = pickHomeSlidePreviews([card({ accent: 'image', previewUrl: 'a.jpg' })]);
    const changed = pickHomeSlidePreviews([card({ accent: 'image', previewUrl: 'b.jpg' })]);
    const added = pickHomeSlidePreviews([
      card({ accent: 'image', previewUrl: 'b.jpg' }),
      card({ accent: 'video', previewUrl: 'v.jpg' }),
    ]);
    const swapped = pickHomeSlidePreviews([
      card({ accent: 'image', previewUrl: 'b.jpg' }),
      card({ accent: 'motion', previewUrl: 'v.jpg' }),
    ]);
    const gone = pickHomeSlidePreviews([card({ accent: 'image', previewUrl: 'b.jpg' })]);

    expect(changed).not.toBe(first);
    expect(changed).toEqual({ image: 'b.jpg' });
    expect(added).not.toBe(changed);
    expect(added).toEqual({ image: 'b.jpg', video: 'v.jpg' });
    expect(swapped).not.toBe(added);
    expect(swapped).toEqual({ image: 'b.jpg', motion: 'v.jpg' });
    expect(gone).not.toBe(swapped);
    expect(gone).toEqual({ image: 'b.jpg' });
  });
});
