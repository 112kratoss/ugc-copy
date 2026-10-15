import fs from 'node:fs';
import path from 'node:path';

import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { guardUserFacingRouteIdentity, proxy } from '@/proxy';
import { routeIdentityPolicyForPathname, routeIdentityPolicyForRequest } from '@/lib/route-identity-policy';

const SUBJECT = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-08-22T00:00:00+00:00';

function identityClient(options: {
  anonymous?: boolean;
  claims?: Record<string, unknown> | null;
  claimsError?: unknown;
  admission?: unknown;
  admissionError?: unknown;
  state?: unknown;
  sessionValid?: boolean;
  banned?: boolean;
} = {}) {
  const claims = options.claims === undefined
    ? {
        sub: SUBJECT,
        aud: 'authenticated',
        role: 'authenticated',
        session_id: SESSION,
        email: 'identity@example.invalid',
        is_anonymous: options.anonymous ?? false,
        app_metadata: { provider: 'email' },
        user_metadata: { full_name: 'Identity One', secret_note: 'never forwarded' },
        exp: Math.floor(Date.now() / 1000) + 3_600,
      }
    : options.claims;
  const admission = options.admission !== undefined
    ? options.admission
    : {
        state: 'state' in options ? options.state : 'active',
        created_at: CREATED_AT,
        banned: options.banned ?? false,
        session_valid: options.sessionValid ?? true,
      };
  return {
    auth: {
      getClaims: vi.fn(async () => (
        options.claimsError || claims === null
          ? { data: null, error: options.claimsError ?? new AuthApiError('invalid JWT', 401, 'bad_jwt') }
          : { data: { claims }, error: null }
      )),
    },
    rpc: vi.fn(async () => ({
      data: options.admissionError ? null : admission,
      error: options.admissionError ?? null,
    })),
  };
}

function authenticatedRequest(pathname: string, authorization = 'Bearer signed-user-token') {
  return new NextRequest(`https://magicbooklet.test${pathname}`, {
    headers: { Authorization: authorization },
  });
}

function requestWithMethod(method: string, pathname: string, authorization = 'Bearer signed-user-token') {
  return new NextRequest(`https://magicbooklet.test${pathname}`, {
    method,
    headers: { Authorization: authorization },
  });
}

describe('central route identity admission', () => {
  beforeEach(() => {
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', 'identity-admission-test-secret-at-least-32-characters');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves concrete dynamic API paths through the identity registry', () => {
    expect(routeIdentityPolicyForPathname('/api/generations/abc/restore')).toBe('guest');
    expect(routeIdentityPolicyForPathname('/api/showcase/posts/post-1/comments')).toBe('registered');
    expect(routeIdentityPolicyForPathname('/api/webhooks/kie')).toBe('service');
    // Siblings under one template: running it is a creation tool, testing it
    // is its author's.
    expect(routeIdentityPolicyForPathname('/api/templates/tpl-1/runs')).toBe('guest');
    expect(routeIdentityPolicyForPathname('/api/templates/tpl-1/test')).toBe('registered');
    expect(routeIdentityPolicyForPathname('/api/templates/validate')).toBe('registered');
  });

  it('verifies the bearer token locally and asks the database exactly once', async () => {
    const client = identityClient();
    const signIdentityAdmission = vi.fn(async () => 'signed-assertion');
    await expect(guardUserFacingRouteIdentity(
      authenticatedRequest('/api/generations'),
      { createUserClient: () => client, signIdentityAdmission },
    )).resolves.toBeNull();

    expect(client.auth.getClaims).toHaveBeenCalledTimes(1);
    expect(client.auth.getClaims).toHaveBeenCalledWith('signed-user-token');
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('current_identity_admission');
    expect(signIdentityAdmission).toHaveBeenCalledTimes(1);
    const [{ user, state }] = signIdentityAdmission.mock.calls[0] as unknown as [{
      user: Record<string, unknown>;
      state: string;
    }];
    expect(state).toBe('active');
    // The signed user is rebuilt from the verified claims plus the RPC's
    // created_at — nothing is copied from a caller-controlled object.
    expect(user).toMatchObject({
      id: SUBJECT,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'identity@example.invalid',
      is_anonymous: false,
      created_at: CREATED_AT,
    });
  });

  it('rejects merged and deleting tokens before route adapters run', async () => {
    for (const [state, code] of [
      ['merged', 'SESSION_MERGED'],
      ['deleting', 'ACCOUNT_DELETING'],
    ] as const) {
      const response = await guardUserFacingRouteIdentity(
        authenticatedRequest('/api/generations'),
        { createUserClient: () => identityClient({ state }) },
      );

      expect(response?.status).toBe(409);
      await expect(response?.json()).resolves.toMatchObject({ code });
    }
  });

  // A deletion revokes every session of the account before it answers, so the
  // account's other devices arrive with revoked sessions. Answering those 401
  // told them their session had merely ended and the account was intact.
  it('tells a revoked session of a deleting account that the account is going', async () => {
    const deleting = await guardUserFacingRouteIdentity(
      authenticatedRequest('/api/generations'),
      { createUserClient: () => identityClient({ state: 'deleting', sessionValid: false }) },
    );
    expect(deleting?.status).toBe(409);
    await expect(deleting?.json()).resolves.toEqual({
      error: 'This account is being permanently deleted.',
      code: 'ACCOUNT_DELETING',
    });

    // Only the deletion outranks the session: a revoked session of a live
    // account, and an account whose auth user is already gone, stay 401.
    for (const client of [
      identityClient({ state: 'active', sessionValid: false }),
      identityClient({ admission: null }),
    ]) {
      const response = await guardUserFacingRouteIdentity(
        authenticatedRequest('/api/generations'),
        { createUserClient: () => client },
      );
      expect(response?.status).toBe(401);
      await expect(response?.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('gates an ordinary non-mobile web API request through the full proxy', async () => {
    const request = authenticatedRequest('/api/generations');
    expect(request.headers.has('x-magicbooklet-client')).toBe(false);

    const response = await proxy(request, {
      createUserClient: () => identityClient({ state: 'merged' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });
  });

  it('rejects stale bearer tokens on public event and preview endpoints', async () => {
    for (const pathname of [
      '/api/showcase/feed/events',
      '/api/showcase/preview?id=generation-1',
    ]) {
      const response = await proxy(authenticatedRequest(pathname), {
        createUserClient: () => identityClient({ state: 'merged' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });
    }
  });

  it('answers 401 for a token that fails signature, expiry or parsing', async () => {
    const client = identityClient({ claims: null });
    const response = await guardUserFacingRouteIdentity(
      authenticatedRequest('/api/generations'),
      { createUserClient: () => client },
    );

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('answers 503, not 401, when the signing keys cannot be fetched', async () => {
    const response = await guardUserFacingRouteIdentity(
      authenticatedRequest('/api/generations'),
      { createUserClient: () => identityClient({ claimsError: new AuthRetryableFetchError('fetch failed', 0) }) },
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ code: 'IDENTITY_CHECK_UNAVAILABLE' });
  });

  it('refuses a revoked session, a banned account, and an account that no longer exists', async () => {
    for (const client of [
      identityClient({ sessionValid: false }),
      identityClient({ banned: true }),
      identityClient({ admission: null }),
    ]) {
      const response = await guardUserFacingRouteIdentity(
        authenticatedRequest('/api/generations'),
        { createUserClient: () => client },
      );

      expect(response?.status).toBe(401);
      await expect(response?.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('refuses claims without an authenticated role or a well-formed subject before any lookup', async () => {
    for (const claims of [
      { sub: SUBJECT, role: 'anon' },
      { sub: 'not-a-uuid', role: 'authenticated' },
      { role: 'authenticated' },
    ]) {
      const client = identityClient({ claims });
      const response = await guardUserFacingRouteIdentity(
        authenticatedRequest('/api/generations'),
        { createUserClient: () => client },
      );

      expect(response?.status).toBe(401);
      expect(client.rpc).not.toHaveBeenCalled();
    }
  });

  it('refuses a malformed Authorization header without contacting Supabase', async () => {
    const createUserClient = vi.fn(() => identityClient());
    const response = await guardUserFacingRouteIdentity(
      authenticatedRequest('/api/generations', 'Token signed-user-token'),
      { createUserClient },
    );

    expect(response?.status).toBe(401);
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when durable state lookup fails or is missing', async () => {
    for (const client of [
      identityClient({ admissionError: new Error('database unavailable') }),
      identityClient({ state: 'unknown' }),
      identityClient({ state: null }),
      identityClient({ admission: 'active' }),
    ]) {
      const response = await guardUserFacingRouteIdentity(
        authenticatedRequest('/api/workflow-canvases/canvas-1/run'),
        { createUserClient: () => client },
      );

      expect(response?.status).toBe(503);
      await expect(response?.json()).resolves.toMatchObject({
        code: 'IDENTITY_CHECK_UNAVAILABLE',
      });
    }
  });

  it('falls back to route admission when the assertion key is unavailable', async () => {
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', '');
    const response = await proxy(authenticatedRequest('/api/generations'), {
      createUserClient: () => identityClient(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-request-x-magicbooklet-identity-admission'))
      .toBeNull();
  });

  it('forwards trusted proxy timing, split by phase, to the authenticated production monitor', async () => {
    const request = new NextRequest('https://magicbooklet.test/api/generations', {
      headers: {
        Authorization: 'Bearer signed-user-token',
        'x-performance-monitor': 'load',
        'x-magicbooklet-proxy-timing': 'caller-value',
      },
    });
    const response = await proxy(request, {
      createUserClient: () => identityClient({ state: 'active' }),
    });

    expect(response.status).toBe(200);
    const timing = response.headers.get('x-middleware-request-x-magicbooklet-proxy-timing');
    expect(timing).toMatch(
      /^proxy-identity;dur=\d+(?:\.\d+)?, proxy-verify;dur=\d+(?:\.\d+)?, proxy-lifecycle;dur=\d+(?:\.\d+)?$/,
    );
    expect(timing).not.toContain('caller-value');
  });

  it('admits active guests only on guest-enabled routes', async () => {
    const guest = identityClient({ anonymous: true });
    await expect(guardUserFacingRouteIdentity(
      authenticatedRequest('/api/generate'),
      { createUserClient: () => guest },
    )).resolves.toBeNull();

    const response = await guardUserFacingRouteIdentity(
      authenticatedRequest('/api/showcase/publish'),
      { createUserClient: () => guest },
    );
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
  });

  // A guest's app sends its token with every request. The comments path is
  // registered-only for its writes, while its read is the public post page's
  // own data, served with no token at all. Asking the path's question of that
  // read answered every guest 403, and the app drew "Comments are unavailable"
  // on every post (seen on the Pixel 9a's guest session, 2026-10-11).
  it('lets a guest read a thread any visitor may read, and still refuses the write', async () => {
    const comments = '/api/showcase/posts/post-1/comments';
    const guest = identityClient({ anonymous: true });
    const dependencies = { createUserClient: () => guest };

    await expect(guardUserFacingRouteIdentity(requestWithMethod('GET', comments), dependencies))
      .resolves.toBeNull();
    await expect(guardUserFacingRouteIdentity(requestWithMethod('HEAD', comments), dependencies))
      .resolves.toBeNull();

    for (const [method, pathname] of [
      ['POST', comments],
      ['DELETE', `${comments}/comment-1`],
      // Another registered read stays the viewer's own: nothing to show a guest.
      ['GET', '/api/content-preferences'],
      ['GET', '/api/showcase/saved-media'],
    ]) {
      const response = await guardUserFacingRouteIdentity(requestWithMethod(method, pathname), dependencies);
      expect(response?.status, `${method} ${pathname}`).toBe(403);
      await expect(response?.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    }
  });

  it('still asks for a live identity behind a token sent with that read', async () => {
    const comments = '/api/showcase/posts/post-1/comments';

    // A token is optional there, never decorative: a spent one is refused.
    for (const client of [
      identityClient({ anonymous: true, claims: null }),
      identityClient({ anonymous: true, sessionValid: false }),
      identityClient({ anonymous: true, banned: true }),
    ]) {
      const response = await guardUserFacingRouteIdentity(
        requestWithMethod('GET', comments),
        { createUserClient: () => client },
      );
      expect(response?.status).toBe(401);
    }

    const merged = await guardUserFacingRouteIdentity(
      requestWithMethod('GET', comments),
      { createUserClient: () => identityClient({ anonymous: true, state: 'merged' }) },
    );
    expect(merged?.status).toBe(409);
  });

  it('answers per request: the path keeps its policy, the listed read is public', () => {
    const comments = '/api/showcase/posts/post-1/comments';

    expect(routeIdentityPolicyForPathname(comments)).toBe('registered');
    expect(routeIdentityPolicyForRequest(comments, 'GET')).toBe('public');
    expect(routeIdentityPolicyForRequest(comments, 'get')).toBe('public');
    expect(routeIdentityPolicyForRequest(comments, 'HEAD')).toBe('public');
    expect(routeIdentityPolicyForRequest(comments, 'POST')).toBe('registered');
    expect(routeIdentityPolicyForRequest(`${comments}/comment-1`, 'GET')).toBe('registered');
    // Every other path answers as it did, whatever the method.
    expect(routeIdentityPolicyForRequest('/api/generations/abc/restore', 'GET')).toBe('guest');
    expect(routeIdentityPolicyForRequest('/api/content-preferences', 'GET')).toBe('registered');
    expect(routeIdentityPolicyForRequest('/api/webhooks/kie', 'GET')).toBe('service');
    expect(routeIdentityPolicyForRequest('/api/not-a-route', 'GET')).toBeNull();
  });

  // An app guest's intro events and shares were refused 403 here although each
  // handler takes a caller who is no one: the onboarding funnel lost its top
  // and guests' shares never reached the counts. Its report of an AI result it
  // made goes through too; the moderation adapter refuses every other target.
  // So does its deletion of itself (product decision D5, 2026-10-15).
  it('admits a guest to the writes listed for guests, and to no other registered write', async () => {
    const guest = identityClient({ anonymous: true });
    const dependencies = { createUserClient: () => guest };

    for (const [method, pathname] of [
      ['POST', '/api/onboarding/events'],
      ['POST', '/api/showcase/share'],
      ['POST', '/api/profile/share'],
      ['POST', '/api/moderation/reports'],
      ['DELETE', '/api/account'],
    ]) {
      await expect(guardUserFacingRouteIdentity(requestWithMethod(method, pathname), dependencies), `${method} ${pathname}`)
        .resolves.toBeNull();
    }

    for (const [method, pathname] of [
      ['POST', '/api/showcase/save'],
      ['POST', '/api/moderation/blocks/22222222-2222-4222-8222-222222222222'],
      ['PATCH', '/api/onboarding/state'],
      ['POST', '/api/account/merge'],
      // A listed path keeps its policy for every method not listed with it.
      ['GET', '/api/onboarding/events'],
      ['DELETE', '/api/moderation/reports'],
      ['PATCH', '/api/account'],
    ]) {
      const response = await guardUserFacingRouteIdentity(requestWithMethod(method, pathname), dependencies);
      expect(response?.status, `${method} ${pathname}`).toBe(403);
      await expect(response?.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    }
  });

  it('still asks for a live identity behind a guest token sent with a listed write', async () => {
    const merged = await guardUserFacingRouteIdentity(
      requestWithMethod('POST', '/api/showcase/share'),
      { createUserClient: () => identityClient({ anonymous: true, state: 'merged' }) },
    );
    expect(merged?.status).toBe(409);
    await expect(merged?.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });

    const revoked = await guardUserFacingRouteIdentity(
      requestWithMethod('POST', '/api/onboarding/events'),
      { createUserClient: () => identityClient({ anonymous: true, sessionValid: false }) },
    );
    expect(revoked?.status).toBe(401);
  });

  it('answers a listed write as guest, by method, and every other request as before', () => {
    expect(routeIdentityPolicyForRequest('/api/showcase/share', 'POST')).toBe('guest');
    expect(routeIdentityPolicyForRequest('/api/showcase/share', 'post')).toBe('guest');
    expect(routeIdentityPolicyForRequest('/api/moderation/reports', 'POST')).toBe('guest');
    expect(routeIdentityPolicyForRequest('/api/onboarding/events', 'POST')).toBe('guest');
    expect(routeIdentityPolicyForRequest('/api/profile/share', 'POST')).toBe('guest');
    expect(routeIdentityPolicyForRequest('/api/account', 'DELETE')).toBe('guest');
    expect(routeIdentityPolicyForRequest('/api/account', 'delete')).toBe('guest');
    expect(routeIdentityPolicyForPathname('/api/account')).toBe('registered');
    expect(routeIdentityPolicyForPathname('/api/showcase/share')).toBe('registered');
    expect(routeIdentityPolicyForRequest('/api/showcase/share', 'GET')).toBe('registered');
    expect(routeIdentityPolicyForRequest('/api/moderation/blocks', 'POST')).toBe('registered');
    expect(routeIdentityPolicyForRequest('/api/onboarding/state', 'POST')).toBe('registered');
  });

  it('keeps tokenless public routes public and never gates service routes', async () => {
    const createUserClient = vi.fn();
    await expect(guardUserFacingRouteIdentity(
      new NextRequest('https://magicbooklet.test/api/showcase/feed'),
      { createUserClient },
    )).resolves.toBeNull();
    await expect(guardUserFacingRouteIdentity(
      authenticatedRequest('/api/cron/backend-jobs'),
      { createUserClient },
    )).resolves.toBeNull();
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it('keeps raw auth.getUser inside the one audited server authentication boundary', () => {
    const apiRoot = path.resolve(process.cwd(), 'src/app/api');
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const routeFiles: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        if (entry.isFile() && entry.name === 'route.ts') routeFiles.push(target);
      }
    };
    visit(apiRoot);

    const resolveLocalModule = (fromFile: string, specifier: string) => {
      const moduleBase = specifier.startsWith('@/')
        ? path.join(sourceRoot, specifier.slice(2))
        : specifier.startsWith('.')
          ? path.resolve(path.dirname(fromFile), specifier)
          : null;
      if (!moduleBase || !moduleBase.startsWith(`${sourceRoot}${path.sep}`)) return null;

      const candidates = [
        moduleBase,
        `${moduleBase}.ts`,
        `${moduleBase}.tsx`,
        path.join(moduleBase, 'index.ts'),
        path.join(moduleBase, 'index.tsx'),
      ];
      return candidates.find((candidate) => (
        /\.(?:ts|tsx)$/.test(candidate)
        && fs.existsSync(candidate)
        && fs.statSync(candidate).isFile()
      )) ?? null;
    };

    // Follow the local import graph from every actual route entry point. This
    // includes the route adapters/services where authentication normally lives,
    // without pretending a scan of route.ts wrappers alone proves anything.
    const reachableServerFiles = new Set(routeFiles);
    const queue = [...routeFiles];
    while (queue.length > 0) {
      const file = queue.pop();
      if (!file) continue;
      const source = fs.readFileSync(file, 'utf8');
      const specifiers = [
        ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
        ...source.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        const importedFile = resolveLocalModule(file, specifier);
        if (!importedFile || reachableServerFiles.has(importedFile)) continue;
        reachableServerFiles.add(importedFile);
        queue.push(importedFile);
      }
    }

    const relativeReachableFiles = [...reachableServerFiles]
      .map((file) => path.relative(process.cwd(), file));
    expect(routeFiles.length).toBeGreaterThan(100);
    expect(relativeReachableFiles).toContain(
      'src/lib/generation-restore-media-route-adapter-service.ts',
    );
    expect(relativeReachableFiles).toContain('src/lib/account-identity.ts');

    const rawAuthBoundaries = [...reachableServerFiles]
      .filter((file) => /\bauth\s*\.\s*getUser\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(rawAuthBoundaries).toEqual(['src/lib/server-auth-user.ts']);
  });
});
