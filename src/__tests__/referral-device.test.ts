import { NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';

import { applyReferralDeviceCookie, hashReferralDevice, resolveReferralDevice } from '@/lib/referral-device';

const FID = `fid_${'a'.repeat(64)}`;
const OTHER_FID = `fid_${'b'.repeat(64)}`;
// The vector `referral_device_hash()` is held to in
// supabase/tests/database/referral_abuse_guard.test.sql. The guard compares a
// digest made here with one made there, so the two must never part.
const FID_HASH = '0b1a0e16d16cdf199bedd04aad6ba553e386be0f628030d83a418ffd44d78985';

function request(headers: Record<string, string> = {}) {
  return new Request('https://magicbooklet.com/api/referrals/visit', { method: 'POST', headers });
}

describe('the device a referral request came from', () => {
  it('digests an installation id exactly as the database does', () => {
    expect(hashReferralDevice(FID)).toBe(FID_HASH);
    expect(hashReferralDevice(OTHER_FID)).not.toBe(FID_HASH);
  });

  it('reads the app’s installation id from its header, ahead of anything else', () => {
    expect(resolveReferralDevice(
      request({ 'x-magicbooklet-installation-id': FID, cookie: `__Host-magicbooklet-feed-id=${OTHER_FID}` }),
      { bodyInstallationId: OTHER_FID },
    )).toEqual({ deviceHash: FID_HASH, cookieValueToSet: null });
  });

  it('reads the id an app visit carries in its body', () => {
    expect(resolveReferralDevice(request(), { bodyInstallationId: FID }))
      .toEqual({ deviceHash: FID_HASH, cookieValueToSet: null });
  });

  it('reads the browser’s feed cookie', () => {
    expect(resolveReferralDevice(request({ cookie: `theme=dark; __Host-magicbooklet-feed-id=${FID}` })))
      .toEqual({ deviceHash: FID_HASH, cookieValueToSet: null });
  });

  it.each([
    ['a malformed header', { 'x-magicbooklet-installation-id': 'fid_short' }, undefined],
    ['a malformed body id', {}, 'not-an-id'],
    ['a body id that is not text', {}, 42],
    ['a malformed cookie', { cookie: '__Host-magicbooklet-feed-id=%E0%A4%A' }, undefined],
  ])('takes %s for no device', (_name, headers, bodyInstallationId) => {
    expect(resolveReferralDevice(request(headers as Record<string, string>), { bodyInstallationId }))
      .toEqual({ deviceHash: null, cookieValueToSet: null });
  });

  it('gives a browser with no feed cookie one, on a fetch from a page of this site', () => {
    const device = resolveReferralDevice(request({ 'sec-fetch-site': 'same-origin' }));

    expect(device.cookieValueToSet).toMatch(/^fid_[a-f0-9]{64}$/);
    expect(device.deviceHash).toBe(hashReferralDevice(device.cookieValueToSet!));
    // Each browser gets its own.
    expect(resolveReferralDevice(request({ 'sec-fetch-site': 'same-origin' })).cookieValueToSet)
      .not.toBe(device.cookieValueToSet);
  });

  it.each([
    ['a caller that says nothing about where it is', {}],
    ['a page of another site', { 'sec-fetch-site': 'cross-site' }],
  ])('mints nothing for %s: it would look like a new device on every request', (_name, headers) => {
    expect(resolveReferralDevice(request(headers as Record<string, string>)))
      .toEqual({ deviceHash: null, cookieValueToSet: null });
  });

  it('sets the minted id as the feed route sets its cookie, and nothing when none was minted', () => {
    const minted = NextResponse.json({});
    applyReferralDeviceCookie(minted, { deviceHash: FID_HASH, cookieValueToSet: FID });
    const cookie = minted.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`__Host-magicbooklet-feed-id=${FID}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${180 * 24 * 60 * 60}`);

    const known = NextResponse.json({});
    applyReferralDeviceCookie(known, { deviceHash: FID_HASH, cookieValueToSet: null });
    expect(known.headers.get('set-cookie')).toBeNull();
  });
});
