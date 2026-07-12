import { afterEach, describe, expect, it, vi } from 'vitest';

describe('referral verified app-link association files', () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.APPLE_TEAM_ID;
    delete process.env.IOS_BUNDLE_ID;
    delete process.env.ANDROID_APP_SHA256_FINGERPRINTS;
    delete process.env.ANDROID_PACKAGE_NAME;
  });

  it('serves the Apple association without redirects', async () => {
    process.env.APPLE_TEAM_ID = 'TEAM123456';
    process.env.IOS_BUNDLE_ID = 'com.magicbooklet.mobile';
    const { GET } = await import('@/app/.well-known/apple-app-site-association/route');
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      applinks: {
        apps: [],
        details: [{ appID: 'TEAM123456.com.magicbooklet.mobile', paths: ['/r/*'] }],
      },
    });
  });

  it('serves only valid Android signing fingerprints', async () => {
    const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':').toUpperCase();
    process.env.ANDROID_APP_SHA256_FINGERPRINTS = `${fingerprint},invalid`;
    const { GET } = await import('@/app/.well-known/assetlinks.json/route');
    const response = GET();

    await expect(response.json()).resolves.toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.magicbooklet.mobile',
        sha256_cert_fingerprints: [fingerprint],
      },
    }]);
  });
});
