import { describe, expect, it } from 'vitest';

import { parseRevenueCatRefundEvent } from '@/lib/revenuecat-webhook';

function purchaseEvent(overrides: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      id: 'event-purchase-1',
      type: 'NON_RENEWING_PURCHASE',
      product_id: 'magicbooklet.credits.creator',
      transaction_id: 'GPA.9876-5432-1098-76543',
      app_user_id: '6a0bf06c-2829-45c7-93c1-06f5fe4bc15d',
      store: 'PLAY_STORE',
      event_timestamp_ms: 1_766_000_000_100,
      ...overrides,
    },
  };
}

describe('parseRevenueCatRefundEvent store-reported price capture', () => {
  it('captures the store-reported price pair from purchase events', () => {
    const parsed = parseRevenueCatRefundEvent(purchaseEvent({
      price: 22.99,
      price_in_purchased_currency: 1999,
      currency: 'INR',
    }));

    expect(parsed).toMatchObject({
      kind: 'purchase',
      event: {
        storeReportedPrice: 1999,
        storeReportedCurrency: 'INR',
      },
    });
  });

  it('degrades a malformed price pair to nulls without failing the event', () => {
    // Evidence, not authority: bad price data must not cost the settlement.
    for (const overrides of [
      {},
      { price_in_purchased_currency: 1999 },
      { price_in_purchased_currency: 1999, currency: 'rupees' },
      { price_in_purchased_currency: Number.NaN, currency: 'INR' },
      { price_in_purchased_currency: -1, currency: 'INR' },
      { price_in_purchased_currency: '1999', currency: 'INR' },
    ]) {
      const parsed = parseRevenueCatRefundEvent(purchaseEvent(overrides));

      expect(parsed).toMatchObject({
        kind: 'purchase',
        event: {
          storeReportedPrice: null,
          storeReportedCurrency: null,
        },
      });
    }
  });

  it('accepts a zero price for genuinely free store transactions', () => {
    const parsed = parseRevenueCatRefundEvent(purchaseEvent({
      price_in_purchased_currency: 0,
      currency: 'USD',
    }));

    expect(parsed).toMatchObject({
      kind: 'purchase',
      event: {
        storeReportedPrice: 0,
        storeReportedCurrency: 'USD',
      },
    });
  });
});
