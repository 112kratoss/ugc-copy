import { describe, expect, it } from 'vitest';

import {
  CHARGED_PURCHASE_LANDED_NOTICE,
  CHARGED_PURCHASE_NOT_LANDED_NOTICE,
  DEFAULT_MOBILE_PRICING_PLAN_ID,
  PAYMENT_PENDING_NOTICE,
  describeBalanceRefresh,
  describeRestoreOutcome,
  describeSkippedPurchases,
  formatPricingDisplayPrice,
  getPricingPlanCarouselOffset,
  getPricingPlanIdForCarouselOffset,
  getPurchaseButtonLabel,
  purchaseSyncedNotice,
  resolvePurchaseGate,
  resolveSelectedPricingPlan,
  restoreFailedNotice,
  restoreLandedPurchase,
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
    expect(formatPricingDisplayPrice('₹1,799')).toBe('₹1,799');
    expect(formatPricingDisplayPrice(' ')).toBe('Store price unavailable');
    expect(formatPricingDisplayPrice(null)).toBe('Store price unavailable');
  });

  it('builds concise purchase button states', () => {
    const plan = resolveSelectedPricingPlan('creator');

    expect(getPurchaseButtonLabel({ plan, price: '₹1,799' })).toBe('Buy 2,000 credits - ₹1,799');
    expect(getPurchaseButtonLabel({ plan, price: '₹1,799', loading: true })).toBe('Loading store price…');
    expect(getPurchaseButtonLabel({ plan, price: '₹1,799', processing: true })).toBe('Processing purchase…');
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

describe('what a purchase is called once the store has answered (03-3)', () => {
  it('calls a purchase the store is holding for approval pending, not failed', () => {
    expect(PAYMENT_PENDING_NOTICE).toEqual({
      tone: 'neutral',
      title: 'Purchase status',
      body: 'Payment pending — credits arrive when the store approves it.',
    });
  });

  it('names the credits the contract grants once a purchase is synced', () => {
    expect(purchaseSyncedNotice(2000)).toEqual({
      tone: 'success',
      title: 'Purchase updated',
      body: '2,000 credits are synced to your account.',
    });
  });

  it('claims a charged purchase landed only when the restore settled one or the balance moved', () => {
    expect(restoreLandedPurchase({ restoredCreditPurchases: 1, credits: 500 }, 500)).toBe(true);
    // The store's webhook credited it first: the restore finds it processed,
    // and the balance is past the one read before the purchase.
    expect(restoreLandedPurchase({ restoredCreditPurchases: 0, credits: 2500 }, 500)).toBe(true);
    expect(restoreLandedPurchase({ restoredCreditPurchases: 0, credits: 500 }, 500)).toBe(false);
    // An unknown starting balance cannot show a move.
    expect(restoreLandedPurchase({ restoredCreditPurchases: 0, credits: 2500 }, null)).toBe(false);
    // An older server sends neither field.
    expect(restoreLandedPurchase({}, 500)).toBe(false);
  });

  it('says the payment went through either way, and never that it failed', () => {
    expect(CHARGED_PURCHASE_LANDED_NOTICE.tone).toBe('success');
    expect(CHARGED_PURCHASE_NOT_LANDED_NOTICE.tone).toBe('neutral');
    expect(CHARGED_PURCHASE_NOT_LANDED_NOTICE.body).toContain('Your payment went through.');
    expect(CHARGED_PURCHASE_NOT_LANDED_NOTICE.body).toContain('You have not been charged twice.');
    // Reopening the screen re-reads nothing; the two buttons do.
    expect(CHARGED_PURCHASE_NOT_LANDED_NOTICE.body).not.toContain('reopen');
    expect(CHARGED_PURCHASE_NOT_LANDED_NOTICE.body).toContain('Refresh credit balance');
    expect(CHARGED_PURCHASE_NOT_LANDED_NOTICE.body).toContain('Restore purchases');
  });
});

describe('restore purchases (03-10)', () => {
  const conflict = (productId: string, transactionId = `tx-${productId}`) => ({
    transactionId,
    productId,
    reason: 'transaction_conflict' as const,
  });

  it('reports what the restore added', () => {
    expect(describeRestoreOutcome({ restoredCreditPurchases: 1, skipped: [] })).toEqual({
      tone: 'success',
      title: 'Purchases restored',
      body: '1 purchase was added to your balance.',
    });
    expect(describeRestoreOutcome({ restoredCreditPurchases: 2 }).body).toBe('2 purchases were added to your balance.');
  });

  it('says plainly when there was nothing to add', () => {
    expect(describeRestoreOutcome({ restoredCreditPurchases: 0, skipped: [] })).toEqual({
      tone: 'neutral',
      title: 'Nothing new to restore',
      body: 'Every purchase on this account is already in your balance.',
    });
  });

  it('names a conflicting purchase it skipped rather than failing the whole restore', () => {
    expect(describeSkippedPurchases([conflict('magicbooklet.credits.starter')]))
      .toBe('1 purchase (Starter) is already on file for another Magicbooklet account, so it was not added here.');
    expect(describeRestoreOutcome({
      restoredCreditPurchases: 0,
      skipped: [conflict('magicbooklet.credits.starter')],
    })).toEqual({
      tone: 'neutral',
      title: 'Nothing new to restore',
      body: '1 purchase (Starter) is already on file for another Magicbooklet account, so it was not added here.',
    });
    expect(describeRestoreOutcome({
      restoredCreditPurchases: 1,
      skipped: [
        conflict('magicbooklet.credits.creator', 'tx-1'),
        conflict('magicbooklet.credits.creator', 'tx-2'),
        conflict('magicbooklet.credits.unknown'),
      ],
    }).body).toBe('1 purchase was added to your balance. 3 purchases (Creator) are already on file for another '
      + 'Magicbooklet account, so they were not added here.');
    expect(describeSkippedPurchases([conflict('magicbooklet.credits.unknown')]))
      .toBe('1 purchase is already on file for another Magicbooklet account, so it was not added here.');
    expect(describeSkippedPurchases(undefined)).toBeNull();
    expect(describeSkippedPurchases([])).toBeNull();
  });

  it('says a restore that did not finish in its own words', () => {
    expect(restoreFailedNotice(new Error('Too many requests.'))).toEqual({
      tone: 'danger',
      title: 'Restore did not finish',
      body: 'Too many requests.',
    });
    expect(restoreFailedNotice('offline').body).toBe('Check your connection, then try again.');
  });
});

describe('refresh credit balance (03-10)', () => {
  const pressedAt = 1_000;

  it('reports a balance read since the press', () => {
    expect(describeBalanceRefresh({ status: 'success', dataUpdatedAt: 1_200, errorUpdatedAt: 0 }, pressedAt)).toEqual({
      tone: 'neutral',
      title: 'Balance refreshed',
      body: 'If a purchase has not appeared yet, tap Restore purchases.',
    });
  });

  it('reports a read that failed since the press', () => {
    expect(describeBalanceRefresh({ status: 'error', dataUpdatedAt: 500, errorUpdatedAt: 1_200 }, pressedAt)).toEqual({
      tone: 'danger',
      title: 'Could not refresh your balance',
      body: 'Check your connection, then try again.',
    });
  });

  it('says nothing it cannot know', () => {
    expect(describeBalanceRefresh(undefined, pressedAt)).toBeNull();
    expect(describeBalanceRefresh({ status: 'success', dataUpdatedAt: 500, errorUpdatedAt: 0 }, pressedAt)).toBeNull();
    expect(describeBalanceRefresh({ status: 'error', dataUpdatedAt: 500, errorUpdatedAt: 600 }, pressedAt)).toBeNull();
  });
});
