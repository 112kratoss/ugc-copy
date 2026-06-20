import { MOBILE_PRICING_PLANS, type MobilePricingPlan, type PricingPlanId } from './pricing';

export const DEFAULT_MOBILE_PRICING_PLAN_ID =
  MOBILE_PRICING_PLANS.find((plan) => plan.popular)?.id ?? MOBILE_PRICING_PLANS[0].id;

export function resolveSelectedPricingPlan(planId: PricingPlanId): MobilePricingPlan {
  return MOBILE_PRICING_PLANS.find((plan) => plan.id === planId)
    ?? MOBILE_PRICING_PLANS.find((plan) => plan.id === DEFAULT_MOBILE_PRICING_PLAN_ID)
    ?? MOBILE_PRICING_PLANS[0];
}

export function formatPricingDisplayPrice(
  plan: MobilePricingPlan,
  nativePrice?: string | null
) {
  const trimmedNativePrice = nativePrice?.trim();
  return trimmedNativePrice || `Web estimate Rs ${plan.webPriceInr.toLocaleString('en-IN')}`;
}

export function getPurchaseButtonLabel({
  plan,
  price,
  loading = false,
  processing = false,
}: {
  plan: MobilePricingPlan;
  price: string;
  loading?: boolean;
  processing?: boolean;
}) {
  if (processing) return 'Processing purchase...';
  if (loading) return 'Loading store price...';
  return `Buy ${plan.credits.toLocaleString('en-IN')} credits - ${price}`;
}

export function getPricingPlanIdForCarouselOffset(
  offset: number,
  snapInterval: number
): PricingPlanId {
  const safeInterval = Math.max(1, snapInterval);
  const nearestIndex = Math.round(Math.max(0, offset) / safeInterval);
  const clampedIndex = Math.min(MOBILE_PRICING_PLANS.length - 1, nearestIndex);
  return MOBILE_PRICING_PLANS[clampedIndex].id;
}

export function getPricingPlanCarouselOffset(
  planId: PricingPlanId,
  snapInterval: number
) {
  const planIndex = MOBILE_PRICING_PLANS.findIndex((plan) => plan.id === planId);
  return Math.max(0, planIndex) * Math.max(1, snapInterval);
}
