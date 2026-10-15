import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const mocks = vi.hoisted(() => {
  const programQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
  };
  return {
    enforceBackendRateLimit: vi.fn(),
    from: vi.fn(),
    getUser: vi.fn(),
    programQuery,
    rpc: vi.fn(),
  };
});

vi.mock('@/lib/backend-rate-limit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-rate-limit')>(),
  enforceBackendRateLimit: (...args: unknown[]) => mocks.enforceBackendRateLimit(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ rpc: mocks.rpc, from: mocks.from }),
  createUserClient: () => ({ auth: { getUser: mocks.getUser } }),
}));

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  claimReferralResponse,
  createReferralLinkResponse,
  getReferralOverviewResponse,
  loadReferralProgramTerms,
  recordReferralVisitResponse,
  resetReferralProgramTermsCacheForTests,
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
    mocks.from.mockReset();
    mocks.from.mockReturnValue(mocks.programQuery);
    for (const step of ['select', 'eq', 'order', 'limit'] as const) {
      mocks.programQuery[step].mockReset();
      mocks.programQuery[step].mockReturnValue(mocks.programQuery);
    }
    mocks.programQuery.maybeSingle.mockReset();
    mocks.programQuery.maybeSingle.mockResolvedValue({
      data: { inviter_reward_bps: 500, invitee_reward_bps: 500, attribution_window_days: 30 },
      error: null,
    });
    resetReferralProgramTermsCacheForTests();
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    process.env.REFERRAL_ATTRIBUTION_HASH_SECRET = 'test-referral-hash-secret';
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await expect(response.json()).resolves.toEqual({
      success: true,
      visitToken,
      code,
      expiresAt: '2026-08-11T10:00:00.000Z',
      // The same terms /api/referrals/me carries, for a visitor with no account.
      program: { inviterPercent: 5, inviteeFirstPurchasePercent: 5, attributionWindowDays: 30 },
    });
    expect(response.headers.get('set-cookie')).toContain(`mb_referral_visit=${visitToken}`);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
    expect(mocks.rpc).toHaveBeenCalledWith('create_referral_visit', expect.objectContaining({
      p_channel: 'web',
      p_code: code,
      p_existing_visit_token: null,
    }));
  });

  // 03-7: the landing pages printed 5 % and 30 days of their own. The visit
  // answer is the shared fixture's, terms included, and says null when there
  // are none to show.
  it('answers a referral visit in the shapes the shared fixture pins', async () => {
    const endpoint = mobileApiContract.endpoints.recordReferralVisit;
    const visit = async () => {
      mocks.rpc.mockResolvedValueOnce({
        data: {
          status: 'created',
          code: endpoint.response.code,
          visit_token: endpoint.response.visitToken,
          expires_at: endpoint.response.expiresAt,
        },
        error: null,
      });
      const response = await recordReferralVisitResponse(new Request(`https://magicbooklet.com${endpoint.path}`, {
        method: endpoint.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(endpoint.request),
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
      return response.json();
    };

    await expect(visit()).resolves.toEqual(endpoint.response);

    resetReferralProgramTermsCacheForTests();
    mocks.programQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(visit()).resolves.toEqual(endpoint.responseVariants.programUnavailable);
  });

  it('reads the terms of the program a new visit binds to, and keeps them for five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T06:00:00.000Z'));

    await expect(loadReferralProgramTerms()).resolves.toEqual({
      inviterPercent: 5,
      inviteeFirstPurchasePercent: 5,
      attributionWindowDays: 30,
    });
    expect(mocks.from).toHaveBeenCalledWith('referral_programs');
    expect(mocks.programQuery.select).toHaveBeenCalledWith('inviter_reward_bps, invitee_reward_bps, attribution_window_days');
    expect(mocks.programQuery.eq).toHaveBeenCalledWith('status', 'active');
    expect(mocks.programQuery.order).toHaveBeenCalledWith('version', { ascending: false });
    expect(mocks.programQuery.limit).toHaveBeenCalledWith(1);

    mocks.programQuery.maybeSingle.mockResolvedValue({
      data: { inviter_reward_bps: 750, invitee_reward_bps: 250, attribution_window_days: 45 },
      error: null,
    });
    vi.setSystemTime(new Date('2026-10-15T06:04:59.000Z'));
    await expect(loadReferralProgramTerms()).resolves.toMatchObject({ inviterPercent: 5 });
    expect(mocks.programQuery.maybeSingle).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-15T06:05:01.000Z'));
    await expect(loadReferralProgramTerms()).resolves.toEqual({
      inviterPercent: 7.5,
      inviteeFirstPurchasePercent: 2.5,
      attributionWindowDays: 45,
    });
    expect(mocks.programQuery.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('shares one read between callers that ask at once', async () => {
    const [first, second] = await Promise.all([loadReferralProgramTerms(), loadReferralProgramTerms()]);

    expect(first).toEqual(second);
    expect(mocks.programQuery.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('has no terms while no program is active', async () => {
    mocks.programQuery.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(loadReferralProgramTerms()).resolves.toBeNull();
    await expect(loadReferralProgramTerms()).resolves.toBeNull();
    expect(mocks.programQuery.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('logs a failed read, answers null, and reads again on the next request', async () => {
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });
    mocks.programQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });

    try {
      await expect(loadReferralProgramTerms()).resolves.toBeNull();
    } finally {
      restoreLogSink();
    }

    expect(logged.map((record) => record.msg)).toEqual(['referral_program_terms_unavailable']);
    await expect(loadReferralProgramTerms()).resolves.toMatchObject({ inviterPercent: 5 });
    expect(mocks.programQuery.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('still saves the visit when the terms cannot be read', async () => {
    mocks.programQuery.maybeSingle.mockRejectedValueOnce(new Error('network down'));
    mocks.rpc.mockResolvedValue({
      data: { status: 'preserved', code, visit_token: visitToken, expires_at: '2026-08-11T10:00:00.000Z' },
      error: null,
    });
    const restoreLogSink = setBackendLogSink(() => undefined);

    try {
      const response = await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, source: 'mobile' }),
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ success: true, visitToken, program: null });
    } finally {
      restoreLogSink();
    }
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
