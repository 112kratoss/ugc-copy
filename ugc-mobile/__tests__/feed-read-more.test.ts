import { describe, expect, it } from 'vitest';

import { feedReadMoreSection } from '../lib/feed-read-more';

describe('feedReadMoreSection', () => {
  it('opens Story when the card previews its public writing', () => {
    expect(feedReadMoreSection(' A short story\nfrom the post ', {
      body: 'A short story from the post', prompt: 'The original generation prompt',
    })).toBe('story');
  });

  it('opens the full prompt when the card previews a generation prompt', () => {
    expect(feedReadMoreSection('A long generation prompt', {
      body: 'A separate public story', prompt: 'A long generation prompt',
    })).toBe('prompt');
  });

  it('falls back to the available full text when the preview is transformed', () => {
    expect(feedReadMoreSection('Shortened preview…', { body: null, prompt: 'Full prompt' })).toBe('prompt');
  });
});
