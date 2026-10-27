import { describe, expect, it } from 'vitest';

import { CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS } from '@/lib/creator-payouts';
import { POST_RESOURCE_TOKEN_SUBUNITS, POST_RESOURCE_TOKENS_PER_USD } from '@/lib/post-resource-commerce';
import { formatRecipeMoneyLine, RECIPE_PAYOUT_MINIMUM_USD } from '@/lib/recipe-money-line';

// The one line under every price a creator sets (A-F4, A-F5): what a buyer
// pays, the creator's 85% of it, and when money can leave, in dollars at
// 100 credits to $1, rounded to the cent.
describe('formatRecipeMoneyLine', () => {
  it('reads a price in credits as what buyers pay and what the creator earns', () => {
    expect(formatRecipeMoneyLine(900)).toBe('Buyers pay $9.00 · You earn ~$7.65 (85%) · Payouts from $100');
    expect(formatRecipeMoneyLine(1200)).toBe('Buyers pay $12.00 · You earn ~$10.20 (85%) · Payouts from $100');
  });

  it('rounds the share to the cent', () => {
    // 10 credits earn 8.5 cents.
    expect(formatRecipeMoneyLine(10)).toBe('Buyers pay $0.10 · You earn ~$0.09 (85%) · Payouts from $100');
    expect(formatRecipeMoneyLine(250000)).toBe('Buyers pay $2,500.00 · You earn ~$2,125.00 (85%) · Payouts from $100');
  });

  it('reads an empty or unusable price as nothing yet', () => {
    for (const price of [0, -40, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatRecipeMoneyLine(price)).toBe('Buyers pay $0.00 · You earn ~$0.00 (85%) · Payouts from $100');
    }
  });

  it('names the payout minimum the server holds requests to', () => {
    expect(RECIPE_PAYOUT_MINIMUM_USD * POST_RESOURCE_TOKENS_PER_USD * POST_RESOURCE_TOKEN_SUBUNITS)
      .toBe(CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS);
  });
});
