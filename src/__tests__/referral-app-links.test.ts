import { afterEach, describe, expect, it, vi } from 'vitest';

import { UNIVERSAL_LINK_PATHS } from '@/lib/app-links';

describe('verified app-link association files', () => {
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
        details: [{
          appID: 'TEAM123456.com.magicbooklet.mobile',
          paths: [...UNIVERSAL_LINK_PATHS],
        }],
      },
    });
  });

  it('claims the post and creator paths, so a shared link opens the app', async () => {
    // Without these, every shared post or profile link dumps an installed user
    // into mobile Safari -- the whole social loop leaks out of the product.
    process.env.APPLE_TEAM_ID = 'TEAM123456';
    const { GET } = await import('@/app/.well-known/apple-app-site-association/route');
    const body = await GET().json() as { applinks: { details: { paths: string[] }[] } };

    expect(body.applinks.details[0].paths).toEqual(
      expect.arrayContaining(['/r/*', '/showcase/*', '/creators/*']),
    );
  });

  it('serves no association at all when the team id is unset', async () => {
    // A details entry with a malformed appID is worse than none: iOS caches it.
    const { GET } = await import('@/app/.well-known/apple-app-site-association/route');
    const body = await GET().json() as { applinks: { details: unknown[] } };

    expect(body.applinks.details).toEqual([]);
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
