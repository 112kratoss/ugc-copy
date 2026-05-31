import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { isMobileCorsPath, isRootAuthCodeRedirect, proxy } from '@/proxy';

describe('mobile API CORS proxy', () => {
  it('matches mobile API paths without opening unrelated APIs', () => {
    expect(isMobileCorsPath('/api/marketplace/resources')).toBe(true);
    expect(isMobileCorsPath('/api/marketplace/resources/bundle-1')).toBe(true);
    expect(isMobileCorsPath('/api/showcase/feed')).toBe(true);
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
  });

  it('adds CORS headers to mobile API responses', () => {
    const response = proxy(new NextRequest('http://localhost/api/showcase/feed?limit=4'));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
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
