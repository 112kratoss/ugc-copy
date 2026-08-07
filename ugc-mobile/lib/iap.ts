import Purchases, { LOG_LEVEL, type PurchasesPackage } from 'react-native-purchases';

import { env } from './env';
import { normalizePurchasedPackage, type NormalizedNativePurchase } from './iap-purchase';
export { resolveCreditEntitlement, type MobilePurchaseEntitlement } from './iap-entitlements';
export {
  isUserCancelledPurchase,
  normalizePurchasedPackage,
  type NormalizedNativePurchase,
} from './iap-purchase';

let hasInstalledRevenueCatLogHandler = false;

function isExpectedDevBillingUnavailable(message: string) {
  return message.includes('BILLING_UNAVAILABLE') || message.includes('Billing is not available in this device');
}

function installRevenueCatLogHandler() {
  if (hasInstalledRevenueCatLogHandler) {
    return;
  }

  hasInstalledRevenueCatLogHandler = true;
  Purchases.setLogHandler((level, message) => {
    if (__DEV__ && isExpectedDevBillingUnavailable(message)) {
      return;
    }

    const formattedMessage = `[RevenueCat] ${message}`;
    if (level === LOG_LEVEL.ERROR) {
      console.error(formattedMessage);
    } else if (level === LOG_LEVEL.WARN) {
      console.warn(formattedMessage);
    } else if (level === LOG_LEVEL.INFO) {
      console.info(formattedMessage);
    } else {
      console.debug(formattedMessage);
    }
  });
}

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
  installRevenueCatLogHandler();

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
