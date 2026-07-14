export type BackendEnvironmentStatus = 'ok' | 'degraded';

export type BackendEnvironmentHealth = {
  status: BackendEnvironmentStatus;
  configuredRequirementCount: number;
  totalRequirementCount: number;
  missing: string[];
};

export const BACKEND_ENVIRONMENT_REQUIREMENTS = [
  { id: 'supabase-url', keys: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'] },
  { id: 'supabase-anon-key', keys: ['NEXT_PUBLIC_SUPABASE_ANON_KEY'] },
  { id: 'supabase-service-role', keys: ['SUPABASE_SERVICE_ROLE_KEY'] },
  { id: 'production-site-url', keys: ['NEXT_PUBLIC_SITE_URL'] },
  { id: 'cron-auth', keys: ['CRON_SECRET'] },
  { id: 'ops-read-auth', keys: ['OPS_READ_SECRET'] },
  { id: 'generation-provider', keys: ['KIE_AI_API_KEY'] },
  { id: 'generation-webhook-ingress', keys: ['KIE_PROVIDER_WEBHOOK_SECRET', 'WEBHOOK_SECRET'] },
  { id: 'generation-webhook-forward-auth', keys: ['KIE_WEBHOOK_HMAC_KEY', 'WEBHOOK_SECRET'] },
  { id: 'razorpay-public-key', keys: ['NEXT_PUBLIC_RAZORPAY_KEY_ID'] },
  { id: 'razorpay-secret', keys: ['RAZORPAY_KEY_SECRET'] },
  { id: 'razorpay-webhook-auth', keys: ['RAZORPAY_WEBHOOK_SECRET'] },
  { id: 'revenuecat-api', keys: ['REVENUECAT_SECRET_API_KEY', 'REVENUECAT_REST_API_KEY'] },
  { id: 'revenuecat-webhook-auth', keys: ['REVENUECAT_WEBHOOK_AUTH_TOKEN'] },
  { id: 'referral-attribution-hash', keys: ['REFERRAL_ATTRIBUTION_HASH_SECRET'] },
  { id: 'apple-app-links', keys: ['APPLE_TEAM_ID'] },
  { id: 'android-app-links', keys: ['ANDROID_APP_SHA256_FINGERPRINTS'] },
] as const;

function isConfigured(environment: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some((key) => Boolean(environment[key]?.trim()));
}

export function collectBackendEnvironmentHealth(
  environment: NodeJS.ProcessEnv,
): BackendEnvironmentHealth {
  const missing = BACKEND_ENVIRONMENT_REQUIREMENTS
    .filter((requirement) => !isConfigured(environment, requirement.keys))
    .map((requirement) => requirement.id);

  return {
    status: missing.length === 0 ? 'ok' : 'degraded',
    configuredRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length - missing.length,
    totalRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length,
    missing,
  };
}
