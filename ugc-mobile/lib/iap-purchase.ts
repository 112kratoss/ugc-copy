import type { CustomerInfo, MakePurchaseResult } from 'react-native-purchases';

export type NativePurchaseProvider = 'app_store' | 'play_store';

export interface NormalizedNativePurchase {
  provider: NativePurchaseProvider;
  productId: string;
  /**
   * Null when the store's result names no transaction. The result still means
   * the store took the payment, so the caller settles it through the restore
   * path rather than reporting a failed purchase.
   */
  transactionId: string | null;
  customerInfo: CustomerInfo;
}

/**
 * RevenueCat surfaces a dismissed purchase sheet as a thrown error carrying
 * `userCancelled`. Treating it like a failure puts a red banner on screen for
 * someone who simply changed their mind — which is part of what App Review saw
 * when it flagged the purchase flow under guideline 2.1(b).
 */
export function isUserCancelledPurchase(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'userCancelled' in error
    && (error as { userCancelled?: boolean | null }).userCancelled === true;
}

/** RevenueCat's PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR. */
const PAYMENT_PENDING_ERROR_CODE = '20';

/**
 * RevenueCat also throws for a purchase the store is holding for approval: a
 * Play pending transaction, or iOS Ask to Buy. Nothing has failed and nothing
 * has been charged yet; the store's webhook credits the account once the store
 * approves it, so the buyer is told it is pending, not that it failed. The code
 * is compared as a string (the SDK's enum value) without importing the SDK,
 * which would load its native module.
 */
export function isPaymentPendingPurchase(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && String((error as { code?: unknown }).code) === PAYMENT_PENDING_ERROR_CODE;
}

export function normalizePurchasedPackage(
  result: MakePurchaseResult,
  os: 'ios' | 'android'
): NormalizedNativePurchase {
  // A result without an id is still a completed payment. Throwing here put the
  // error ahead of the screen's `charged` flag, and a charged buyer read
  // "Purchase not completed".
  const transactionId =
    result.transaction?.transactionIdentifier?.trim()
    || result.transaction?.purchaseToken?.trim()
    || null;

  return {
    provider: os === 'ios' ? 'app_store' : 'play_store',
    productId: result.productIdentifier,
    transactionId,
    customerInfo: result.customerInfo,
  };
}
