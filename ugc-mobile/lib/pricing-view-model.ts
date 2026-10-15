import type { MobileCommerceRestoreResponse, SkippedMobileCreditPurchase } from './api-client';
import {
  MOBILE_PRICING_BY_PRODUCT_ID,
  MOBILE_PRICING_PLANS,
  formatCreditAmount,
  type MobilePricingPlan,
  type PricingPlanId,
} from './pricing';

/** The pack the screen opens on: the one the contract gives a badge. */
export const DEFAULT_MOBILE_PRICING_PLAN_ID =
  MOBILE_PRICING_PLANS.find((plan) => plan.badge !== null)?.id ?? MOBILE_PRICING_PLANS[0].id;

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
  blockedReason: 'no_identity' | 'payments_restricted' | null;
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
  paymentsAllowed = true,
}: {
  identityUserId: string | null;
  isGuest: boolean;
  /** The store's canMakePayments answer; Screen Time or MDM can turn it off. */
  paymentsAllowed?: boolean;
}): PurchaseGate {
  if (!paymentsAllowed) {
    // A confirmed device restriction. Explain it instead of presenting a store
    // that cannot complete a purchase — and never pitch registration as the
    // way around it.
    return { canPurchase: false, showRegistrationOffer: false, blockedReason: 'payments_restricted' };
  }

  if (!identityUserId) {
    // Not "please register" — the guest bootstrap simply has not landed yet
    // (first launch, offline, or anonymous sign-ins disabled server-side). The
    // screen says so and stays retryable.
    return { canPurchase: false, showRegistrationOffer: false, blockedReason: 'no_identity' };
  }

  return { canPurchase: true, showRegistrationOffer: isGuest, blockedReason: null };
}

/** The store's own price for a pack; the app never shows a price of its own. */
export function formatPricingDisplayPrice(nativePrice?: string | null) {
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
  if (processing) return 'Processing purchase…';
  if (loading) return 'Loading store price…';
  return `Buy ${formatCreditAmount(plan.credits)} credits - ${price}`;
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

/** What the last purchase, refresh or restore came to, drawn above the packs. */
export type PricingNotice = {
  tone: 'success' | 'danger' | 'neutral';
  title: string;
  body: string;
};

/**
 * A purchase the store is holding for approval: a Play pending transaction, or
 * iOS Ask to Buy. RevenueCat reports it as an error (PAYMENT_PENDING_ERROR), but
 * nothing failed: the store charges once it is approved and the store's webhook
 * credits the account then, without this screen.
 */
export const PAYMENT_PENDING_NOTICE: PricingNotice = {
  tone: 'neutral',
  title: 'Purchase status',
  body: 'Payment pending — credits arrive when the store approves it.',
};

export function purchaseSyncedNotice(credits: number): PricingNotice {
  return {
    tone: 'success',
    title: 'Purchase updated',
    body: `${formatCreditAmount(credits)} credits are synced to your account.`,
  };
}

export const CHARGED_PURCHASE_LANDED_NOTICE: PricingNotice = {
  tone: 'success',
  title: 'Purchase updated',
  body: 'Your purchase went through and your credits are now up to date.',
};

/** Said whenever the store took the money and the credits cannot be shown yet: never a failure. */
export const CHARGED_PURCHASE_NOT_LANDED_NOTICE: PricingNotice = {
  tone: 'neutral',
  title: 'Purchase status',
  body: 'Your payment went through. Your credits have not landed yet — tap Refresh credit balance in a moment, '
    + 'or Restore purchases if they still do not appear. You have not been charged twice.',
};

/**
 * Whether the restore run after a charge got the purchase into the balance.
 * "Settled something" is not the only way: the store's webhook may have
 * credited the purchase first, and the restore then counts it as already
 * processed, so a balance above the one read before the purchase counts too.
 * Anything less is not claimed as success.
 */
export function restoreLandedPurchase(
  restore: Pick<MobileCommerceRestoreResponse, 'restoredCreditPurchases' | 'credits'>,
  balanceBeforePurchase: number | null,
): boolean {
  if ((restore.restoredCreditPurchases ?? 0) > 0) return true;
  return typeof restore.credits === 'number'
    && typeof balanceBeforePurchase === 'number'
    && restore.credits > balanceBeforePurchase;
}

/**
 * Purchases the restore left alone because their store transaction is on file
 * for another account: a guest's purchase whose credits moved with the guest,
 * or a store account shared by two Magicbooklet accounts. Reported by pack, so
 * a missing purchase is explained rather than silently absent.
 */
export function describeSkippedPurchases(skipped: readonly SkippedMobileCreditPurchase[] | null | undefined) {
  if (!skipped?.length) return null;
  const packs = [...new Set(skipped.map((purchase) => MOBILE_PRICING_BY_PRODUCT_ID[purchase.productId]?.name))]
    .filter((name): name is string => Boolean(name));
  const named = packs.length > 0 ? ` (${packs.join(', ')})` : '';
  return skipped.length === 1
    ? `1 purchase${named} is already on file for another Magicbooklet account, so it was not added here.`
    : `${skipped.length} purchases${named} are already on file for another Magicbooklet account, so they were not added here.`;
}

export function describeRestoreOutcome(
  restore: Pick<MobileCommerceRestoreResponse, 'restoredCreditPurchases' | 'skipped'>,
): PricingNotice {
  const restored = restore.restoredCreditPurchases ?? 0;
  const skippedLine = describeSkippedPurchases(restore.skipped);
  if (restored > 0) {
    const restoredLine = `${restored} ${restored === 1 ? 'purchase was' : 'purchases were'} added to your balance.`;
    return {
      tone: 'success',
      title: 'Purchases restored',
      body: skippedLine ? `${restoredLine} ${skippedLine}` : restoredLine,
    };
  }
  return {
    tone: 'neutral',
    title: 'Nothing new to restore',
    body: skippedLine ?? 'Every purchase on this account is already in your balance.',
  };
}

export function restoreFailedNotice(error: unknown): PricingNotice {
  return {
    tone: 'danger',
    title: 'Restore did not finish',
    body: error instanceof Error && error.message ? error.message : 'Check your connection, then try again.',
  };
}

/** The profile query's state, as React Query reports it, for the refresh's answer. */
export type ProfileRefreshState = { status: string; dataUpdatedAt: number; errorUpdatedAt: number };

/**
 * What "Refresh credit balance" came to. `refreshProfile()` keeps its errors to
 * itself, so the answer is read from the profile query it refreshes: data
 * written since the press is a refreshed balance, an error since then is a
 * failed read, and anything else says nothing rather than guess.
 */
export function describeBalanceRefresh(
  state: ProfileRefreshState | undefined,
  pressedAt: number,
): PricingNotice | null {
  if (state && state.dataUpdatedAt >= pressedAt) {
    return {
      tone: 'neutral',
      title: 'Balance refreshed',
      body: 'If a purchase has not appeared yet, tap Restore purchases.',
    };
  }
  if (state?.status === 'error' && state.errorUpdatedAt >= pressedAt) {
    return {
      tone: 'danger',
      title: 'Could not refresh your balance',
      body: 'Check your connection, then try again.',
    };
  }
  return null;
}
