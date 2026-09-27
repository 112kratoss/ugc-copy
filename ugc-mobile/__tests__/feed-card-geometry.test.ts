import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FEED_CARD_BORDER_WIDTH, feedCardMediaWidth } from '../lib/feed-card-geometry';

const root = path.resolve(__dirname, '..');

describe('the media inside a feed card', () => {
  it('is as wide as the card less its border on both sides', () => {
    expect(feedCardMediaWidth(375)).toBe(375 - FEED_CARD_BORDER_WIDTH * 2);
  });

  it('is sized by that width in every card built on the shell', () => {
    // Sized to the card's own width, the media spilled 2dp past the card's
    // right edge, and a closing reel landed on a rectangle narrower than the
    // picture it uncovered: the picture grew as the reel let go.
    const cards = readdirSync(path.join(root, 'components'))
      .filter((name) => name.endsWith('.tsx'))
      .filter((name) => readFileSync(path.join(root, 'components', name), 'utf8').includes('<FeedCardShell'));

    expect(cards.sort()).toEqual(['home-feed-card.tsx', 'profile-feed-card.tsx']);
    for (const name of cards) {
      const source = readFileSync(path.join(root, 'components', name), 'utf8');
      expect(source, name).toContain('feedCardMediaWidth(contentWidth)');
      expect(source, name).not.toContain('width={contentWidth}');
    }
  });
});
