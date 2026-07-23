export const POST_RESOURCE_TOKENS_PER_USD = 100;
export const POST_RESOURCE_WEB_CASH_MIN_TOKENS = POST_RESOURCE_TOKENS_PER_USD;
export const POST_RESOURCE_CREATOR_SHARE_PERCENT = 85;
export const POST_RESOURCE_PLATFORM_FEE_PERCENT = 15;
export const POST_RESOURCE_TOKEN_SUBUNITS = 100;

export type PostResourceSaleSplit = {
  grossTokens: number;
  grossTokenSubunits: number;
  creatorTokenSubunits: number;
  platformFeeTokenSubunits: number;
};

/**
 * Resource prices are stored in the legacy `price_usd_cents` column. At the
 * fixed 100-token/$1 rate, the numeric value is also the token price.
 * Subunits preserve an exact 85/15 split for prices such as 10 tokens.
 */
export function calculatePostResourceSaleSplit(grossTokens: number): PostResourceSaleSplit {
  if (!Number.isSafeInteger(grossTokens) || grossTokens < 0) {
    throw new TypeError('Resource sale price must be a non-negative whole-token amount.');
  }

  const grossTokenSubunits = grossTokens * POST_RESOURCE_TOKEN_SUBUNITS;
  if (!Number.isSafeInteger(grossTokenSubunits)) {
    throw new RangeError('Resource sale price is too large.');
  }

  return {
    grossTokens,
    grossTokenSubunits,
    creatorTokenSubunits: grossTokens * POST_RESOURCE_CREATOR_SHARE_PERCENT,
    platformFeeTokenSubunits: grossTokens * POST_RESOURCE_PLATFORM_FEE_PERCENT,
  };
}

export function isPostResourceWebCashEligible(grossTokens: number) {
  return Number.isSafeInteger(grossTokens)
    && grossTokens >= POST_RESOURCE_WEB_CASH_MIN_TOKENS;
}
