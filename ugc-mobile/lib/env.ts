function isWebRuntime() {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

function resolveApiBaseUrl() {
  if (isWebRuntime() && process.env.EXPO_PUBLIC_WEB_API_BASE_URL) {
    return process.env.EXPO_PUBLIC_WEB_API_BASE_URL;
  }

  return resolveAndroidLoopbackUrl(process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://magicbooklet.com');
}

function resolveSupabaseUrl() {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';

  if (!supabaseUrl || isWebRuntime() || !isAndroidRuntime()) {
    return supabaseUrl;
  }

  return resolveAndroidLoopbackUrl(supabaseUrl);
}

function resolveAndroidLoopbackUrl(url: string) {
  if (!url || isWebRuntime() || !isAndroidRuntime()) {
    return url;
  }

  return url.replace(
    /^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/,
    (_match, protocol: string) => `${protocol}10.0.2.2`
  );
}

function isAndroidRuntime() {
  return process.env.EXPO_OS === 'android';
}

export const env = {
  siteUrl: process.env.EXPO_PUBLIC_SITE_URL ?? 'https://magicbooklet.com',
  apiBaseUrl: resolveApiBaseUrl(),
  supabaseUrl: resolveSupabaseUrl(),
  supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  revenueCatIosApiKey: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ?? '',
  revenueCatAndroidApiKey: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ?? '',
  easProjectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? '',
  appStoreUrl: process.env.EXPO_PUBLIC_APP_STORE_URL ?? 'https://apps.apple.com/app/id6773286115',
  playStoreUrl: process.env.EXPO_PUBLIC_PLAY_STORE_URL ?? 'https://play.google.com/store/apps/details?id=com.magicbooklet.mobile',
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
