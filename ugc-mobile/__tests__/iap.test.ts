import { describe, expect, it } from 'vitest';

import { normalizePurchasedPackage } from '../lib/iap-purchase';

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

  it('rejects purchases that do not expose a usable transaction identifier', () => {
    expect(() => normalizePurchasedPackage({
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
    } as never, 'android')).toThrow('Purchase transaction is missing a store identifier.');
  });
});
