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
        minimumAppVersion: '0.1.7',
        supportedCatalogSchemaVersions: [1, 2, 3],
        unversionedClientsUseApiVersion: 1,
      },
      criticalUpdate: null,
    });
  });

  // 04-9: the critical-update lever is set on the server, not in a manifest no
  // publish path can write. Both variables or nothing.
  async function criticalUpdateFor(environment: Record<string, string>) {
    const response = await getAppVersionRouteResponse({
      request: new Request('http://localhost/api/app-version'),
      environment: { VERCEL_GIT_COMMIT_SHA: 'commit-build-1', ...environment },
    });
    return ((await response.json()) as { criticalUpdate: unknown }).criticalUpdate;
  }

  it('flags updates for the listed runtimes published after an instant when both variables are set', async () => {
    // Both store runtimes, as a fix published to Android and iOS lists them;
    // spaces around an entry and empty entries are dropped.
    await expect(criticalUpdateFor({
      MOBILE_CRITICAL_UPDATE_RUNTIME: ' 02b8fe85566eac2e3f61a8ed82fa350c3ee03865 ,, 4babc8b439ba5309615abbbe59baf79a23014d6c,\n',
      MOBILE_CRITICAL_UPDATE_AFTER: '2026-10-15T07:40:00Z',
    })).resolves.toEqual({
      runtimeVersions: ['02b8fe85566eac2e3f61a8ed82fa350c3ee03865', '4babc8b439ba5309615abbbe59baf79a23014d6c'],
      publishedAfter: '2026-10-15T07:40:00.000Z',
    });
    // One runtime is a list of one. An offset is honoured and served as UTC, so
    // the app compares one instant.
    await expect(criticalUpdateFor({
      MOBILE_CRITICAL_UPDATE_RUNTIME: '0.1.8',
      MOBILE_CRITICAL_UPDATE_AFTER: '2026-10-15T13:10:00.250+05:30',
    })).resolves.toEqual({ runtimeVersions: ['0.1.8'], publishedAfter: '2026-10-15T07:40:00.250Z' });
  });

  it('serves no critical update when either variable is missing', async () => {
    await expect(criticalUpdateFor({
      MOBILE_CRITICAL_UPDATE_RUNTIME: '02b8fe85566eac2e3f61a8ed82fa350c3ee03865',
    })).resolves.toBeNull();
    await expect(criticalUpdateFor({
      MOBILE_CRITICAL_UPDATE_AFTER: '2026-10-15T07:40:00Z',
    })).resolves.toBeNull();
    // A list with nothing in it is a missing variable.
    for (const runtimes of ['   ', ',', ' , ,\n']) {
      await expect(criticalUpdateFor({
        MOBILE_CRITICAL_UPDATE_RUNTIME: runtimes,
        MOBILE_CRITICAL_UPDATE_AFTER: '2026-10-15T07:40:00Z',
      })).resolves.toBeNull();
    }
  });

  it.each([
    ['not a date', 'yesterday'],
    ['a date without a time', '2026-10-15'],
    ['a time without an offset', '2026-10-15T07:40:00'],
    ['an impossible month', '2026-13-01T00:00:00Z'],
  ])('serves no critical update for %s', async (_case, publishedAfter) => {
    await expect(criticalUpdateFor({
      MOBILE_CRITICAL_UPDATE_RUNTIME: '02b8fe85566eac2e3f61a8ed82fa350c3ee03865',
      MOBILE_CRITICAL_UPDATE_AFTER: publishedAfter,
    })).resolves.toBeNull();
  });

  it('serves no critical update when any listed runtime is malformed', async () => {
    for (const runtimes of [
      'android 02b8fe85',
      '-02b8fe85',
      '02b8fe85 4babc8b4',
      // One bad entry voids the list rather than flagging only the other platform.
      '02b8fe85566eac2e3f61a8ed82fa350c3ee03865, ios 4babc8b439ba5309615abbbe59baf79a23014d6c',
    ]) {
      await expect(criticalUpdateFor({
        MOBILE_CRITICAL_UPDATE_RUNTIME: runtimes,
        MOBILE_CRITICAL_UPDATE_AFTER: '2026-10-15T07:40:00Z',
      })).resolves.toBeNull();
    }
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
