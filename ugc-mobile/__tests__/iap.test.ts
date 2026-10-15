import { describe, expect, it } from 'vitest';

import { isPaymentPendingPurchase, isUserCancelledPurchase, normalizePurchasedPackage } from '../lib/iap-purchase';

describe('purchase cancellation classification', () => {
  it('treats a dismissed purchase sheet as a cancellation, not a failure', () => {
    expect(isUserCancelledPurchase(Object.assign(new Error('Purchase was cancelled'), {
      userCancelled: true,
    }))).toBe(true);
  });

  it('treats a real purchase failure as a failure', () => {
    expect(isUserCancelledPurchase(Object.assign(new Error('Network error'), {
      userCancelled: false,
    }))).toBe(false);
    // RevenueCat types the flag as nullable, and a null must not read as a cancel.
    expect(isUserCancelledPurchase(Object.assign(new Error('Store error'), {
      userCancelled: null,
    }))).toBe(false);
    expect(isUserCancelledPurchase(new Error('Store unreachable'))).toBe(false);
    expect(isUserCancelledPurchase(null)).toBe(false);
    expect(isUserCancelledPurchase('cancelled')).toBe(false);
  });
});

describe('pending purchase classification', () => {
  it("reads RevenueCat's PAYMENT_PENDING_ERROR (code \"20\") as pending", () => {
    // Play pending transactions and iOS Ask to Buy: the store charges later,
    // once approved, and the webhook credits the account then.
    expect(isPaymentPendingPurchase(Object.assign(new Error('The payment is pending.'), {
      code: '20',
      userCancelled: false,
    }))).toBe(true);
    expect(isPaymentPendingPurchase({ code: 20 })).toBe(true);
  });

  it('leaves every other store error a failure', () => {
    expect(isPaymentPendingPurchase(Object.assign(new Error('Purchase was cancelled'), { code: '1' }))).toBe(false);
    expect(isPaymentPendingPurchase(Object.assign(new Error('Store problem'), { code: '2' }))).toBe(false);
    expect(isPaymentPendingPurchase(new Error('Network error'))).toBe(false);
    expect(isPaymentPendingPurchase(null)).toBe(false);
    expect(isPaymentPendingPurchase('20')).toBe(false);
  });
});

describe('RevenueCat purchase normalization', () => {
  it('uses the iOS transaction identifier for App Store purchases', () => {
    expect(normalizePurchasedPackage({
      productIdentifier: 'magicbooklet.credits.creator',
      customerInfo: {
        originalAppUserId: 'user-1',
      },
      transaction: {
        productIdentifier: 'magicbooklet.credits.creator',
        transactionIdentifier: '1000000123456789',
        purchaseDate: '2026-05-14T00:00:00Z',
        purchaseToken: null,
      },
    } as never, 'ios')).toMatchObject({
      provider: 'app_store',
      productId: 'magicbooklet.credits.creator',
      transactionId: '1000000123456789',
    });
  });

  it('falls back to the Android purchase token when needed', () => {
    expect(normalizePurchasedPackage({
      productIdentifier: 'magicbooklet.credits.pro',
      customerInfo: {
        originalAppUserId: 'user-1',
      },
      transaction: {
        productIdentifier: 'magicbooklet.credits.pro',
        transactionIdentifier: '',
        purchaseDate: '2026-05-14T00:00:00Z',
        purchaseToken: 'purchase-token-123',
      },
    } as never, 'android')).toMatchObject({
      provider: 'play_store',
      productId: 'magicbooklet.credits.pro',
      transactionId: 'purchase-token-123',
    });
  });

  it('keeps a store result without a transaction identifier, for the screen to count as charged', () => {
    // Throwing here ran ahead of the screen's `charged` flag, so a buyer the
    // store had charged read "Purchase not completed".
    expect(normalizePurchasedPackage({
      productIdentifier: 'magicbooklet.credits.starter',
      customerInfo: {
        originalAppUserId: 'user-1',
      },
      transaction: {
        productIdentifier: 'magicbooklet.credits.starter',
        transactionIdentifier: '',
        purchaseDate: '2026-05-14T00:00:00Z',
        purchaseToken: null,
      },
    } as never, 'android')).toMatchObject({
      provider: 'play_store',
      productId: 'magicbooklet.credits.starter',
      transactionId: null,
    });
  });
});
