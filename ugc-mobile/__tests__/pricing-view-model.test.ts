import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOBILE_PRICING_PLAN_ID,
  formatPricingDisplayPrice,
  getPricingPlanCarouselOffset,
  getPricingPlanIdForCarouselOffset,
  getPurchaseButtonLabel,
  resolvePurchaseGate,
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

describe('guest purchase gate (App Review 5.1.1(v))', () => {
  it('lets a guest buy credits without registering', () => {
    // The rejection, expressed as an assertion. Apple rejected 0.0.5 (28)
    // because the app required registration before an In-App Purchase that is
    // not account-based. If this ever goes false, the rejection comes back.
    const gate = resolvePurchaseGate({ identityUserId: 'guest-1', isGuest: true });

    expect(gate.canPurchase).toBe(true);
    expect(gate.blockedReason).toBeNull();
  });

  it('offers registration to a guest without requiring it', () => {
    // Guideline 5.1.1(v) in as many words: "You may explain to the user that
    // registering will enable them to access the purchased content from any of
    // their supported devices". Offered alongside a live buy button, never
    // in place of one.
    const gate = resolvePurchaseGate({ identityUserId: 'guest-1', isGuest: true });

    expect(gate.showRegistrationOffer).toBe(true);
    expect(gate.canPurchase).toBe(true);
  });

  it('does not pester a registered user to register', () => {
    const gate = resolvePurchaseGate({ identityUserId: 'user-1', isGuest: false });

    expect(gate.canPurchase).toBe(true);
    expect(gate.showRegistrationOffer).toBe(false);
  });

  it('blocks on a missing identity without demanding sign-up', () => {
    // No identity means the guest bootstrap has not landed — first launch,
    // offline, or anonymous sign-ins disabled server-side. That is a retryable
    // state, not a reason to ask for an account.
    const gate = resolvePurchaseGate({ identityUserId: null, isGuest: false });

    expect(gate.canPurchase).toBe(false);
    expect(gate.blockedReason).toBe('no_identity');
    expect(gate.showRegistrationOffer).toBe(false);
  });
});

describe('device payment restrictions (HIG In-app purchase)', () => {
  it('hides the store behind an explanation when the device cannot make payments', () => {
    // "Display store only when people can make payments. Hide store or display
    // explanatory UI if parental restrictions prevent payment." A confirmed
    // canMakePayments() no is Screen Time or a device policy, and registration
    // must never be pitched as the way around it.
    const gate = resolvePurchaseGate({ identityUserId: 'user-1', isGuest: false, paymentsAllowed: false });

    expect(gate.canPurchase).toBe(false);
    expect(gate.blockedReason).toBe('payments_restricted');
    expect(gate.showRegistrationOffer).toBe(false);
  });

  it('reports the restriction even while the identity bootstrap is pending', () => {
    // The restriction is the harder fact: a retry cannot lift it, so it wins
    // over the retryable no_identity state.
    const gate = resolvePurchaseGate({ identityUserId: null, isGuest: false, paymentsAllowed: false });

    expect(gate.blockedReason).toBe('payments_restricted');
  });

  it('defaults to an open store when the check has not answered', () => {
    // canDeviceMakePayments fails open: an errored or pending check is
    // "unknown", and unknown must never hide the store.
    const gate = resolvePurchaseGate({ identityUserId: 'user-1', isGuest: false });

    expect(gate.canPurchase).toBe(true);
    expect(gate.blockedReason).toBeNull();
  });
});
