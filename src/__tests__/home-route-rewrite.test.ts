import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { proxy, resolveRootHomeRouting } from '@/proxy';

const SUPABASE_URL = 'https://testproject.supabase.co';
const AUTH_COOKIE = 'sb-testproject-auth-token';

const ORIGINAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ORIGINAL_E2E_BYPASS = process.env.E2E_AUTH_BYPASS;
const ORIGINAL_PUBLIC_E2E_BYPASS = process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS;

function rootRequest({
  pathname = '/',
  cookies = {} as Record<string, string>,
  method = 'GET',
  search = '',
} = {}) {
  const request = new NextRequest(`http://localhost${pathname}${search}`, { method });
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

function getRewriteTarget(response: Response | null) {
  return response?.headers.get('x-middleware-rewrite') ?? null;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  delete process.env.E2E_AUTH_BYPASS;
  delete process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS;
});

afterEach(() => {
  if (ORIGINAL_SUPABASE_URL === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL;
  }
  if (ORIGINAL_E2E_BYPASS === undefined) {
    delete process.env.E2E_AUTH_BYPASS;
  } else {
    process.env.E2E_AUTH_BYPASS = ORIGINAL_E2E_BYPASS;
  }
  if (ORIGINAL_PUBLIC_E2E_BYPASS === undefined) {
    delete process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS;
  } else {
    process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS = ORIGINAL_PUBLIC_E2E_BYPASS;
  }
});

describe('resolveRootHomeRouting', () => {
  it('rewrites / to /home when a Supabase auth cookie is present', () => {
    const response = resolveRootHomeRouting(rootRequest({
      cookies: { [AUTH_COOKIE]: 'token' },
    }));

    expect(getRewriteTarget(response)).toBe('http://localhost/home');
    expect(response?.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response?.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('rewrites for chunked auth cookies', () => {
    const response = resolveRootHomeRouting(rootRequest({
      cookies: { [`${AUTH_COOKIE}.0`]: 'chunk-a', [`${AUTH_COOKIE}.1`]: 'chunk-b' },
    }));

    expect(getRewriteTarget(response)).toBe('http://localhost/home');
  });

  it('ignores the PKCE code-verifier cookie', () => {
    const response = resolveRootHomeRouting(rootRequest({
      cookies: { [`${AUTH_COOKIE}-code-verifier`]: 'pending-oauth' },
    }));

    expect(response).toBeNull();
  });

  it('passes cookie-less traffic through to the static marketing page', () => {
    expect(resolveRootHomeRouting(rootRequest())).toBeNull();
  });

  it('preserves the query string on rewrite', () => {
    const response = resolveRootHomeRouting(rootRequest({
      cookies: { [AUTH_COOKIE]: 'token' },
      search: '?chip=recent',
    }));

    expect(getRewriteTarget(response)).toBe('http://localhost/home?chip=recent');
  });

  it('never rewrites non-GET requests', () => {
    const response = resolveRootHomeRouting(rootRequest({
      cookies: { [AUTH_COOKIE]: 'token' },
      method: 'POST',
    }));

    expect(response).toBeNull();
  });

  it('redirects direct /home hits back to /', () => {
    const response = resolveRootHomeRouting(rootRequest({
      pathname: '/home',
      cookies: { [AUTH_COOKIE]: 'token' },
    }));

    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe('http://localhost/');
  });

  it('redirects /home even without cookies', () => {
    const response = resolveRootHomeRouting(rootRequest({ pathname: '/home' }));

    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe('http://localhost/');
  });

  it('honors the E2E cookie only while the bypass env is set', () => {
    const e2eRequest = () => rootRequest({ cookies: { 'e2e-auth': 'workflow-user' } });

    expect(resolveRootHomeRouting(e2eRequest())).toBeNull();

    // Playwright sets both flags (playwright.config.ts); the private one
    // drives edge/server code paths, the public one browser bundles — jsdom
    // counts as a browser, so both are set here to mirror the E2E runtime.
    process.env.E2E_AUTH_BYPASS = '1';
    process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS = '1';
    expect(getRewriteTarget(resolveRootHomeRouting(e2eRequest()))).toBe('http://localhost/home');
  });

  it('fails safe to marketing when the Supabase URL is unset', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    const response = resolveRootHomeRouting(rootRequest({
      cookies: { [AUTH_COOKIE]: 'token' },
    }));

    expect(response).toBeNull();
  });

  it('does not treat other routes as the home surface', () => {
    expect(resolveRootHomeRouting(rootRequest({
      pathname: '/showcase',
      cookies: { [AUTH_COOKIE]: 'token' },
    }))).toBeNull();
  });
});

describe('proxy home routing integration', () => {
  it('rewrites signed-in / through the full middleware', async () => {
    const response = await proxy(rootRequest({ cookies: { [AUTH_COOKIE]: 'token' } }));

    expect(getRewriteTarget(response)).toBe('http://localhost/home');
  });

  it('keeps the OAuth ?code= redirect ahead of the home rewrite', async () => {
    const response = await proxy(rootRequest({
      cookies: { [AUTH_COOKIE]: 'token' },
      search: '?code=abc123',
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/auth/callback?code=abc123');
    expect(getRewriteTarget(response)).toBeNull();
  });

  it('serves anonymous / untouched', async () => {
    const response = await proxy(rootRequest());

    expect(getRewriteTarget(response)).toBeNull();
    expect(response.status).toBe(200);
  });
});
