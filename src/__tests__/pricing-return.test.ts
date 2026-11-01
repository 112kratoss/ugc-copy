import { describe, expect, it } from 'vitest';

import { buildRecipeTopUpHref, resolvePricingReturnTo } from '@/app/showcase/recipe-reading';
import { buildPricingHref, buildRemixTopUpHref, pricingReturnLabel } from '@/lib/pricing-return';
import type { RemixTool } from '@/lib/remix-tools';

const REMIX_TOOLS: readonly RemixTool[] = ['image', 'video', 'motion'];

/** The way back Pricing reads from a top-up's address: its `returnTo`, decoded once, as the page reads it. */
function returnToOf(href: string): string {
  const url = new URL(href, 'https://magicbooklet.com');
  expect(url.pathname).toBe('/pricing');
  const returnTo = resolvePricingReturnTo(url.searchParams.get('returnTo'));
  expect(returnTo).not.toBeNull();
  return returnTo!;
}

// A remix's form is never saved as a draft, so a creator who left a short remix for Pricing
// had nothing to come back to (2026-11-02): its top-ups tell Pricing the remix.
describe('the way back from a remix\'s top-up', () => {
  it('sends Pricing the remix\'s own address, in the creator the remix opens in', () => {
    expect(buildRemixTopUpHref('video', 'gen-1', 'post-1'))
      .toBe(`/pricing?returnTo=${encodeURIComponent('/create-video?remix=gen-1&remixPost=post-1')}`);
    expect(returnToOf(buildRemixTopUpHref('image', 'gen-1', null))).toBe('/create-image?remix=gen-1');
    expect(returnToOf(buildRemixTopUpHref('motion', 'gen-1', 'post-1'))).toBe('/create-motion?remix=gen-1&remixPost=post-1');
  });

  // The ids come from the page's address, so whatever they hold stays inside their own values.
  it('keeps each id whole, whatever it holds', () => {
    const back = returnToOf(buildRemixTopUpHref('video', 'gen 1&remixPost=x#recipe', 'post/1?'));
    const remix = new URL(back, 'https://magicbooklet.com');
    expect(remix.pathname).toBe('/create-video');
    expect(remix.hash).toBe('');
    expect([...remix.searchParams]).toEqual([['remix', 'gen 1&remixPost=x#recipe'], ['remixPost', 'post/1?']]);
    expect(pricingReturnLabel(back)).toBe('Back to your remix');
  });

  it('is the same Pricing address a recipe\'s top-up uses', () => {
    expect(buildPricingHref('/create-video?remix=gen-1')).toBe(`/pricing?returnTo=${encodeURIComponent('/create-video?remix=gen-1')}`);
    expect(buildRecipeTopUpHref('/showcase/post-1')).toBe(buildPricingHref('/showcase/post-1#recipe'));
  });
});

describe('Pricing\'s words for the way back', () => {
  it('names a recipe and a remix by what they are', () => {
    expect(pricingReturnLabel(returnToOf(buildRecipeTopUpHref('/showcase/post-1?from=home')))).toBe('Back to the recipe');
    for (const tool of REMIX_TOOLS) {
      expect(pricingReturnLabel(returnToOf(buildRemixTopUpHref(tool, 'gen-1', 'post-1')))).toBe('Back to your remix');
    }
  });

  it('names any other page plainly', () => {
    // A creator off a remix, a remix with no id, the hub, a post without its recipe's anchor.
    for (const page of ['/create-video', '/create-video?prompt=remix', '/create-video?remix=', '/create?remix=gen-1', '/showcase/post-1#comments', '/credits']) {
      expect(pricingReturnLabel(page)).toBe('Go back');
    }
  });
});
