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

// Owner, 2026-11-15: "Back to Community" named a page the site no longer has (the menu calls it
// Explore), and links that never said where the post was opened from were given that name too.
describe('the way back names the page it goes back to', () => {
  it('calls Explore by its name, for its links and for its own address', () => {
    expect(getShowcaseReturnContext({ from: 'community', returnTo: '/showcase?category=video' })).toEqual({
      source: 'community',
      href: '/showcase?category=video',
      label: 'Back to Explore',
    });
    expect(getShowcaseReturnContext({ from: 'community' })).toEqual({
      source: 'community',
      href: '/showcase',
      label: 'Back to Explore',
    });
    expect(getShowcaseReturnContext({ returnTo: '/showcase?sort=new' })).toMatchObject({ label: 'Back to Explore' });
  });

  it('says only Back when the link named no page', () => {
    expect(getShowcaseReturnContext({})).toEqual({ source: 'unnamed', href: '/showcase', label: 'Back' });
    expect(getShowcaseReturnContext({ from: 'nowhere-we-know' })).toMatchObject({ source: 'unnamed', label: 'Back' });
  });

  it('says only Back for a page it cannot name, and still goes back there', () => {
    expect(getShowcaseReturnContext({ returnTo: '/notifications' })).toEqual({
      source: 'unnamed',
      href: '/notifications',
      label: 'Back',
    });
    // Another post is not Explore, though its address starts like it.
    expect(getShowcaseReturnContext({ returnTo: '/showcase/post-1?from=home&returnTo=%2F' })).toEqual({
      source: 'unnamed',
      href: '/showcase/post-1?from=home&returnTo=%2F',
      label: 'Back',
    });
  });

  it("names Home for Home's lanes as for Home itself", () => {
    expect(getShowcaseReturnContext({ returnTo: '/' })).toMatchObject({ source: 'home', label: 'Back to Home' });
    expect(getShowcaseReturnContext({ returnTo: '/?chip=notes' })).toEqual({
      source: 'home',
      href: '/?chip=notes',
      label: 'Back to Home',
    });
  });
});
