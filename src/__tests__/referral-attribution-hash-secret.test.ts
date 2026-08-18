import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVICE_ROLE_KEY = 'service-role-key-that-bypasses-every-rls-policy';
const SUBKEY_LABEL = 'magicbooklet/referral-attribution-hash/v1';

async function loadReferral() {
  return import('@/lib/referral');
}

describe('referral attribution hash secret', () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.REFERRAL_ATTRIBUTION_HASH_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.unstubAllEnvs();
  });

  it('signs with the dedicated secret when one is configured', async () => {
    process.env.REFERRAL_ATTRIBUTION_HASH_SECRET = 'dedicated-referral-secret';
    const { hashReferralRiskSignal } = await loadReferral();

    expect(hashReferralRiskSignal('ip:203.0.113.7')).toBe(
      createHmac('sha256', 'dedicated-referral-secret').update('ip:203.0.113.7').digest('hex'),
    );
  });

  it('ignores the service-role key entirely when the dedicated secret is set', async () => {
    process.env.REFERRAL_ATTRIBUTION_HASH_SECRET = 'dedicated-referral-secret';
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    const { hashReferralRiskSignal } = await loadReferral();

    expect(hashReferralRiskSignal('ip:203.0.113.7')).toBe(
      createHmac('sha256', 'dedicated-referral-secret').update('ip:203.0.113.7').digest('hex'),
    );
  });

  // The security property this fix exists for: when the fallback is in play the
  // service-role key must never itself be the HMAC secret, only the root of a
  // derived subkey.
  it('never uses the raw service-role key as the signing secret in the fallback', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    const { hashReferralRiskSignal } = await loadReferral();

    const digest = hashReferralRiskSignal('ip:203.0.113.7');
    const rawKeyDigest = createHmac('sha256', SERVICE_ROLE_KEY)
      .update('ip:203.0.113.7')
      .digest('hex');

    expect(digest).not.toBe(rawKeyDigest);
  });

  it('derives the fallback subkey by domain-separated HMAC of the service-role key', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    const { hashReferralRiskSignal } = await loadReferral();

    const expectedSubkey = createHmac('sha256', SERVICE_ROLE_KEY)
      .update(SUBKEY_LABEL)
      .digest('hex');

    expect(hashReferralRiskSignal('ip:203.0.113.7')).toBe(
      createHmac('sha256', expectedSubkey).update('ip:203.0.113.7').digest('hex'),
    );
  });

  it('produces a stable digest across repeated calls in the fallback', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    const { hashReferralRiskSignal } = await loadReferral();

    expect(hashReferralRiskSignal('ua:curl/8.4.0')).toBe(hashReferralRiskSignal('ua:curl/8.4.0'));
  });

  it('fails closed in production when neither secret is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { hashReferralRiskSignal } = await loadReferral();

    expect(() => hashReferralRiskSignal('ip:203.0.113.7')).toThrow(
      /REFERRAL_ATTRIBUTION_HASH_SECRET is not configured/,
    );
  });

  it('returns null for empty signals without touching the secret', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { hashReferralRiskSignal } = await loadReferral();

    expect(hashReferralRiskSignal(null)).toBeNull();
    expect(hashReferralRiskSignal('   ')).toBeNull();
  });
});
