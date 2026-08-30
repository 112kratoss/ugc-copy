import type { ConfigContext, ExpoConfig } from 'expo/config';
import { loadProjectEnv } from '@expo/env';

export const REQUIRED_PRODUCTION_CLIENT_ENV = [
  'EXPO_PUBLIC_SITE_URL',
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_WEB_API_BASE_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY',
  'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
] as const;

export function getMissingProductionClientEnv(
  env: Record<string, string | undefined>,
) {
  return REQUIRED_PRODUCTION_CLIENT_ENV.filter((key) => !env[key]?.trim());
}

export default function configureApp({ config }: ConfigContext): ExpoConfig {
  // Expo's export command reads dynamic app config before its normal dotenv
  // loading phase. Load the same standard files here so the guard sees local
  // production values; process-level EAS values retain priority.
  loadProjectEnv(__dirname, { silent: true });

  // Expo export (including the Gradle release bundle task) forces NODE_ENV to
  // production. EAS also exposes EAS_BUILD_PROFILE. Checking both keeps local
  // Gradle builds and cloud store builds from silently embedding empty values.
  const isProductionBundle =
    process.env.NODE_ENV === 'production'
    || process.env.EAS_BUILD_PROFILE === 'production';

  if (isProductionBundle) {
    const missing = getMissingProductionClientEnv(process.env);
    if (missing.length > 0) {
      throw new Error(
        `Refusing to create a production mobile bundle with missing environment values: ${missing.join(', ')}`,
      );
    }
  }

  return config as ExpoConfig;
}
