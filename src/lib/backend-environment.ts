// Deliberately NOT marked `server-only`, unlike the other modules that read the
// service-role key. `next.config.ts` imports this module, and Next compiles the
// config to next.config.compiled.js and runs it in plain Node -- outside the
// bundler graph that aliases `server-only`, so the import fails to resolve and
// takes the whole build down with MODULE_NOT_FOUND.
//
// The protection here is therefore by convention: this module must only ever be
// imported by server code and by next.config.ts. If it ever needs a hard guard,
// split the env-name table that the config needs away from the value-reading
// helpers, and mark only the latter.

export type BackendEnvironmentStatus = 'ok' | 'degraded';

export type BackendEnvironmentHealth = {
  status: BackendEnvironmentStatus;
  configuredRequirementCount: number;
  totalRequirementCount: number;
  missing: string[];
  invalid: string[];
};

export const BACKEND_ENVIRONMENT_REQUIREMENTS = [
  { id: 'supabase-url', keys: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'] },
  { id: 'supabase-anon-key', keys: ['NEXT_PUBLIC_SUPABASE_ANON_KEY'] },
  { id: 'supabase-service-role', keys: ['SUPABASE_SERVICE_ROLE_KEY'] },
  { id: 'identity-admission', keys: ['IDENTITY_ADMISSION_SECRET'] },
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

export function isProductionDeployment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV === 'production'
    || environment.VERCEL_ENV === 'production'
    || environment.VERCEL_TARGET_ENV === 'production';
}

export function collectInvalidProductionCommerceSettings(
  environment: NodeJS.ProcessEnv,
): string[] {
  if (!isProductionDeployment(environment)) return [];

  const invalid: string[] = [];
  const razorpayKeyId = environment.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim();
  if (razorpayKeyId && !razorpayKeyId.startsWith('rzp_live_')) {
    invalid.push('razorpay-live-mode');
  }
  if (environment.MOBILE_COMMERCE_ALLOW_SANDBOX === '1') {
    invalid.push('mobile-commerce-sandbox-disabled');
  }
  // RevenueCat is settlement infrastructure: without the webhook auth token the
  // webhook answers 503 and store refunds are silently redelivered until they
  // expire, and without the API key purchases cannot be verified at all. In
  // production both must be flagged as invalid commerce config, not merely
  // "missing", so health hard-fails release verification.
  if (!environment.REVENUECAT_WEBHOOK_AUTH_TOKEN?.trim()) {
    invalid.push('revenuecat-webhook-auth-unconfigured');
  }
  if (
    !environment.REVENUECAT_SECRET_API_KEY?.trim()
    && !environment.REVENUECAT_REST_API_KEY?.trim()
  ) {
    invalid.push('revenuecat-api-key-unconfigured');
  }
  return invalid;
}

export function collectInvalidScalingSettings(
  environment: NodeJS.ProcessEnv,
): string[] {
  const invalid: string[] = [];
  const identitySecret = environment.IDENTITY_ADMISSION_SECRET?.trim();
  if (identitySecret && new TextEncoder().encode(identitySecret).byteLength < 32) {
    invalid.push('identity-admission-secret-too-short');
  }
  return invalid;
}

export function isProductionRazorpayKeyAllowed(
  keyId: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isProductionDeployment(environment)
    || Boolean(keyId?.trim().startsWith('rzp_live_'));
}

export function collectBackendEnvironmentHealth(
  environment: NodeJS.ProcessEnv,
): BackendEnvironmentHealth {
  const missing = BACKEND_ENVIRONMENT_REQUIREMENTS
    .filter((requirement) => !isConfigured(environment, requirement.keys))
    .map((requirement) => requirement.id);
  const invalid = [
    ...collectInvalidProductionCommerceSettings(environment),
    ...collectInvalidScalingSettings(environment),
  ];

  return {
    status: missing.length === 0 && invalid.length === 0 ? 'ok' : 'degraded',
    configuredRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length - missing.length,
    totalRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length,
    missing,
    invalid,
  };
}
