import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, HEAD } from '@/app/api/showcase/feed/route';
import { proxy } from '@/proxy';
import { getShowcaseFeedRouteResponse } from '@/lib/showcase-feed-route-adapter-service';
import {
  IDENTITY_ADMISSION_HEADER,
  IDENTITY_PROXY_TIMING_HEADER,
  registerIdentityAdmissionContext,
} from '@/lib/identity-admission-assertion';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { withRegionalIdentityAdmission } from '@/lib/regional-identity-admission';

vi.mock('@supabase/supabase-js', async (original) => ({
  ...await original<typeof import('@supabase/supabase-js')>(),
  createClient: vi.fn(),
}));
vi.mock('@/lib/showcase-feed-route-adapter-service', () => ({
  getShowcaseFeedRouteResponse: vi.fn(async () => new Response('feed')),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
function client(admission: unknown = {
  state: 'active', session_valid: true, banned: false, created_at: '2026-09-21T00:00:00Z',
}, error: unknown = null) {
  return {
    auth: { getClaims: vi.fn(async () => ({
      data: { claims: { sub: USER_ID, role: 'authenticated', is_anonymous: false } }, error: null,
    })) },
    rpc: vi.fn(async () => ({ data: admission, error })),
  };
}
function request(method = 'GET', path = '/api/showcase/feed?sort=for-you') {
  return new NextRequest(`https://magicbooklet.test${path}`, {
    method,
    headers: {
      authorization: 'Bearer user-token',
      'x-performance-monitor': 'load',
      [IDENTITY_ADMISSION_HEADER]: 'forged',
      [IDENTITY_PROXY_TIMING_HEADER]: 'route-identity;dur=999999',
    },
  });
}

describe('regional feed identity admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', 'test-secret-with-at-least-32-characters');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('defers only feed GET/HEAD and strips caller assertions in the proxy', async () => {
    for (const method of ['GET', 'HEAD']) {
      const createUserClient = vi.fn();
      const response = await proxy(request(method), { createUserClient });
      expect(createUserClient).not.toHaveBeenCalled();
      expect(response.headers.get(`x-middleware-request-${IDENTITY_ADMISSION_HEADER}`)).toBeNull();
      expect(response.headers.get(`x-middleware-request-${IDENTITY_PROXY_TIMING_HEADER}`)).not.toContain('999999');
    }
    for (const [method, path] of [
      ['POST', '/api/showcase/feed'],
      ['GET', '/api/showcase/feed/events'],
      ['GET', '/api/generations'],
    ]) {
      const identity = client({ state: 'merged', session_valid: true });
      const response = await proxy(request(method, path), { createUserClient: () => identity });
      expect(response.status).toBe(409);
      expect(identity.rpc).toHaveBeenCalledTimes(1);
    }
  });

  it('runs fresh admission at both actual route exports before handing off to the adapter', async () => {
    for (const [method, handler] of [['GET', GET], ['HEAD', HEAD]] as const) {
      const identity = client();
      vi.mocked(createClient).mockReturnValue(identity as unknown as ReturnType<typeof createClient>);
      expect((await handler(request(method))).status).toBe(200);
      expect(identity.rpc).toHaveBeenCalledTimes(1);
      const admitted = vi.mocked(getShowcaseFeedRouteResponse).mock.lastCall![0].request;
      expect(admitted.headers.get(IDENTITY_ADMISSION_HEADER)).not.toBe('forged');
      expect(admitted.headers.get(IDENTITY_PROXY_TIMING_HEADER)).toMatch(/^route-identity;dur=/);
      expect(admitted.headers.get(IDENTITY_PROXY_TIMING_HEADER)).not.toContain('999999');
      const routeClient = { auth: { getUser: vi.fn() } };
      registerIdentityAdmissionContext(routeClient, admitted);
      expect((await getVerifiedAuthUserResult(routeClient)).data.user?.id).toBe(USER_ID);
      expect(routeClient.auth.getUser).not.toHaveBeenCalled();
    }
  });

  it.each([
    [null, null, 401],
    [{ session_valid: false, state: 'active' }, null, 401],
    [{ session_valid: true, banned: true, state: 'active' }, null, 401],
    [{ session_valid: true, state: 'merged' }, null, 409],
    [{ session_valid: true, state: 'deleting' }, null, 409],
    [{ session_valid: true, state: 'unknown' }, null, 503],
    [null, new Error('unavailable'), 503],
  ])('rejects inactive identities at the actual feed export (%j)', async (admission, error, status) => {
    vi.mocked(createClient).mockReturnValue(client(admission, error) as unknown as ReturnType<typeof createClient>);
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(getShowcaseFeedRouteResponse).not.toHaveBeenCalled();
  });

  it('rejects invalid tokens before any database read or adapter work', async () => {
    const identity = client();
    identity.auth.getClaims.mockResolvedValue({ data: null, error: new Error('bad token') } as never);
    vi.mocked(createClient).mockReturnValue(identity as unknown as ReturnType<typeof createClient>);
    expect((await GET(request())).status).toBe(401);
    expect(identity.rpc).not.toHaveBeenCalled();
    expect(getShowcaseFeedRouteResponse).not.toHaveBeenCalled();
  });

  it('keeps tokenless reads public without contacting Auth or trusting caller headers', async () => {
    const req = request();
    req.headers.delete('authorization');
    const createUserClient = vi.fn();
    const handler = vi.fn(async (admitted: NextRequest) => {
      expect(admitted.headers.has(IDENTITY_ADMISSION_HEADER)).toBe(false);
      expect(admitted.headers.has(IDENTITY_PROXY_TIMING_HEADER)).toBe(false);
      return new Response('public');
    });
    expect((await withRegionalIdentityAdmission(req, handler, { createUserClient })).status).toBe(200);
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('handles a framework-proxied %s request without copying its native internals', async (method) => {
    const original = request(method);
    const proxied = new Proxy(original, {
      get(target, property) { return Reflect.get(target, property, target); },
    });
    const handler = vi.fn(async (admitted: NextRequest) => {
      expect(admitted.url).toBe(original.url);
      expect(admitted.method).toBe(method);
      expect(admitted.headers.get('authorization')).toBe('Bearer user-token');
      expect(admitted.headers.get(IDENTITY_ADMISSION_HEADER)).not.toBe('forged');
      return new Response('feed');
    });
    expect((await withRegionalIdentityAdmission(proxied, handler, {
      createUserClient: () => client(),
    })).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});
