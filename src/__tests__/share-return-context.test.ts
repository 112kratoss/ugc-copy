import { describe, expect, it } from 'vitest';

import { buildShowcaseDetailPath, getShowcaseReturnContext } from '@/lib/share';

describe('the way back from a post page opened from the unlock library', () => {
  it('carries the library source on the link to the post', () => {
    expect(buildShowcaseDetailPath('post-1', {
      from: 'library',
      returnTo: '/creations?view=unlocks',
      section: 'resources',
    })).toBe('/showcase/post-1?from=library&returnTo=%2Fcreations%3Fview%3Dunlocks#recipe');
  });

  it('names the library and goes back to it', () => {
    expect(getShowcaseReturnContext({ from: 'library', returnTo: '/creations?view=unlocks' })).toEqual({
      source: 'library',
      href: '/creations?view=unlocks',
      label: 'Back to your unlocks',
    });
  });

  it('falls back to the library when the link lost its returnTo', () => {
    expect(getShowcaseReturnContext({ from: 'library' })).toEqual({
      source: 'library',
      href: '/creations?view=unlocks',
      label: 'Back to your unlocks',
    });
  });

  it("leaves the marketplace's own unlocks source as it was", () => {
    expect(getShowcaseReturnContext({ from: 'unlocks' })).toEqual({
      source: 'unlocks',
      href: '/marketplace',
      label: 'Back to Marketplace',
    });
  });
});
