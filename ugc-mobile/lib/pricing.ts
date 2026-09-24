export type PricingPlanId = 'starter' | 'creator' | 'pro';

export interface MobilePricingPlan {
  id: PricingPlanId;
  name: string;
  credits: number;
  webPriceInr: number;
  productId: string;
  popular: boolean;
  description: string;
}

export const MOBILE_PRICING_PLANS: MobilePricingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    credits: 500,
    webPriceInr: 415,
    productId: 'magicbooklet.credits.starter',
    popular: false,
    description: 'Enough to test image, video, and motion flows.',
  },
  {
    id: 'creator',
    name: 'Creator',
    credits: 2000,
    webPriceInr: 1660,
    productId: 'magicbooklet.credits.creator',
    popular: true,
    description: 'Best mobile pack for active creator iteration.',
  },
  {
    id: 'pro',
    name: 'Pro',
    credits: 10000,
    webPriceInr: 8300,
    productId: 'magicbooklet.credits.pro',
    popular: false,
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
