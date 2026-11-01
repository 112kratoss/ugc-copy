import { describe, expect, it } from 'vitest';

import { buildRecipeTopUpHref, resolvePricingReturnTo } from '@/app/showcase/recipe-reading';
import { buildRemixTopUpHref, pricingReturnLabel } from '@/lib/pricing-return';

/** The way back Pricing reads from a top-up's address: its `returnTo`, decoded once, as the page reads it. */
function returnToOf(href: string): string | null {
  const url = new URL(href, 'https://magicbooklet.com');
  expect(url.pathname).toBe('/pricing');
  return resolvePricingReturnTo(url.searchParams.get('returnTo'));
}

// A remix's form is never saved as a draft, so a creator who left a short remix for Pricing
// had nothing to come back to (2026-11-02): its Top up tells Pricing the remix.
describe('the way back from a remix\'s top-up', () => {
  it('sends Pricing the remix\'s own address', () => {
    expect(buildRemixTopUpHref('/create-video', 'gen-1', 'post-1'))
      .toBe(`/pricing?returnTo=${encodeURIComponent('/create-video?remix=gen-1&remixPost=post-1')}`);
    expect(returnToOf(buildRemixTopUpHref('/create-image', 'gen-1', null))).toBe('/create-image?remix=gen-1');
    expect(returnToOf(buildRemixTopUpHref('/create-motion', 'gen-1', 'post-1'))).toBe('/create-motion?remix=gen-1&remixPost=post-1');
  });

  // The ids come from the page's address, so whatever they hold stays inside their own values.
  it('keeps each id whole, whatever it holds', () => {
    const back = returnToOf(buildRemixTopUpHref('/create-video', 'gen 1&remixPost=x#recipe', 'post/1?'));
    const remix = new URL(back!, 'https://magicbooklet.com');
    expect(remix.pathname).toBe('/create-video');
    expect(remix.hash).toBe('');
    expect([...remix.searchParams]).toEqual([['remix', 'gen 1&remixPost=x#recipe'], ['remixPost', 'post/1?']]);
    expect(pricingReturnLabel(back!)).toBe('Back to your remix');
  });
});

describe('Pricing\'s words for the way back', () => {
  it('names a recipe and a remix by what they are', () => {
    expect(pricingReturnLabel(returnToOf(buildRecipeTopUpHref('/showcase/post-1?from=home'))!)).toBe('Back to the recipe');
    for (const creator of ['/create-image', '/create-video', '/create-motion'] as const) {
      expect(pricingReturnLabel(returnToOf(buildRemixTopUpHref(creator, 'gen-1', 'post-1'))!)).toBe('Back to your remix');
    }
  });

  it('names any other page plainly', () => {
    // A creator off a remix, a remix with no id, another tool's remix, a post without its recipe's anchor.
    for (const page of ['/create-video', '/create-video?prompt=remix', '/create-video?remix=', '/create?remix=gen-1', '/showcase/post-1#comments', '/credits']) {
      expect(pricingReturnLabel(page)).toBe('Go back');
    }
  });
});
