import { describe, expect, it, vi } from 'vitest';

describe('/api/app-version route', () => {
  it('publishes the stable mobile compatibility policy without caching', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'build-123');
    const { GET } = await import('@/app/api/app-version/route');

    const response = await GET(new Request('http://localhost/api/app-version'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    await expect(response.json()).resolves.toEqual({
      buildId: 'build-123',
      mobileCompatibility: {
        currentApiVersion: 1,
        minimumApiVersion: 1,
        minimumAppVersion: '0.0.1',
        supportedCatalogSchemaVersions: [1],
        unversionedClientsUseApiVersion: 1,
      },
    });
  });
});
