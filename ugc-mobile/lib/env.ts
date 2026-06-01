function isWebRuntime() {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

function resolveApiBaseUrl() {
  if (isWebRuntime() && process.env.EXPO_PUBLIC_WEB_API_BASE_URL) {
    return process.env.EXPO_PUBLIC_WEB_API_BASE_URL;
  }

  return process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://magicbooklet.com';
}

export const env = {
  siteUrl: process.env.EXPO_PUBLIC_SITE_URL ?? 'https://magicbooklet.com',
  apiBaseUrl: resolveApiBaseUrl(),
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  revenueCatIosApiKey: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ?? '',
  revenueCatAndroidApiKey: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ?? '',
  easProjectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? '',
};

export function getMissingMobileEnvKeys() {
  return Object.entries({
    EXPO_PUBLIC_SUPABASE_URL: env.supabaseUrl,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.supabasePublishableKey,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function isMobileEnvConfigured() {
  return getMissingMobileEnvKeys().length === 0;
}

export function requireMobileEnv() {
  const missing = getMissingMobileEnvKeys();
  if (missing.length > 0) {
    throw new Error(`Missing mobile environment values: ${missing.join(', ')}`);
  }
}
