import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOBILE_PRICING_PLAN_ID,
  formatPricingDisplayPrice,
  getPricingPlanCarouselOffset,
  getPricingPlanIdForCarouselOffset,
  getPurchaseButtonLabel,
  resolveSelectedPricingPlan,
} from '../lib/pricing-view-model';

describe('mobile pricing selection', () => {
  it('selects the popular Creator pack by default', () => {
    expect(DEFAULT_MOBILE_PRICING_PLAN_ID).toBe('creator');
  });

  it('resolves a selected plan and falls back to Creator', () => {
    expect(resolveSelectedPricingPlan('pro').id).toBe('pro');
    expect(resolveSelectedPricingPlan('missing' as never).id).toBe('creator');
  });

  it('prefers a native store price and does not steer to web pricing otherwise', () => {
    const plan = resolveSelectedPricingPlan('creator');

    expect(formatPricingDisplayPrice(plan, '₹1,799')).toBe('₹1,799');
    expect(formatPricingDisplayPrice(plan, null)).toBe('Store price unavailable');
  });

  it('builds concise purchase button states', () => {
    const plan = resolveSelectedPricingPlan('creator');

    expect(getPurchaseButtonLabel({ plan, price: '₹1,799' })).toBe('Buy 2,000 credits - ₹1,799');
    expect(getPurchaseButtonLabel({ plan, price: '₹1,799', loading: true })).toBe('Loading store price...');
    expect(getPurchaseButtonLabel({ plan, price: '₹1,799', processing: true })).toBe('Processing purchase...');
  });

  it('maps carousel positions to the nearest credit pack', () => {
    expect(getPricingPlanIdForCarouselOffset(0, 280)).toBe('starter');
    expect(getPricingPlanIdForCarouselOffset(280, 280)).toBe('creator');
    expect(getPricingPlanIdForCarouselOffset(560, 280)).toBe('pro');
    expect(getPricingPlanIdForCarouselOffset(900, 280)).toBe('pro');
  });

  it('returns the snap offset for a selected credit pack', () => {
    expect(getPricingPlanCarouselOffset('starter', 280)).toBe(0);
    expect(getPricingPlanCarouselOffset('creator', 280)).toBe(280);
    expect(getPricingPlanCarouselOffset('pro', 280)).toBe(560);
  });
});
