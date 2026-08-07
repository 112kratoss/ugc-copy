import type { CustomerInfo, MakePurchaseResult } from 'react-native-purchases';

export type NativePurchaseProvider = 'app_store' | 'play_store';

export interface NormalizedNativePurchase {
  provider: NativePurchaseProvider;
  productId: string;
  transactionId: string;
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

export function normalizePurchasedPackage(
  result: MakePurchaseResult,
  os: 'ios' | 'android'
): NormalizedNativePurchase {
  const transactionId =
    result.transaction.transactionIdentifier?.trim()
    || result.transaction.purchaseToken?.trim()
    || '';

  if (!transactionId) {
    throw new Error('Purchase transaction is missing a store identifier.');
  }

  return {
    provider: os === 'ios' ? 'app_store' : 'play_store',
    productId: result.productIdentifier,
    transactionId,
    customerInfo: result.customerInfo,
  };
}
