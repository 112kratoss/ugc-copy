import { describe, expect, it } from 'vitest';

import {
  buildShowcaseDetailPath,
  getShowcaseReturnContext,
  stripShowcaseViewerState,
} from '@/lib/share';

describe('showcase navigation', () => {
  it('builds canonical recipe links and removes transient reel state from return paths', () => {
    expect(buildShowcaseDetailPath('post-1', {
      from: 'profile',
      returnTo: '/profile?tab=saved&post=post-1&media=2',
      section: 'resources',
    })).toBe('/showcase/post-1?from=profile&returnTo=%2Fprofile%3Ftab%3Dsaved#recipe');
  });

  it('preserves useful filters and hashes while removing reel-only parameters', () => {
    expect(stripShowcaseViewerState('/showcase?category=video&post=post-1&media=2#top'))
      .toBe('/showcase?category=video#top');
  });

  it('returns profile details to the owner media hub without reopening the reel', () => {
    expect(getShowcaseReturnContext({
      from: 'profile',
      returnTo: '/profile?tab=posts&post=post-1',
    })).toEqual({
      source: 'profile',
      href: '/profile?tab=posts',
      label: 'Back to Your Profile',
    });
  });

  it('rejects external return destinations', () => {
    expect(getShowcaseReturnContext({ returnTo: '//evil.example/path' })).toEqual({
      source: 'community',
      href: '/showcase',
      label: 'Back to Community',
    });
  });
});
