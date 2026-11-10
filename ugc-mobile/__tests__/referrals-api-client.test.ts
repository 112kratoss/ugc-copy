import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../lib/api-client';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('mobile referral API client', () => {
  it('uses the referral contracts and keeps visit recording anonymous', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        program: { inviterPercent: 5, inviteeFirstPurchasePercent: 5, attributionWindowDays: 30 },
        code: null,
        shareUrl: null,
        stats: { visits: 0, signups: 0, purchasers: 0, creditsEarned: 0, creditsReversed: 0 },
        recentRewards: [],
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, code: 'abc-123', shareUrl: 'https://magicbooklet.com/r/abc-123' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, code: 'abc-123', visitToken: 'visit-1', expiresAt: '2026-08-01T00:00:00Z' }))
      .mockResolvedValueOnce(jsonResponse({ success: true, claimed: true }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'access-token',
      getInstallationId: async () => 'fid_device-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getReferralOverview();
    await api.createReferralLink({ next: '/create-image' });
    await api.recordReferralVisit({ code: 'abc-123', source: 'mobile' });
    await api.claimReferral({ code: 'abc-123', visitToken: 'visit-1' });

    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('https://magicbooklet.test/api/referrals/me');
    expect((calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer access-token');
    expect(calls[1][0]).toBe('https://magicbooklet.test/api/referrals/link');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ next: '/create-image' });
    expect(calls[2][0]).toBe('https://magicbooklet.test/api/referrals/visit');
    expect(JSON.parse(String(calls[2][1].body))).toEqual({
      code: 'abc-123',
      source: 'mobile',
      installationId: 'fid_device-1',
    });
    expect((calls[2][1].headers as Headers).has('Authorization')).toBe(false);
    expect(calls[3][0]).toBe('https://magicbooklet.test/api/referrals/claim');
    expect(JSON.parse(String(calls[3][1].body))).toEqual({ code: 'abc-123', visitToken: 'visit-1' });
    expect((calls[3][1].headers as Headers).get('Authorization')).toBe('Bearer access-token');
  });

  // The referral abuse guard compares the device an invite is made, opened and
  // claimed on. The visit has always named it in its body; the other three
  // routes name it in the header the feed already carries.
  it('names the installation on every Invite & Earn request, and on no other account request', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'access-token',
      getInstallationId: async () => 'fid_device-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getReferralOverview();
    await api.createReferralLink();
    await api.recordReferralVisit({ code: 'abc-123', source: 'mobile' });
    await api.claimReferral({ code: 'abc-123', visitToken: 'visit-1' });
    await api.getProfile();

    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    const header = (index: number) => (calls[index][1].headers as Headers).get('x-magicbooklet-installation-id');
    expect(calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/referrals/me',
      '/api/referrals/link',
      '/api/referrals/visit',
      '/api/referrals/claim',
      '/api/profile',
    ]);
    expect([header(0), header(1), header(2), header(3)]).toEqual(['fid_device-1', 'fid_device-1', 'fid_device-1', 'fid_device-1']);
    expect(header(4)).toBeNull();
  });

  it('sends the request without the header when the phone has no installation id to give', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, code: 'abc-123', shareUrl: 'https://magicbooklet.com/r/abc-123' }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'access-token',
      getInstallationId: async () => { throw new Error('storage unavailable'); },
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(api.createReferralLink()).resolves.toMatchObject({ code: 'abc-123' });

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).has('x-magicbooklet-installation-id')).toBe(false);
  });
});
