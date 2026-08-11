import { MOBILE_PRICING_PLANS, type MobilePricingPlan, type PricingPlanId } from './pricing';

export const DEFAULT_MOBILE_PRICING_PLAN_ID =
  MOBILE_PRICING_PLANS.find((plan) => plan.popular)?.id ?? MOBILE_PRICING_PLANS[0].id;

export function resolveSelectedPricingPlan(planId: PricingPlanId): MobilePricingPlan {
  return MOBILE_PRICING_PLANS.find((plan) => plan.id === planId)
    ?? MOBILE_PRICING_PLANS.find((plan) => plan.id === DEFAULT_MOBILE_PRICING_PLAN_ID)
    ?? MOBILE_PRICING_PLANS[0];
}

export type PurchaseGate = {
  /** Whether the buy button may be pressed at all. */
  canPurchase: boolean;
  /** Offer registration, never require it. */
  showRegistrationOffer: boolean;
  /** Set only when purchase is genuinely unavailable, never to demand sign-up. */
  blockedReason: 'no_identity' | null;
};

/**
 * Who may buy credits.
 *
 * This is the rule App Review rejected 0.0.5 (28) over. Guideline 5.1.1(v):
 * registration must not be a precondition for an In-App Purchase that is not
 * account-based. So the only thing purchase depends on is having a backend
 * identity to hold the balance — which a guest has.
 *
 * Extracted from the screen so the rule is asserted directly rather than
 * inferred from a rendered tree. If this ever starts returning false for a
 * guest, the rejection comes straight back.
 */
export function resolvePurchaseGate({
  identityUserId,
  isGuest,
}: {
  identityUserId: string | null;
  isGuest: boolean;
}): PurchaseGate {
  if (!identityUserId) {
    // Not "please register" — the guest bootstrap simply has not landed yet
    // (first launch, offline, or anonymous sign-ins disabled server-side). The
    // screen says so and stays retryable.
    return { canPurchase: false, showRegistrationOffer: false, blockedReason: 'no_identity' };
  }

  return { canPurchase: true, showRegistrationOffer: isGuest, blockedReason: null };
}

export function formatPricingDisplayPrice(
  _plan: MobilePricingPlan,
  nativePrice?: string | null
) {
  const trimmedNativePrice = nativePrice?.trim();
  return trimmedNativePrice || 'Store price unavailable';
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
