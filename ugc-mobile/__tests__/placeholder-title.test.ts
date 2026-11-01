import { describe, expect, it } from 'vitest';

import { isPlaceholderTitle } from '@/lib/placeholder-title';

// The names a post nobody named arrives with: the feed's "Untitled Creation" and
// "Untitled Note" (src/lib/showcase-feed.ts), the owner reads' "Untitled post"
// (src/lib/owner-post-title-fallback.ts) and the app's own "Community post".
describe('a placeholder title', () => {
  it.each(['Untitled Creation', 'Untitled Note', 'Untitled post', 'Untitled', 'Community post', '  UNTITLED   creation '])(
    '"%s" is one',
    (title) => {
      expect(isPlaceholderTitle(title)).toBe(true);
    },
  );

  it.each(['Kung fu cats', 'Untitled recipe for a summer drink', 'Untitled #4', '', '   '])('"%s" is not', (title) => {
    expect(isPlaceholderTitle(title)).toBe(false);
  });
});
