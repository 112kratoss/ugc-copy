import { afterEach, describe, expect, it, vi } from 'vitest';

import { onCreditTopUpOpen, openCreditTopUp, packCoveringNeed } from '@/lib/credit-top-up';
import { PRICING_PLANS } from '@/lib/pricing';

// A short balance is sold credits on the page (owner, 2026-11-02): whatever offers a top-up asks
// the page's sheet for it, and only a page without one goes to the pricing page.

describe('asking for the top-up sheet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reaches the sheet the page holds, with the run that needs credits, and goes nowhere', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, origin: 'http://localhost', assign });
    const opened: unknown[] = [];
    const stop = onCreditTopUpOpen((request) => opened.push(request));
    const toRemix = `/pricing?returnTo=${encodeURIComponent('/create-video?remix=gen-1&remixPost=post-1')}`;

    openCreditTopUp({ cost: 140, balance: 10 });
    openCreditTopUp();
    openCreditTopUp(null, toRemix);
    stop();

    expect(opened).toEqual([
      { need: { cost: 140, balance: 10 }, pricingHref: '/pricing' },
      { need: null, pricingHref: '/pricing' },
      { need: null, pricingHref: toRemix },
    ]);
    expect(assign).not.toHaveBeenCalled();
  });

  it('goes to the pricing page where the page holds no sheet', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, origin: 'http://localhost', assign });

    openCreditTopUp({ cost: 140, balance: 10 });
    // A remix's: Pricing, told the way back to it.
    openCreditTopUp(null, '/pricing?returnTo=%2Fcreate-video%3Fremix%3Dgen-1');

    expect(assign.mock.calls).toEqual([
      [new URL('http://localhost/pricing')],
      [new URL('http://localhost/pricing?returnTo=%2Fcreate-video%3Fremix%3Dgen-1')],
    ]);
  });
});

describe('the pack that covers a run', () => {
  const packs = [{ id: 'pro', credits: 10000 }, { id: 'starter', credits: 500 }, { id: 'creator', credits: 2000 }];

  it('is the smallest that brings the balance up to the run', () => {
    expect(packCoveringNeed(packs, { cost: 140, balance: 10 })?.id).toBe('starter');
    expect(packCoveringNeed(packs, { cost: 1200, balance: 10 })?.id).toBe('creator');
  });

  it('is none where no pack is enough, the balance covers the run, or there is no run', () => {
    expect(packCoveringNeed(packs, { cost: 20000, balance: 10 })).toBeNull();
    expect(packCoveringNeed(packs, { cost: 10, balance: 10 })).toBeNull();
    expect(packCoveringNeed(packs, null)).toBeNull();
  });

  it('is read from the packs the pricing page sells', () => {
    expect(packCoveringNeed(PRICING_PLANS, { cost: 19, balance: 3 })?.credits).toBe(Math.min(...PRICING_PLANS.map((plan) => plan.credits)));
  });
});
