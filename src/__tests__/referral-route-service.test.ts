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
    getUserById: vi.fn(),
    programQuery,
    rpc: vi.fn(),
  };
});

vi.mock('@/lib/backend-rate-limit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-rate-limit')>(),
  enforceBackendRateLimit: (...args: unknown[]) => mocks.enforceBackendRateLimit(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    rpc: mocks.rpc,
    from: mocks.from,
    auth: { admin: { getUserById: mocks.getUserById } },
  }),
  createUserClient: () => ({ auth: { getUser: mocks.getUser } }),
}));

import { deriveAccountIdentityFingerprints } from '@/lib/account-identity-fingerprint';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { hashReferralDevice } from '@/lib/referral-device';
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
const installationId = `fid_${'a'.repeat(64)}`;
// The account as the Auth admin API returns it: what its identity digests are made from.
const authUser = {
  id: 'user-1',
  email: 'new-friend@example.com',
  identities: [{ id: 'google-sub-1', provider: 'google', identity_data: { sub: 'google-sub-1' } }],
};

describe('referral API route service', () => {
  beforeEach(() => {
    mocks.enforceBackendRateLimit.mockReset();
    mocks.enforceBackendRateLimit.mockResolvedValue(undefined);
    mocks.getUser.mockReset();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mocks.getUserById.mockReset();
    mocks.getUserById.mockResolvedValue({ data: { user: authUser }, error: null });
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
        referral: { code, shortCode: 'K7P2QX', enabled: true },
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
      shortCode: 'K7P2QX',
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

  // It records the calling device, so a loop of made-up installation ids could
  // fill an account's device list (review of 2026-11-10).
  it('rate-limits the dashboard per account', async () => {
    mocks.enforceBackendRateLimit.mockRejectedValueOnce(new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 30,
      resetAt: '2026-11-10T10:10:00.000Z',
    }));
    const response = await getReferralOverviewResponse(new Request('https://magicbooklet.com/api/referrals/me', {
      headers: { Authorization: 'Bearer token' },
    }));

    expect(response.status).toBe(429);
    expect(mocks.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'referral-dashboard:read',
      key: 'user-1',
    }));
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_referral_dashboard', expect.anything());
  });

  // A link an operator switched off is a state, not an outage: the share links
  // remember "no invite" only on this code, and nothing is logged as an error.
  it('answers a switched-off link with 409 and its code, logging nothing', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'ready', code, enabled: false }, error: null });
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });
    try {
      const response = await createReferralLinkResponse(new Request('https://magicbooklet.com/api/referrals/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      }));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Your invite link is switched off.',
        code: 'REFERRAL_LINK_DISABLED',
      });
    } finally {
      restoreLogSink();
    }
    expect(logged).toEqual([]);

    // An RPC failure is still an outage.
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const failed = await createReferralLinkResponse(new Request('https://magicbooklet.com/api/referrals/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({}),
    }));
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.not.toHaveProperty('code');
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
        short_code: 'K7P2QX',
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
      shortCode: 'K7P2QX',
      preserved: false,
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
      p_kind: 'invite',
    }));
  });

  // A post or profile link that carried its sharer's invite says so, and an
  // invite link the visitor opens after it replaces it (create_referral_visit).
  it('passes on whether the visit came by a shared link, and says when an earlier invite is kept', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'preserved', code: 'earlier12', visit_token: visitToken, expires_at: '2026-08-11T10:00:00.000Z' },
      error: null,
    });
    const response = await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, source: 'web', kind: 'shared_link', next: '/showcase/post-1' }),
    }));

    await expect(response.json()).resolves.toMatchObject({ success: true, code: 'earlier12', preserved: true });
    expect(mocks.rpc).toHaveBeenCalledWith('create_referral_visit', expect.objectContaining({ p_kind: 'shared_link' }));

    // Anything else is an invite link.
    mocks.rpc.mockClear();
    await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, source: 'web', kind: 'something-else' }),
    }));
    expect(mocks.rpc).toHaveBeenCalledWith('create_referral_visit', expect.objectContaining({ p_kind: 'invite' }));
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
          short_code: endpoint.response.shortCode,
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

  // Owner, 2026-11-11: a code a person can say. What someone types at sign-up is
  // sent as kind `code`: the six-character code in any case, or a link code.
  it('records a typed six-character code in any case as a visit of kind code', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'created', code, short_code: 'K7P2QX', visit_token: visitToken, expires_at: '2026-08-11T10:00:00.000Z' },
      error: null,
    });
    const response = await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ' k7p2qx ', source: 'web', kind: 'code' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, code, shortCode: 'K7P2QX' });
    expect(mocks.rpc).toHaveBeenCalledWith('create_referral_visit', expect.objectContaining({
      p_code: 'K7P2QX',
      p_kind: 'code',
    }));
  });

  it('takes a link code typed as a code too, and refuses what can be neither', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'created', code, short_code: 'K7P2QX', visit_token: visitToken, expires_at: '2026-08-11T10:00:00.000Z' },
      error: null,
    });
    const typedLinkCode = await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.toUpperCase(), source: 'mobile', kind: 'code' }),
    }));
    expect(typedLinkCode.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('create_referral_visit', expect.objectContaining({ p_code: code, p_kind: 'code' }));

    mocks.rpc.mockClear();
    for (const typed of ['K7P2Q', 'ABCDE0', 'https://magicbooklet.com/r/abc']) {
      const refused = await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: typed, source: 'web', kind: 'code' }),
      }));
      expect(refused.status, typed).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalledWith('create_referral_visit', expect.anything());
  });

  it('answers an unknown typed code as not found', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'invalid_code' }, error: null });
    const response = await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZZ', source: 'web', kind: 'code' }),
    }));
    expect(response.status).toBe(404);
  });

  it('never reads a six-character code from an invite link or a shared link', async () => {
    mocks.rpc.mockClear();
    for (const kind of ['invite', 'shared_link']) {
      const response = await recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'K7P2QX', source: 'web', kind }),
      }));
      expect(response.status, kind).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalledWith('create_referral_visit', expect.anything());
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
    // The claim carries the account's identity digests: an identity that had an
    // account before is refused as not new (20261110070035).
    expect(mocks.getUserById).toHaveBeenCalledWith('user-1');
    expect(mocks.rpc).toHaveBeenCalledWith('claim_referral_visit', {
      p_invitee_user_id: 'user-1',
      p_visit_token: visitToken,
      p_identity_fingerprints: deriveAccountIdentityFingerprints(authUser as never),
      p_claim_device_hash: null,
    });
    expect(deriveAccountIdentityFingerprints(authUser as never)).toHaveLength(2);
  });

  // The guard compares the device that claims, not only the one that opened
  // the link: a visit scripted without a device and claimed on the inviter's
  // phone is caught there (review of 2026-11-10).
  it('passes the claiming installation to the guard', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'claimed', attribution_id: 'attribution-1' }, error: null });
    const installationId = `fid_${'c'.repeat(64)}`;
    await claimReferralResponse(new Request('https://magicbooklet.com/api/referrals/claim', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'x-magicbooklet-installation-id': installationId,
      },
      body: JSON.stringify({ visitToken }),
    }));

    expect(mocks.rpc).toHaveBeenCalledWith('claim_referral_visit', expect.objectContaining({
      p_claim_device_hash: hashReferralDevice(installationId),
    }));
  });

  // Letting the claim through unchecked made the re-registration guard a
  // single failed read away from nothing (review of 2026-11-10). The claim
  // waits: the app keeps its invite and asks again, the web keeps its cookie.
  it('defers the invite when the account cannot be read, and claims nothing', async () => {
    mocks.getUserById.mockResolvedValue({ data: { user: null }, error: { status: 503, message: 'auth unavailable' } });
    mocks.rpc.mockResolvedValue({ data: { status: 'claimed', attribution_id: 'attribution-1' }, error: null });
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      const response = await claimReferralResponse(new Request('https://magicbooklet.com/api/referrals/claim', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          Cookie: `mb_referral_visit=${visitToken}`,
        },
        body: JSON.stringify({ visitToken }),
      }));
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      restoreLogSink();
    }

    expect(logged.map((record) => record.msg)).toEqual(['referral_claim_failed']);
    expect(mocks.rpc).not.toHaveBeenCalledWith('claim_referral_visit', expect.anything());
  });

  it('tells a refused re-registration what a pre-existing account is told', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'existing_account' }, error: null });
    const response = await claimReferralResponse(new Request('https://magicbooklet.com/api/referrals/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitToken }),
    }));

    await expect(response.json()).resolves.toEqual({ success: true, claimed: false, reason: 'existing_account' });
  });

  // A blocked referral is the friend's invite all the same, but no bonus is on
  // its way: telling them it was applied promised one (review of 2026-11-10).
  // The reason stays the operator's.
  it('answers a claim the guard blocked as applied but on hold', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'claimed', attribution_id: 'attribution-1', reward_state: 'blocked' },
      error: null,
    });
    const response = await claimReferralResponse(new Request('https://magicbooklet.com/api/referrals/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitToken }),
    }));

    await expect(response.json()).resolves.toEqual({ success: true, claimed: true, held: true });
  });

  describe('the device a visit came from', () => {
    const created = {
      data: { status: 'created', code, visit_token: visitToken, expires_at: '2026-08-11T10:00:00.000Z' },
      error: null,
    };
    const visit = (headers: Record<string, string>, body: Record<string, unknown> = { code, source: 'web' }) =>
      recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }));
    const visitArguments = () => mocks.rpc.mock.calls.find(([name]) => name === 'create_referral_visit')?.[1];

    it('stores the digest of the installation an app visit names', async () => {
      mocks.rpc.mockResolvedValue(created);
      const response = await visit({}, { code, source: 'mobile', installationId });

      expect(response.status).toBe(200);
      expect(visitArguments()).toMatchObject({ p_channel: 'native', p_device_hash: hashReferralDevice(installationId) });
      // The app keeps no cookies: none is set for it.
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('stores the digest of the browser’s feed cookie', async () => {
      mocks.rpc.mockResolvedValue(created);
      await visit({ cookie: `__Host-magicbooklet-feed-id=${installationId}`, 'sec-fetch-site': 'same-origin' });

      expect(visitArguments()).toMatchObject({ p_device_hash: hashReferralDevice(installationId) });
    });

    it('gives a browser without one a feed cookie, and stores that device', async () => {
      mocks.rpc.mockResolvedValue(created);
      const response = await visit({ 'sec-fetch-site': 'same-origin' });

      const minted = /__Host-magicbooklet-feed-id=(fid_[a-f0-9]{64})/.exec(response.headers.get('set-cookie') ?? '')?.[1];
      expect(minted).toBeTruthy();
      expect(visitArguments()).toMatchObject({ p_device_hash: hashReferralDevice(minted!) });
      // Beside the attribution cookie, not in place of it.
      expect(response.headers.get('set-cookie')).toContain(`mb_referral_visit=${visitToken}`);
    });

    it('records a visit from a caller that names no device, with none', async () => {
      mocks.rpc.mockResolvedValue(created);
      await visit({});

      expect(visitArguments()).toMatchObject({ p_device_hash: null });
    });

    it('sets no device cookie on a visit that was refused', async () => {
      mocks.rpc.mockResolvedValue({ data: { status: 'invalid_code' }, error: null });
      const response = await visit({ 'sec-fetch-site': 'same-origin' });

      expect(response.status).toBe(404);
      expect(response.headers.get('set-cookie')).toBeNull();
    });
  });

  // A visit sets a cookie that credits a later sign-up in that browser to an
  // inviter. A form posted from another site needs no CORS grant, so until the
  // route asked where a request came from, another site could plant one.
  describe('where a visit may come from', () => {
    const visit = (headers: Record<string, string>) =>
      recordReferralVisitResponse(new Request('https://magicbooklet.com/api/referrals/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...headers },
        body: JSON.stringify({ code, source: 'web' }),
      }));

    it.each([
      ['a page of another site', { 'sec-fetch-site': 'cross-site' }],
      ['an older browser on another site', { origin: 'https://attacker.example' }],
      ['an opaque origin', { origin: 'null' }],
    ])('refuses %s before anything is read or written', async (_name, headers) => {
      const response = await visit(headers as Record<string, string>);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ success: false, error: 'Open this invite on Magicbooklet.' });
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(mocks.enforceBackendRateLimit).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it.each([
      ['a page of this site', { 'sec-fetch-site': 'same-origin', origin: 'https://magicbooklet.com' }],
      ['a subdomain of this site', { 'sec-fetch-site': 'same-site', origin: 'https://www.magicbooklet.com' }],
      ['an older browser on this site', { origin: 'https://magicbooklet.com' }],
      ['the app, which names no origin', {}],
    ])('takes a visit from %s', async (_name, headers) => {
      mocks.rpc.mockResolvedValue({
        data: { status: 'created', code, visit_token: visitToken, expires_at: '2026-08-11T10:00:00.000Z' },
        error: null,
      });

      expect((await visit(headers as Record<string, string>)).status).toBe(200);
    });
  });

  describe('the devices an account uses the program from', () => {
    const dashboard = {
      status: 'ready',
      offer: { inviterRewardBps: 500, inviteeRewardBps: 500, attributionWindowDays: 30 },
      referral: { code, enabled: true },
      stats: { visits: 0, referredUsers: 0, purchasers: 0, earnedCredits: 0, reversedCredits: 0 },
      recentRewards: [],
    };
    const answer = (recordError: unknown = null) => (name: string) => {
      if (name === 'record_referral_account_device') return Promise.resolve({ data: null, error: recordError });
      if (name === 'get_referral_dashboard') return Promise.resolve({ data: dashboard, error: null });
      return Promise.resolve({ data: { status: 'ready', code, enabled: true }, error: null });
    };
    const overview = (headers: Record<string, string> = {}) =>
      getReferralOverviewResponse(new Request('https://magicbooklet.com/api/referrals/me', {
        headers: { Authorization: 'Bearer token', ...headers },
      }));
    const link = (headers: Record<string, string> = {}) =>
      createReferralLinkResponse(new Request('https://magicbooklet.com/api/referrals/link', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({}),
      }));
    const recorded = () => mocks.rpc.mock.calls.filter(([name]) => name === 'record_referral_account_device');

    it.each([['the dashboard', overview], ['a new link', link]])('remembers the app installation %s was asked from', async (_name, call) => {
      mocks.rpc.mockImplementation(answer());
      const response = await call({ 'x-magicbooklet-installation-id': installationId });

      expect(response.status).toBe(200);
      expect(recorded()).toEqual([['record_referral_account_device', {
        p_user_id: 'user-1',
        p_device_hash: hashReferralDevice(installationId),
        p_ip_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }]]);
    });

    it('gives a signed-in browser a feed cookie and remembers it', async () => {
      mocks.rpc.mockImplementation(answer());
      const response = await overview({ 'sec-fetch-site': 'same-origin' });

      const minted = /__Host-magicbooklet-feed-id=(fid_[a-f0-9]{64})/.exec(response.headers.get('set-cookie') ?? '')?.[1];
      expect(minted).toBeTruthy();
      expect(recorded()[0][1]).toMatchObject({ p_device_hash: hashReferralDevice(minted!) });
    });

    it('records nothing for a request that names no device', async () => {
      mocks.rpc.mockImplementation(answer());
      await overview();
      await link();

      expect(recorded()).toEqual([]);
    });

    it('answers as usual when the device cannot be recorded', async () => {
      mocks.rpc.mockImplementation(answer({ message: 'device table unavailable' }));
      const logged: BackendLogRecord[] = [];
      const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

      try {
        const response = await link({ 'x-magicbooklet-installation-id': installationId });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ success: true, code });
      } finally {
        restoreLogSink();
      }

      expect(logged.map((record) => record.msg)).toEqual(['referral_account_device_not_recorded']);
    });

    it('never records a device for a caller it has not admitted', async () => {
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
      mocks.rpc.mockImplementation(answer());

      expect((await overview({ 'x-magicbooklet-installation-id': installationId })).status).toBe(401);
      expect((await link({ 'x-magicbooklet-installation-id': installationId })).status).toBe(401);
      expect(mocks.rpc).not.toHaveBeenCalled();
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
