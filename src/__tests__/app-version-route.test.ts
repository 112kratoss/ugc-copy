import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/api/app-version route', () => {
  it('publishes the stable mobile compatibility policy without caching', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'build-123');
    vi.stubEnv('MOBILE_CRITICAL_UPDATE_RUNTIME', '');
    vi.stubEnv('MOBILE_CRITICAL_UPDATE_AFTER', '');
    const { GET } = await import('@/app/api/app-version/route');

    const response = await GET(new Request('http://localhost/api/app-version'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    await expect(response.json()).resolves.toEqual({
      buildId: 'build-123',
      mobileCompatibility: {
        currentApiVersion: 1,
        minimumApiVersion: 1,
        minimumAppVersion: '0.1.7',
        supportedCatalogSchemaVersions: [1, 2, 3],
        unversionedClientsUseApiVersion: 1,
      },
      criticalUpdate: null,
    });
  });

  it('reads the critical-update lever from the deployment environment', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'build-123');
    vi.stubEnv(
      'MOBILE_CRITICAL_UPDATE_RUNTIME',
      '02b8fe85566eac2e3f61a8ed82fa350c3ee03865,4babc8b439ba5309615abbbe59baf79a23014d6c',
    );
    vi.stubEnv('MOBILE_CRITICAL_UPDATE_AFTER', '2026-10-15T07:45:00Z');
    const { GET } = await import('@/app/api/app-version/route');

    const response = await GET(new Request('http://localhost/api/app-version'));

    await expect(response.json()).resolves.toMatchObject({
      criticalUpdate: {
        runtimeVersions: ['02b8fe85566eac2e3f61a8ed82fa350c3ee03865', '4babc8b439ba5309615abbbe59baf79a23014d6c'],
        publishedAfter: '2026-10-15T07:45:00.000Z',
      },
    });
  });
});
