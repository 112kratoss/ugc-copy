export type PricingPlanId = 'starter' | 'creator' | 'pro';

export interface MobilePricingPlan {
  id: PricingPlanId;
  name: string;
  credits: number;
  /** The App Store and Google Play product that sells this pack (the contract's `mobileProductId`). */
  productId: string;
  /** The label of the pack both clients feature, or null. */
  badge: string | null;
  description: string;
}

/**
 * The packs as contracts/credit-packs-v1.json defines them, copied because
 * Metro cannot load a file from outside the app; credit-packs-contract.test.ts
 * holds this list equal to the contract. The server grants the credits written
 * there, so the count the success notice names is the count the buyer gets.
 */
export const MOBILE_PRICING_PLANS: MobilePricingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    credits: 500,
    productId: 'magicbooklet.credits.starter',
    badge: null,
    description: 'Enough to try image, video, and motion.',
  },
  {
    id: 'creator',
    name: 'Creator',
    credits: 2000,
    productId: 'magicbooklet.credits.creator',
    badge: 'Most popular',
    description: 'Best value for active creators.',
  },
  {
    id: 'pro',
    name: 'Pro',
    credits: 10000,
    productId: 'magicbooklet.credits.pro',
    badge: null,
    description: 'For pro creators and small teams producing daily.',
  },
];

export const MOBILE_PRICING_BY_PRODUCT_ID = Object.fromEntries(
  MOBILE_PRICING_PLANS.map((plan) => [plan.productId, plan])
) as Record<string, MobilePricingPlan>;

/**
 * Locale used for every credit balance in the app.
 *
 * Pinned rather than device-derived so a balance reads identically wherever it
 * appears — header, pricing, invite, the creation quote. Note that `en-IN`
 * groups in lakhs (1,00,000 rather than 100,000), which is deliberate for the
 * current audience; changing it is a one-line decision here rather than a sweep
 * through every screen.
 */
const CREDIT_LOCALE = 'en-IN';

/** Groups a credit balance so long numbers stay readable at a glance. */
export function formatCreditAmount(value: number | null | undefined) {
  const safeValue = Math.max(0, Math.trunc(value ?? 0));
  return safeValue.toLocaleString(CREDIT_LOCALE);
}

/**
 * Drawn in a number slot until the balance is known. A 0 there reads as an
 * empty balance to someone who has credits, and the balance is unknown for a
 * moment on a first launch, after a sign-out, or whenever the profile request
 * has not answered yet.
 */
export const UNKNOWN_CREDIT_BALANCE_LABEL = '–';
/** The same dash for any other amount or count not known yet: one glyph app-wide. */
export const UNKNOWN_AMOUNT_LABEL = UNKNOWN_CREDIT_BALANCE_LABEL;
/** The same unknown balance where a sentence is expected rather than a number. */
export const CREDIT_BALANCE_LOADING_LABEL = 'Balance loading…';

/** A balance for a number slot: formatted when known, the placeholder dash when not. */
export function formatCreditBalance(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? formatCreditAmount(value)
    : UNKNOWN_CREDIT_BALANCE_LABEL;
}

/**
 * What a recipe that costs nothing is called wherever a post is listed: a Home
 * card's chip, an Explore tile, the reel, a profile tile, the marketplace page.
 * The web says the same words (`FREE_RECIPE_LABEL` in
 * src/lib/showcase-asset-labels.ts); `contracts/feed-recipe-chip-v1.json` holds
 * both to them. It read "Free unlock" here while the web read "Free recipe".
 */
export const FREE_RECIPE_LABEL = 'Free recipe';

/**
 * A creator's price for an unlock, as a buyer pays it in the app: in credits.
 * Bundle prices are kept in US cents, and an unlock costs one credit per cent
 * (the server's `credit_cost` is `price_usd_cents`), so the number carries over
 * unchanged.
 *
 * No unlock shows a cash price here. The only things the app sells for money
 * are the credit packs, through the store. App Review read a "$9" beside an
 * unlock as an in-app purchase that had never been submitted (guideline 2.1(b),
 * 0.1.6).
 */
export function formatUnlockCreditPrice(priceUsdCents: number | null | undefined) {
  const credits = Math.max(0, Math.trunc(priceUsdCents ?? 0));
  if (credits === 0) return 'Free';
  return `${formatCreditAmount(credits)} ${credits === 1 ? 'credit' : 'credits'}`;
}
