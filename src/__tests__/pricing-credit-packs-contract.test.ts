import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveMobileCreditProduct } from '@/lib/mobile-commerce';
import { PRICING_PLAN_MAP, PRICING_PLANS, type PricingPlanId } from '@/lib/pricing';

import creditPacksContract from '../../contracts/credit-packs-v1.json';

// 03-8: the packs were kept by hand in two places, the app's success notice
// counted credits from its own copy, and the server granted from the web's.
describe('credit packs contract', () => {
  it('builds the web list and the server plan map from the contract', () => {
    expect(creditPacksContract.schemaVersion).toBe(1);
    expect(PRICING_PLANS.map(({ id, name, credits, description, badge, priceInr, mobileProductId }) => (
      { id, name, credits, description, badge, priceInr, mobileProductId }
    ))).toEqual(creditPacksContract.packs);
    expect(Object.keys(PRICING_PLAN_MAP)).toEqual(creditPacksContract.packs.map((pack) => pack.id));
    for (const pack of creditPacksContract.packs) {
      expect(PRICING_PLAN_MAP[pack.id as PricingPlanId]).toMatchObject(pack);
    }
  });

  it('grants each store product the pack the contract sells under it', () => {
    for (const pack of creditPacksContract.packs) {
      expect(resolveMobileCreditProduct(pack.mobileProductId)).toMatchObject({
        id: pack.id,
        credits: pack.credits,
        priceInr: pack.priceInr,
      });
    }
    expect(resolveMobileCreditProduct('magicbooklet.credits.unknown')).toBeNull();
  });

  it('claims HD output for no pack', () => {
    for (const plan of PRICING_PLANS) {
      expect([plan.description, ...plan.features].join('\n')).not.toMatch(/\bHD\b/i);
    }
  });

  it('keeps the rest of the web card as it was', () => {
    expect(PRICING_PLANS.map((plan) => plan.features)).toEqual([
      ['500 Credits included', 'Generation cost shown before every run', 'Rates vary by model, quality, and duration', 'Email support'],
      ['2,000 Credits included', 'Generation cost shown before every run', 'Rates vary by model, quality, and duration', 'Email support'],
      ['10,000 Credits included', 'Generation cost shown before every run', 'Rates vary by model, quality, and duration', 'Email support'],
    ]);
    // The featured pack is the one with a badge.
    expect(PRICING_PLANS.map((plan) => [plan.id, plan.priceUsd, plan.popular])).toEqual([
      ['starter', 5, false],
      ['creator', 20, true],
      ['pro', 100, false],
    ]);
  });

  it('prices each pack as the database store catalog does', () => {
    // complete_mobile_purchase settles against the catalog this migration seeds
    // and the answer is checked against the plan: a pack priced here and not
    // there grants the credits and then fails the purchase on the phone.
    const seed = readFileSync('supabase/migrations/20260714113000_harden_mobile_purchase_authority.sql', 'utf8');
    const seeded = [...seed.matchAll(/\('(magicbooklet\.credits\.[a-z]+)', 'credits', (\d+), 'INR', (\d+), true\)/g)]
      .map(([, productId, amountSubunits, credits]) => ({
        productId,
        amountSubunits: Number(amountSubunits),
        credits: Number(credits),
      }));

    expect(seeded).toEqual(creditPacksContract.packs.map((pack) => ({
      productId: pack.mobileProductId,
      amountSubunits: pack.priceInr * 100,
      credits: pack.credits,
    })));
  });
});
