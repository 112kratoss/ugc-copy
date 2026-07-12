import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BACKEND_ENVIRONMENT_REQUIREMENTS,
  collectBackendEnvironmentHealth,
} from '@/lib/backend-environment';

const COMPLETE_ENVIRONMENT = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  NEXT_PUBLIC_SITE_URL: 'https://magicbooklet.com',
  CRON_SECRET: 'cron-secret',
  OPS_READ_SECRET: 'ops-read-secret',
  KIE_AI_API_KEY: 'kie-key',
  KIE_WEBHOOK_HMAC_KEY: 'kie-webhook-key',
  NEXT_PUBLIC_RAZORPAY_KEY_ID: 'rzp-key',
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
    });
  });

  it('documents every production-only secret in the environment template', () => {
    const template = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    const gitignore = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf8');

    expect(template).toContain('CRON_SECRET=');
    expect(template).toContain('OPS_READ_SECRET=');
    expect(template).toContain('KIE_WEBHOOK_HMAC_KEY=');
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
