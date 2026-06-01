import Purchases, { type CustomerInfo, type PurchasesPackage } from 'react-native-purchases';

import { env } from './env';
import { normalizePurchasedPackage, type NormalizedNativePurchase } from './iap-purchase';
export { resolveCreditEntitlement, type MobilePurchaseEntitlement } from './iap-entitlements';
export { normalizePurchasedPackage, type NormalizedNativePurchase } from './iap-purchase';

export function isIapConfigured(os: 'ios' | 'android' | 'web' | string) {
  if (os === 'ios') return Boolean(env.revenueCatIosApiKey);
  if (os === 'android') return Boolean(env.revenueCatAndroidApiKey);
  return false;
}

function platformApiKey(os: 'ios' | 'android' | 'web' | string) {
  if (os === 'ios') return env.revenueCatIosApiKey;
  if (os === 'android') return env.revenueCatAndroidApiKey;
  return '';
}

export async function configureIapForUser(userId: string | null, os: 'ios' | 'android' | 'web' | string) {
  if (!isIapConfigured(os) || !userId) {
    return false;
  }

  const apiKey = platformApiKey(os);
  const configured = await Purchases.isConfigured();

  if (!configured) {
    Purchases.configure({
      apiKey,
      appUserID: userId,
    });
    return true;
  }

  const currentUserId = await Purchases.getAppUserID();
  if (currentUserId !== userId) {
    await Purchases.logIn(userId);
  }

  return true;
}

export async function getCreditPackages(): Promise<PurchasesPackage[]> {
  const offerings = await Purchases.getOfferings();
  return offerings.current?.availablePackages ?? [];
}

export async function purchasePackage(
  item: PurchasesPackage,
  os: 'ios' | 'android'
): Promise<NormalizedNativePurchase> {
  const result = await Purchases.purchasePackage(item);
  return normalizePurchasedPackage(result, os);
}

export async function restorePurchases(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}
