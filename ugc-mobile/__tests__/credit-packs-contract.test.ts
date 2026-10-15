import { describe, expect, it } from 'vitest';

import { resolveCreditEntitlement } from '../lib/iap-entitlements';
import { MOBILE_PRICING_BY_PRODUCT_ID, MOBILE_PRICING_PLANS } from '../lib/pricing';
import { DEFAULT_MOBILE_PRICING_PLAN_ID } from '../lib/pricing-view-model';

// Read by relative path: Metro cannot load a file from outside the app, so the
// app keeps a copy and this test is what holds the copy to the contract.
import creditPacksContract from '../../contracts/credit-packs-v1.json';

// 03-8: the app's success notice counted credits from its own list while the
// server granted from the web's, and nothing tied the two together.
describe('the credit packs the app sells', () => {
  it('are the packs contracts/credit-packs-v1.json defines, in its order', () => {
    expect(creditPacksContract.schemaVersion).toBe(1);
    expect(MOBILE_PRICING_PLANS.map(({ id, name, credits, description, badge, productId }) => (
      { id, name, credits, description, badge, mobileProductId: productId }
    ))).toEqual(creditPacksContract.packs.map(({ id, name, credits, description, badge, mobileProductId }) => (
      { id, name, credits, description, badge, mobileProductId }
    )));
  });

  it('grant the credits the server grants for each store product', () => {
    for (const pack of creditPacksContract.packs) {
      expect(MOBILE_PRICING_BY_PRODUCT_ID[pack.mobileProductId]?.id).toBe(pack.id);
      expect(resolveCreditEntitlement(pack.mobileProductId)).toEqual({
        type: 'credits',
        productId: pack.mobileProductId,
        credits: pack.credits,
      });
    }
  });

  it('open on the pack the contract features', () => {
    const featured = creditPacksContract.packs.filter((pack) => pack.badge !== null);
    expect(featured).toHaveLength(1);
    expect(DEFAULT_MOBILE_PRICING_PLAN_ID).toBe(featured[0].id);
  });

  it('carry no web price of their own: the store prices every pack in the app', () => {
    for (const plan of MOBILE_PRICING_PLANS) {
      expect(plan).not.toHaveProperty('webPriceInr');
      expect(plan).not.toHaveProperty('priceInr');
    }
  });
});
