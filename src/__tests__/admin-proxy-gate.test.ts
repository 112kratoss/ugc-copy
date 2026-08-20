import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAdminSessionToken, ADMIN_SESSION_COOKIE } from '@/lib/admin-session-token';
import { isAdminPath, isPublicAdminPath, proxy } from '@/proxy';

const SECRET = 'c'.repeat(48);
const SESSION_ID = '6f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c33';
const CREDENTIAL_VERSION = 'C'.repeat(43);
const ORIGINAL_SECRET = process.env.ADMIN_SESSION_SECRET;

function adminRequest(pathname: string, token?: string) {
  const request = new NextRequest(`http://localhost${pathname}`);
  if (token) {
    request.cookies.set(ADMIN_SESSION_COOKIE, token);
  }
  return request;
}

async function validToken(ttlSeconds = 3600) {
  return createAdminSessionToken({
    secret: SECRET,
    sessionId: SESSION_ID,
    credentialVersion: CREDENTIAL_VERSION,
    issuedAt: new Date(),
    ttlSeconds,
  });
}

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.ADMIN_SESSION_SECRET;
  } else {
    process.env.ADMIN_SESSION_SECRET = ORIGINAL_SECRET;
  }
});

describe('admin path matching', () => {
  it('claims the admin surface without capturing unrelated routes', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/moderation')).toBe(true);
    expect(isAdminPath('/api/admin/session')).toBe(true);
    expect(isAdminPath('/api/admin/moderation/post-reports')).toBe(true);

    // Routes that merely start with the same characters must not be gated.
    expect(isAdminPath('/administration')).toBe(false);
    expect(isAdminPath('/api/administrators')).toBe(false);
    expect(isAdminPath('/showcase')).toBe(false);
    expect(isAdminPath('/api/showcase/feed')).toBe(false);
  });

  it('leaves only the login screen and the session endpoint unauthenticated', () => {
    expect(isPublicAdminPath('/admin/login')).toBe(true);
    expect(isPublicAdminPath('/api/admin/session')).toBe(true);
    expect(isPublicAdminPath('/admin')).toBe(false);
    expect(isPublicAdminPath('/admin/users')).toBe(false);
    expect(isPublicAdminPath('/api/admin/moderation/post-reports')).toBe(false);
  });
});

describe('admin middleware gate', () => {
  it('redirects an unauthenticated page request to the login screen', async () => {
    const response = await proxy(adminRequest('/admin/users'));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/admin/login');
    expect(location.searchParams.get('next')).toBe('/admin/users');
  });

  it('answers an unauthenticated API request with 401 rather than a redirect', async () => {
    const response = await proxy(adminRequest('/api/admin/moderation/post-reports'));

    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('lets a valid session through and marks the response private and noindex', async () => {
    const response = await proxy(adminRequest('/admin/users', await validToken()));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
  });

  it('rejects an expired session', async () => {
    const expired = await createAdminSessionToken({
      secret: SECRET,
      sessionId: SESSION_ID,
      credentialVersion: CREDENTIAL_VERSION,
      issuedAt: new Date(Date.now() - 7200_000),
      ttlSeconds: 60,
    });
    const response = await proxy(adminRequest('/admin', expired));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/admin/login');
  });

  it('rejects a session signed with a foreign secret', async () => {
    const foreign = await createAdminSessionToken({
      secret: 'd'.repeat(48),
      sessionId: SESSION_ID,
      credentialVersion: CREDENTIAL_VERSION,
      issuedAt: new Date(),
      ttlSeconds: 3600,
    });
    const response = await proxy(adminRequest('/admin', foreign));

    expect(response.status).toBe(307);
  });

  it('rejects legacy v1 sessions so operators reauthenticate once', async () => {
    const response = await proxy(adminRequest('/admin', 'v1.legacy-payload.legacy-signature'));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/admin/login');
  });

  it('fails closed when no admin session secret is configured', async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const response = await proxy(adminRequest('/admin', await validToken()));

    expect(response.status).toBe(307);
  });

  it('serves the login screen and session endpoint without a session', async () => {
    const loginResponse = await proxy(adminRequest('/admin/login'));
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get('location')).toBeNull();

    const sessionResponse = await proxy(adminRequest('/api/admin/session'));
    expect(sessionResponse.status).toBe(200);
  });

  it('does not apply mobile CORS or version gating to admin routes', async () => {
    const request = new NextRequest('http://localhost/api/admin/session', {
      headers: {
        origin: 'https://evil.example',
        'X-Magicbooklet-Client': 'magicbooklet-mobile',
        'X-Magicbooklet-App-Version': '0.0.1',
      },
    });
    const response = await proxy(request);

    // A stale mobile client version would normally trigger a 426 upgrade gate;
    // the admin console is browser-only and must bypass that path entirely.
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
