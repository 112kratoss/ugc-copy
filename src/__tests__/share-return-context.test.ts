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
      label: 'Back to unlocked recipes',
    });
  });

  it('falls back to the library when the link lost its returnTo', () => {
    expect(getShowcaseReturnContext({ from: 'library' })).toEqual({
      source: 'library',
      href: '/creations?view=unlocks',
      label: 'Back to unlocked recipes',
    });
  });

  // The composer leaves for a post published from a run with the run as its way back.
  it('names a template run and goes back to it', () => {
    expect(getShowcaseReturnContext({ returnTo: '/template-runs/run-1' })).toEqual({
      source: 'template-run',
      href: '/template-runs/run-1',
      label: 'Back to Template Run',
    });
    expect(getShowcaseReturnContext({ from: 'template-run' })).toMatchObject({ href: '/templates' });
  });

  it('names Studio for a post published from it', () => {
    expect(buildShowcaseDetailPath('post-1', { returnTo: '/creations' })).toBe('/showcase/post-1?returnTo=%2Fcreations');
    expect(getShowcaseReturnContext({ returnTo: '/creations' })).toMatchObject({ label: 'Back to My Studio' });
  });

  it("leaves the marketplace's own unlocks source as it was", () => {
    expect(getShowcaseReturnContext({ from: 'unlocks' })).toEqual({
      source: 'unlocks',
      href: '/marketplace',
      label: 'Back to Marketplace',
    });
  });
});
