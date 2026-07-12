import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceBackendRateLimit: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/backend-rate-limit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-rate-limit')>(),
  enforceBackendRateLimit: (...args: unknown[]) => mocks.enforceBackendRateLimit(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ rpc: mocks.rpc }),
  createUserClient: () => ({ auth: { getUser: mocks.getUser } }),
}));

import {
  claimReferralResponse,
  createReferralLinkResponse,
  getReferralOverviewResponse,
  recordReferralVisitResponse,
} from '@/lib/referral-route-service';

const code = 'a1b2c3d4e5f6';
const visitToken = '123e4567-e89b-42d3-a456-426614174000';

describe('referral API route service', () => {
  beforeEach(() => {
    mocks.enforceBackendRateLimit.mockReset();
    mocks.enforceBackendRateLimit.mockResolvedValue(undefined);
    mocks.getUser.mockReset();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mocks.rpc.mockReset();
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    process.env.REFERRAL_ATTRIBUTION_HASH_SECRET = 'test-referral-hash-secret';
  });

  it('normalizes the referral dashboard into the shared web/mobile contract', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        status: 'ready',
        offer: {
          inviterRewardBps: 500,
          inviteeRewardBps: 500,
          attributionWindowDays: 30,
        },
        referral: { code, enabled: true },
        stats: {
          visits: 12,
          referredUsers: 4,
          purchasers: 2,
          earnedCredits: 75,
          reversedCredits: 5,
        },
        recentRewards: [{
          id: 'ledger-1',
          kind: 'inviter_purchase',
          entryKind: 'reward_reversal',
          creditDelta: -5,
          createdAt: '2026-07-12T10:00:00.000Z',
        }],
      },
      error: null,
    });

    const response = await getReferralOverviewResponse(new Request('https://magicbooklet.com/api/referrals/me', {
      headers: { Authorization: 'Bearer token' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      program: {
        inviterPercent: 5,
        inviteeFirstPurchasePercent: 5,
        attributionWindowDays: 30,
      },
      code,
      shareUrl: `https://magicbooklet.com/r/${code}`,
      stats: {
        visits: 12,
        signups: 4,
        purchasers: 2,
        creditsEarned: 75,
        creditsReversed: 5,
      },
      recentRewards: [{
        id: 'ledger-1',
        credits: 5,
        status: 'reversed',
        kind: 'inviter_purchase',
        createdAt: '2026-07-12T10:00:00.000Z',
      }],
    });
  });

  it('creates immutable share links with a safe destination', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'ready', code, enabled: true }, error: null });
    const response = await createReferralLinkResponse(new Request('https://magicbooklet.com/api/referrals/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ next: '/create/video?model=kling' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      code,
      shareUrl: `https://magicbooklet.com/r/${code}?next=%2Fcreate%2Fvideo%3Fmodel%3Dkling`,
    });
  });

  it('records a first-touch web visit and sets the secure attribution cookie', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        status: 'created',
        code,
        visit_token: visitToken,
        expires_at: '2026-08-11T10:00:00.000Z',
      },
      error: null,
    });
    const response = await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'user-agent': 'test-browser' },
      body: JSON.stringify({ code, source: 'web', next: '/create' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(`mb_referral_visit=${visitToken}`);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
    expect(mocks.rpc).toHaveBeenCalledWith('create_referral_visit', expect.objectContaining({
      p_channel: 'web',
      p_code: code,
      p_existing_visit_token: null,
    }));
  });

  it('claims the signed visit for the authenticated new account and clears the cookie', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'claimed', attribution_id: 'attribution-1' }, error: null });
    const response = await claimReferralResponse(new Request('https://magicbooklet.com/api/referrals/claim', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        Cookie: `mb_referral_visit=${visitToken}`,
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, claimed: true });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mocks.rpc).toHaveBeenCalledWith('claim_referral_visit', {
      p_invitee_user_id: 'user-1',
      p_visit_token: visitToken,
    });
  });

  it('requires a server-issued visit token instead of accepting a post-signup code', async () => {
    const response = await claimReferralResponse(new Request('https://magicbooklet.com/api/referrals/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
