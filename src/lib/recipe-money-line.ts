import {
  POST_RESOURCE_CREATOR_SHARE_PERCENT,
  POST_RESOURCE_TOKENS_PER_USD,
} from '@/lib/post-resource-commerce';

/**
 * The payout floor in dollars. `CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS` in
 * `creator-payouts.ts` is the rule, but that module is server-only; the test
 * of this file holds the two together.
 */
export const RECIPE_PAYOUT_MINIMUM_USD = 100;

function formatDollars(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * The line under every price a creator sets, in the composer and the quick
 * publish window: "Buyers pay $9.00 · You earn ~$7.65 (85%) · Payouts from
 * $100". A price is a credit count, and 100 credits are $1, so the credits
 * are the cents; the creator's share is rounded to the cent. The app's
 * composer writes the same line.
 */
export function formatRecipeMoneyLine(priceCredits: number): string {
  const credits = Number.isFinite(priceCredits) ? Math.max(0, Math.round(priceCredits)) : 0;
  const centsPerCredit = 100 / POST_RESOURCE_TOKENS_PER_USD;
  const buyerCents = credits * centsPerCredit;
  const creatorCents = Math.round((buyerCents * POST_RESOURCE_CREATOR_SHARE_PERCENT) / 100);
  return [
    `Buyers pay ${formatDollars(buyerCents)}`,
    `You earn ~${formatDollars(creatorCents)} (${POST_RESOURCE_CREATOR_SHARE_PERCENT}%)`,
    `Payouts from $${RECIPE_PAYOUT_MINIMUM_USD}`,
  ].join(' · ');
}
