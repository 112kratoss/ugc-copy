import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { isMobileCorsPath, isRootAuthCodeRedirect, proxy } from '@/proxy';
import mobileApiOperationsV1 from '../../contracts/mobile-api-operations-v1.json';

function materializeRouteTemplate(template: string) {
  return template
    .replace(':generationId', 'generation-1')
    .replace(':postId', 'post-1')
    .replace(':username', 'creator-one')
    .replace(':slug', 'product-reveal')
    .replace(':templateId', 'template-1')
    .replace(':runId', 'run-1')
    .replace(':stepId', 'step-1')
    .replace(':resourceId', 'resource-1');
}

describe('mobile API CORS proxy', () => {
  it('matches mobile API paths without opening unrelated APIs', () => {
    expect(isMobileCorsPath('/api/generation-models')).toBe(true);
    expect(isMobileCorsPath('/api/generation-models/quote')).toBe(true);
    expect(isMobileCorsPath('/api/app-version')).toBe(true);
    expect(isMobileCorsPath('/api/enhance-prompt')).toBe(true);
    expect(isMobileCorsPath('/api/uploads/media/sign')).toBe(true);
    expect(isMobileCorsPath('/api/uploads/media/read-url')).toBe(true);
    expect(isMobileCorsPath('/api/profile/media/sign')).toBe(true);
    expect(isMobileCorsPath('/api/profile/share')).toBe(true);
    expect(isMobileCorsPath('/api/marketplace/resources')).toBe(true);
    expect(isMobileCorsPath('/api/marketplace/resources/bundle-1')).toBe(true);
    expect(isMobileCorsPath('/api/showcase/feed')).toBe(true);
    expect(isMobileCorsPath('/api/showcase/saved-media')).toBe(true);
    expect(isMobileCorsPath('/api/mobile/notifications/preferences')).toBe(true);
    expect(isMobileCorsPath('/api/source-tools')).toBe(true);
    expect(isMobileCorsPath('/api/uploads/workflow-asset/sign')).toBe(false);
    expect(isMobileCorsPath('/api/razorpay/webhook')).toBe(false);
  });

  it('covers every route in the shared mobile operation registry', () => {
    const routes = [
      ...Object.values(mobileApiOperationsV1.operations),
      ...mobileApiOperationsV1.fallbackRoutes,
    ];
    expect(routes.every((route) => isMobileCorsPath(materializeRouteTemplate(route.path)))).toBe(true);
  });

  it('answers a valid preflight for every registered mobile route', async () => {
    const paths = new Set([
      ...Object.values(mobileApiOperationsV1.operations),
      ...mobileApiOperationsV1.fallbackRoutes,
    ].map((route) => materializeRouteTemplate(route.path)));

    for (const pathname of paths) {
      const response = await proxy(new NextRequest(`http://localhost${pathname}`, {
        headers: {
          'Access-Control-Request-Headers': 'Authorization',
          'Access-Control-Request-Method': 'POST',
          Origin: 'http://localhost:8082',
        },
        method: 'OPTIONS',
      }));
      expect(response.status, pathname).toBe(204);
      // Localhost is reflected outside production so the Expo web build and the
      // dev server keep working; it is never a blanket wildcard.
      expect(response.headers.get('Access-Control-Allow-Origin'), pathname)
        .toBe('http://localhost:8082');
    }
  });

  it('answers mobile API preflight requests', async () => {
    const response = await proxy(
      new NextRequest('http://localhost/api/marketplace/resources', {
        headers: {
          'Access-Control-Request-Headers': 'Authorization',
          'Access-Control-Request-Method': 'GET',
          Origin: 'http://localhost:8082',
        },
        method: 'OPTIONS',
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8082');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Magicbooklet-Api-Version');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Magicbooklet-Installation-Id');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Magicbooklet-Min-App-Version');
  });

  it('adds CORS headers to mobile API responses', async () => {
    const response = await proxy(new NextRequest('http://localhost/api/showcase/feed?limit=4'));

    // A native client sends no Origin, so no grant is issued — and none is
    // needed, because CORS only constrains browsers.
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(response.headers.get('x-magicbooklet-api-version')).toBe('1');
    expect(response.headers.get('x-magicbooklet-min-api-version')).toBe('1');
    expect(response.headers.get('x-magicbooklet-min-app-version')).toBe('0.0.5');
    expect(response.headers.get('x-magicbooklet-catalog-schema-version')).toBe('3');
  });

  it('refuses a CORS grant to foreign browser origins', async () => {
    // The mobile path allowlist governs *which routes* answer CORS; it must not
    // hand every website on the internet a grant to drive them from a victim's
    // browser and IP.
    for (const origin of ['https://evil.example', 'http://magicbooklet.com.evil.example']) {
      const preflight = await proxy(new NextRequest('http://localhost/api/marketplace/resources', {
        headers: {
          'Access-Control-Request-Headers': 'Authorization',
          'Access-Control-Request-Method': 'GET',
          Origin: origin,
        },
        method: 'OPTIONS',
      }));
      expect(preflight.headers.get('Access-Control-Allow-Origin'), origin).toBeNull();

      const response = await proxy(new NextRequest('http://localhost/api/showcase/feed', {
        headers: { Origin: origin },
      }));
      expect(response.headers.get('Access-Control-Allow-Origin'), origin).toBeNull();
      // Vary must stay set so a cache never reuses one origin's answer for another.
      expect(response.headers.get('Vary'), origin).toContain('Origin');
    }
  });

  it('keeps unversioned released clients on the legacy v1 contract', async () => {
    const response = await proxy(new NextRequest('http://localhost/api/profile'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-magicbooklet-api-version')).toBe('1');
  });

  it('allows the first App Store release on the current contract', async () => {
    const response = await proxy(new NextRequest('http://localhost/api/profile', {
      headers: {
        'x-magicbooklet-client': 'mobile',
        'x-magicbooklet-api-version': '1',
        'x-magicbooklet-app-version': '0.0.5',
        'x-magicbooklet-catalog-schema-version': '1',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-magicbooklet-min-app-version')).toBe('0.0.5');
  });

  it('retires pre-0.0.5 builds that cannot verify a restored draft', async () => {
    // 0.0.4 and below restore a composer draft without checking that its
    // staged objects still exist, which is exactly what abandoned upload
    // reclaim deletes. Retiring them is the precondition for that sweep.
    const response = await proxy(new NextRequest('http://localhost/api/profile', {
      headers: {
        'x-magicbooklet-client': 'mobile',
        'x-magicbooklet-api-version': '1',
        'x-magicbooklet-app-version': '0.0.4',
        'x-magicbooklet-catalog-schema-version': '1',
      },
    }));

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      code: 'MOBILE_UPDATE_REQUIRED',
    });
  });

  it('requires an update when an identified mobile client is below policy', async () => {
    const response = await proxy(new NextRequest('http://localhost/api/profile', {
      headers: {
        'x-magicbooklet-client': 'mobile',
        'x-magicbooklet-api-version': '1',
        'x-magicbooklet-app-version': '0.0.0',
        'x-magicbooklet-catalog-schema-version': '1',
      },
    }));

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      code: 'MOBILE_UPDATE_REQUIRED',
      compatibility: {
        currentApiVersion: 1,
        minimumApiVersion: 1,
        minimumAppVersion: '0.0.5',
        supportedCatalogSchemaVersions: [1, 2, 3],
      },
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('allows the transition mobile client to request catalog schema v2', async () => {
    const response = await proxy(new NextRequest('http://localhost/api/profile', {
      headers: {
        'x-magicbooklet-client': 'mobile',
        'x-magicbooklet-api-version': '1',
        'x-magicbooklet-app-version': '0.0.5',
        'x-magicbooklet-catalog-schema-version': '2',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-magicbooklet-catalog-schema-version')).toBe('3');
  });

  it('asks a future mobile client to retry after the backend catches up', async () => {
    const response = await proxy(new NextRequest('http://localhost/api/profile', {
      headers: {
        'x-magicbooklet-client': 'mobile',
        'x-magicbooklet-api-version': '2',
        'x-magicbooklet-app-version': '2.0.0',
        'x-magicbooklet-catalog-schema-version': '2',
      },
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'MOBILE_SERVER_UPDATE_REQUIRED',
    });
  });

  it('recovers Supabase OAuth callbacks that land on the root URL', async () => {
    const request = new NextRequest(
      'https://magicbooklet.com/?code=auth-code&next=%2Fprofile%3Fwelcome%3D1'
    );
    const response = await proxy(request);

    expect(isRootAuthCodeRedirect(request)).toBe(true);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fprofile%3Fwelcome%3D1'
    );
  });
});
