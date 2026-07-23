import { describe, expect, it } from 'vitest';

import {
  calculatePostResourceSaleSplit,
  isPostResourceWebCashEligible,
} from '@/lib/post-resource-commerce';

describe('post resource sale economics', () => {
  it('maps 100 tokens to $1 and splits the sale 85/15', () => {
    expect(calculatePostResourceSaleSplit(100)).toEqual({
      grossTokens: 100,
      grossTokenSubunits: 10_000,
      creatorTokenSubunits: 8_500,
      platformFeeTokenSubunits: 1_500,
    });
  });

  it('preserves the exact split for the 10-token minimum without rounding', () => {
    expect(calculatePostResourceSaleSplit(10)).toEqual({
      grossTokens: 10,
      grossTokenSubunits: 1_000,
      creatorTokenSubunits: 850,
      platformFeeTokenSubunits: 150,
    });
  });

  it('only allows web cash checkout from 100 tokens', () => {
    expect(isPostResourceWebCashEligible(90)).toBe(false);
    expect(isPostResourceWebCashEligible(100)).toBe(true);
  });
});
