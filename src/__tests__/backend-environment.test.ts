import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BACKEND_ENVIRONMENT_REQUIREMENTS,
  collectBackendEnvironmentHealth,
} from '@/lib/backend-environment';

const COMPLETE_ENVIRONMENT = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  IDENTITY_ADMISSION_SECRET: 'identity-admission-secret-at-least-32-characters',
  NEXT_PUBLIC_SITE_URL: 'https://magicbooklet.com',
  CRON_SECRET: 'cron-secret',
  OPS_READ_SECRET: 'ops-read-secret',
  KIE_AI_API_KEY: 'kie-key',
  KIE_WEBHOOK_HMAC_KEY: 'kie-webhook-key',
  KIE_PROVIDER_WEBHOOK_SECRET: 'kie-provider-webhook-secret',
  NEXT_PUBLIC_RAZORPAY_KEY_ID: 'rzp_live_key',
  RAZORPAY_KEY_SECRET: 'rzp-secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp-webhook-secret',
  REVENUECAT_SECRET_API_KEY: 'revenuecat-key',
  REVENUECAT_WEBHOOK_AUTH_TOKEN: 'Bearer revenuecat-webhook-secret',
  REFERRAL_ATTRIBUTION_HASH_SECRET: 'referral-hash-secret',
  APPLE_TEAM_ID: 'TEAM123456',
  ANDROID_APP_SHA256_FINGERPRINTS: 'AA:BB',
} satisfies NodeJS.ProcessEnv;

describe('backend environment contract', () => {
  it('reports a complete production environment without exposing values', () => {
    const health = collectBackendEnvironmentHealth(COMPLETE_ENVIRONMENT);

    expect(health).toEqual({
      status: 'ok',
      configuredRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length,
      totalRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length,
      missing: [],
      invalid: [],
    });
    expect(JSON.stringify(health)).not.toContain('service-role-key');
  });

  it('accepts documented fallback variables and reports missing capabilities by name', () => {
    const health = collectBackendEnvironmentHealth({
      ...COMPLETE_ENVIRONMENT,
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      SUPABASE_URL: 'https://project.supabase.co',
      KIE_WEBHOOK_HMAC_KEY: undefined,
      WEBHOOK_SECRET: 'legacy-kie-webhook-secret',
      REVENUECAT_SECRET_API_KEY: undefined,
      REVENUECAT_REST_API_KEY: 'revenuecat-rest-key',
      REVENUECAT_WEBHOOK_AUTH_TOKEN: '   ',
    });

    expect(health.status).toBe('degraded');
    expect(health.missing).toEqual(['revenuecat-webhook-auth']);
    expect(health.invalid).toEqual([]);
    expect(health.configuredRequirementCount).toBe(health.totalRequirementCount - 1);
  });

  it('does not require an external alert delivery destination when protected ops dashboarding exists', () => {
    const health = collectBackendEnvironmentHealth({
      ...COMPLETE_ENVIRONMENT,
      BACKEND_ALERT_DELIVERY_URL: undefined,
      BACKEND_ALERT_DELIVERY_AUTH_HEADER: undefined,
    });

    expect(health).toEqual({
      status: 'ok',
      configuredRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length,
      totalRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length,
      missing: [],
      invalid: [],
    });
  });

  it('fails closed for test payments or sandbox receipts in production', () => {
    const health = collectBackendEnvironmentHealth({
      ...COMPLETE_ENVIRONMENT,
      NODE_ENV: 'production',
      NEXT_PUBLIC_RAZORPAY_KEY_ID: 'rzp_test_accidental',
      MOBILE_COMMERCE_ALLOW_SANDBOX: '1',
    });

    expect(health.status).toBe('degraded');
    expect(health.missing).toEqual([]);
    expect(health.invalid).toEqual([
      'razorpay-live-mode',
      'mobile-commerce-sandbox-disabled',
    ]);
  });

  it('marks unconfigured RevenueCat settlement config invalid in production', () => {
    // Without the webhook token every store refund bounces on a 503 until
    // RevenueCat stops redelivering; without the API key no purchase can be
    // verified. Both must fail release verification, not merely read as a
    // missing capability.
    const health = collectBackendEnvironmentHealth({
      ...COMPLETE_ENVIRONMENT,
      NODE_ENV: 'production',
      REVENUECAT_WEBHOOK_AUTH_TOKEN: undefined,
      REVENUECAT_SECRET_API_KEY: '   ',
    });

    expect(health.status).toBe('degraded');
    expect(health.invalid).toEqual([
      'revenuecat-webhook-auth-unconfigured',
      'revenuecat-api-key-unconfigured',
    ]);
  });

  it('accepts the REST API key fallback for the production RevenueCat check', () => {
    const health = collectBackendEnvironmentHealth({
      ...COMPLETE_ENVIRONMENT,
      NODE_ENV: 'production',
      REVENUECAT_SECRET_API_KEY: undefined,
      REVENUECAT_REST_API_KEY: 'revenuecat-rest-key',
    });

    expect(health.invalid).toEqual([]);
  });

  it('rejects a non-signing identity secret', () => {
    const health = collectBackendEnvironmentHealth({
      ...COMPLETE_ENVIRONMENT,
      IDENTITY_ADMISSION_SECRET: 'too-short',
    });

    expect(health.status).toBe('degraded');
    expect(health.invalid).toEqual(['identity-admission-secret-too-short']);
  });

  it('documents every production-only secret in the environment template', () => {
    const template = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    const gitignore = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf8');

    expect(template).toContain('CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY=');
    expect(template).toContain('IDENTITY_ADMISSION_SECRET=');
    expect(template).toContain('CRON_SECRET=');
    expect(template).toContain('OPS_READ_SECRET=');
    expect(template).toContain('KIE_WEBHOOK_HMAC_KEY=');
    expect(template).toContain('KIE_PROVIDER_WEBHOOK_SECRET=');
    expect(template).toContain('KIE_PROVIDER_CALLBACK_URL=');
    expect(template).toContain('FEED_ANALYTICS_SALT=');
    expect(template).toContain('REVENUECAT_WEBHOOK_AUTH_TOKEN=');
    expect(template).toContain('REFERRAL_ATTRIBUTION_HASH_SECRET=');
    expect(template).toContain('APPLE_TEAM_ID=');
    expect(template).toContain('ANDROID_APP_SHA256_FINGERPRINTS=');
    expect(template).toContain('BACKEND_ALERT_DELIVERY_URL=');
    expect(template).toContain('BACKEND_ALERT_DELIVERY_AUTH_HEADER=');
    expect(gitignore).toContain('!.env.example');
  });

  it('documents optional backend budget guardrail thresholds in the environment template', () => {
    const template = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');

    expect(template).toContain('BACKEND_BUDGET_GENERATION_CREDITS_WARNING=');
    expect(template).toContain('BACKEND_BUDGET_AI_USAGE_CREDITS_WARNING=');
    expect(template).toContain('BACKEND_BUDGET_QUOTE_REQUESTS_WARNING=');
    expect(template).toContain('BACKEND_BUDGET_MEDIA_READS_WARNING=');
    expect(template).toContain('BACKEND_BUDGET_STORAGE_BYTES_WARNING=');
    expect(template).toContain('BACKEND_BUDGET_FAILED_PAID_GENERATION_CREDITS_DEGRADED=');
  });
});
