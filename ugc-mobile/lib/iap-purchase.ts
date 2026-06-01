import type { CustomerInfo, MakePurchaseResult } from 'react-native-purchases';

export type NativePurchaseProvider = 'app_store' | 'play_store';

export interface NormalizedNativePurchase {
  provider: NativePurchaseProvider;
  productId: string;
  transactionId: string;
  customerInfo: CustomerInfo;
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
