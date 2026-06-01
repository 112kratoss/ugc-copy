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
