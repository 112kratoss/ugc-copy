import { describe, expect, it } from 'vitest';

import { getAppVersionRouteResponse } from '@/lib/app-version-route-adapter-service';

describe('app version route adapter service', () => {
  it('returns the mobile compatibility policy with no-store and request id headers', async () => {
    const response = await getAppVersionRouteResponse({
      request: new Request('http://localhost/api/app-version', {
        headers: { 'x-request-id': 'app-version-adapter-1' },
      }),
      environment: {
        VERCEL_GIT_COMMIT_SHA: 'commit-build-1',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(response.headers.get('x-request-id')).toBe('app-version-adapter-1');
    await expect(response.json()).resolves.toEqual({
      buildId: 'commit-build-1',
      mobileCompatibility: {
        currentApiVersion: 1,
        minimumApiVersion: 1,
        minimumAppVersion: '0.0.1',
        supportedCatalogSchemaVersions: [1, 2],
        unversionedClientsUseApiVersion: 1,
      },
    });
  });

  it('falls back through deployment metadata before using the local development id', async () => {
    const releaseResponse = await getAppVersionRouteResponse({
      request: new Request('http://localhost/api/app-version'),
      environment: {
        RELEASE_GIT_SHA: 'release-commit-1',
        VERCEL_GIT_COMMIT_SHA: 'git-commit-ignored',
      },
    });
    await expect(releaseResponse.json()).resolves.toMatchObject({
      buildId: 'release-commit-1',
    });

    const deploymentIdResponse = await getAppVersionRouteResponse({
      request: new Request('http://localhost/api/app-version'),
      environment: {
        VERCEL_GIT_COMMIT_SHA: ' ',
        VERCEL_DEPLOYMENT_ID: 'deployment-123',
        VERCEL_URL: 'app.example.com',
      },
    });
    await expect(deploymentIdResponse.json()).resolves.toMatchObject({
      buildId: 'deployment-123',
    });

    const deploymentUrlResponse = await getAppVersionRouteResponse({
      request: new Request('http://localhost/api/app-version'),
      environment: {
        VERCEL_GIT_COMMIT_SHA: '',
        VERCEL_DEPLOYMENT_ID: '',
        VERCEL_URL: 'app.example.com',
      },
    });
    await expect(deploymentUrlResponse.json()).resolves.toMatchObject({
      buildId: 'app.example.com',
    });

    const devResponse = await getAppVersionRouteResponse({
      request: new Request('http://localhost/api/app-version'),
      environment: {},
    });
    await expect(devResponse.json()).resolves.toMatchObject({
      buildId: 'dev',
    });
  });
});
