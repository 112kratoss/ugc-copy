import { describe, expect, it } from 'vitest';

import { isPlaceholderTitle, postName } from '@/lib/placeholder-title';

// The names a post nobody named arrives with: the feed's "Untitled Creation" and "Untitled
// Note" (src/lib/showcase-feed.ts) and the app's own "Community post". The web's feed mirrors
// this rule (src/lib/post-feed-presentation.ts `PLACEHOLDER_TITLE`) and tests the same cases.
describe('a placeholder title', () => {
  it.each(['Untitled Creation', 'Untitled Note', 'Untitled', 'Community post', '  untitled creation  '])('"%s" is one', (title) => {
    expect(isPlaceholderTitle(title)).toBe(true);
  });

  it.each(['Rooftop sparring', 'Untitled recipe for a summer drink', 'Untitled #4', '', '   '])('"%s" is not', (title) => {
    expect(isPlaceholderTitle(title)).toBe(false);
  });
});

describe("a post's name", () => {
  it('is the first of its words that is no placeholder', () => {
    expect(postName(['Rooftop sparring', 'Two cats sparring'], 'video')).toBe('Rooftop sparring');
    expect(postName(['Untitled Creation', '  ', 'Two cats sparring'], 'video')).toBe('Two cats sparring');
    expect(postName([null, undefined, 'Community post', 'Untitled Note'], 'image')).toBe('Image creation');
  });

  it('is the kind of creation when it has no words of its own', () => {
    expect(postName([], 'motion')).toBe('Motion creation');
    expect(postName(['Untitled'], 'video')).toBe('Video creation');
    expect(postName([''], 'text')).toBe('Creator note');
    expect(postName([], 'image')).toBe('Image creation');
  });
});
