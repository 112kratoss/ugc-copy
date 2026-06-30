import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { isMobileCorsPath, isRootAuthCodeRedirect, proxy } from '@/proxy';

describe('mobile API CORS proxy', () => {
  it('matches mobile API paths without opening unrelated APIs', () => {
    expect(isMobileCorsPath('/api/generation-models')).toBe(true);
    expect(isMobileCorsPath('/api/generation-models/quote')).toBe(true);
    expect(isMobileCorsPath('/api/app-version')).toBe(true);
    expect(isMobileCorsPath('/api/enhance-prompt')).toBe(true);
    expect(isMobileCorsPath('/api/uploads/media/sign')).toBe(true);
    expect(isMobileCorsPath('/api/uploads/media/read-url')).toBe(true);
    expect(isMobileCorsPath('/api/profile/media/sign')).toBe(true);
    expect(isMobileCorsPath('/api/marketplace/resources')).toBe(true);
    expect(isMobileCorsPath('/api/marketplace/resources/bundle-1')).toBe(true);
    expect(isMobileCorsPath('/api/showcase/feed')).toBe(true);
    expect(isMobileCorsPath('/api/showcase/saved-media')).toBe(true);
    expect(isMobileCorsPath('/api/mobile/notifications/preferences')).toBe(true);
    expect(isMobileCorsPath('/api/source-tools')).toBe(true);
    expect(isMobileCorsPath('/api/uploads/workflow-asset/sign')).toBe(false);
    expect(isMobileCorsPath('/api/razorpay/webhook')).toBe(false);
  });

  it('answers mobile API preflight requests', () => {
    const response = proxy(
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
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Magicbooklet-Api-Version');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Magicbooklet-Min-App-Version');
  });

  it('adds CORS headers to mobile API responses', () => {
    const response = proxy(new NextRequest('http://localhost/api/showcase/feed?limit=4'));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(response.headers.get('x-magicbooklet-api-version')).toBe('1');
    expect(response.headers.get('x-magicbooklet-min-api-version')).toBe('1');
    expect(response.headers.get('x-magicbooklet-min-app-version')).toBe('0.0.1');
    expect(response.headers.get('x-magicbooklet-catalog-schema-version')).toBe('1');
  });

  it('keeps unversioned released clients on the legacy v1 contract', () => {
    const response = proxy(new NextRequest('http://localhost/api/profile'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-magicbooklet-api-version')).toBe('1');
  });

  it('allows the submitted 0.0.1 mobile client on the current contract', () => {
    const response = proxy(new NextRequest('http://localhost/api/profile', {
      headers: {
        'x-magicbooklet-client': 'mobile',
        'x-magicbooklet-api-version': '1',
        'x-magicbooklet-app-version': '0.0.1',
        'x-magicbooklet-catalog-schema-version': '1',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-magicbooklet-min-app-version')).toBe('0.0.1');
  });

  it('requires an update when an identified mobile client is below policy', async () => {
    const response = proxy(new NextRequest('http://localhost/api/profile', {
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
        minimumAppVersion: '0.0.1',
        supportedCatalogSchemaVersions: [1],
      },
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('asks a future mobile client to retry after the backend catches up', async () => {
    const response = proxy(new NextRequest('http://localhost/api/profile', {
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

  it('recovers Supabase OAuth callbacks that land on the root URL', () => {
    const request = new NextRequest(
      'https://magicbooklet.com/?code=auth-code&next=%2Fprofile%3Fwelcome%3D1'
    );
    const response = proxy(request);

    expect(isRootAuthCodeRedirect(request)).toBe(true);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fprofile%3Fwelcome%3D1'
    );
  });
});
