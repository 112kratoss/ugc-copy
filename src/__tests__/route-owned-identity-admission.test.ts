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
import {
  rebuildAdmittedRequest,
  usesRouteOwnedIdentityAdmission,
  withRouteOwnedIdentityAdmission,
} from '@/lib/route-owned-identity-admission';
import { evaluateUserFacingRouteIdentity } from '@/lib/route-identity-admission';

vi.mock('@supabase/supabase-js', async (original) => ({
  ...await original<typeof import('@supabase/supabase-js')>(),
  createClient: vi.fn(),
}));
vi.mock('@/lib/showcase-feed-route-adapter-service', () => ({
  getShowcaseFeedRouteResponse: vi.fn(async () => new Response('feed')),
  startShowcaseFeedReadLimit: vi.fn(() => null),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
function client(admission: unknown = {
  state: 'active', session_valid: true, banned: false, created_at: '2026-09-21T00:00:00Z',
}, error: unknown = null, claims: Record<string, unknown> = { sub: USER_ID, role: 'authenticated', is_anonymous: false }) {
  return {
    auth: { getClaims: vi.fn(async () => ({
      data: { claims }, error: null,
    })) },
    rpc: vi.fn(async () => ({ data: admission, error })),
  };
}
function request(method = 'GET', path = '/api/showcase/feed?sort=for-you', body?: string) {
  return new NextRequest(`https://magicbooklet.test${path}`, {
    method,
    headers: {
      authorization: 'Bearer user-token',
      'x-performance-monitor': 'load',
      [IDENTITY_ADMISSION_HEADER]: 'forged',
      [IDENTITY_PROXY_TIMING_HEADER]: 'route-identity;dur=999999',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

describe('route-owned identity admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', 'test-secret-with-at-least-32-characters');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('lists the feed reads and every method of the MCP server, and nothing else', () => {
    expect(usesRouteOwnedIdentityAdmission(request('GET'))).toBe(true);
    expect(usesRouteOwnedIdentityAdmission(request('HEAD'))).toBe(true);
    expect(usesRouteOwnedIdentityAdmission(request('POST', '/api/showcase/feed'))).toBe(false);
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      expect(usesRouteOwnedIdentityAdmission(request(method, '/api/mcp')), method).toBe(true);
      // The posting-only server is the same adapter at a second path.
      expect(usesRouteOwnedIdentityAdmission(request(method, '/api/mcp/posts')), method).toBe(true);
    }
    expect(usesRouteOwnedIdentityAdmission(request('POST', '/api/mcp/posts/other'))).toBe(false);
    expect(usesRouteOwnedIdentityAdmission(request('POST', '/api/mcp/other'))).toBe(false);
    expect(usesRouteOwnedIdentityAdmission(request('GET', '/api/showcase/feed/events'))).toBe(false);
    expect(usesRouteOwnedIdentityAdmission(request('GET', '/api/generations'))).toBe(false);
  });

  it('defers only the listed requests and strips caller assertions in the proxy', async () => {
    for (const [method, path] of [
      ['GET', '/api/showcase/feed'],
      ['HEAD', '/api/showcase/feed'],
      ['POST', '/api/mcp'],
      ['GET', '/api/mcp'],
      ['DELETE', '/api/mcp'],
      ['POST', '/api/mcp/posts'],
      ['GET', '/api/mcp/posts'],
    ]) {
      const createUserClient = vi.fn();
      const response = await proxy(request(method, path), { createUserClient });
      expect(createUserClient, `${method} ${path}`).not.toHaveBeenCalled();
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

  it('runs fresh admission at both actual feed exports before handing off to the adapter', async () => {
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
    expect((await withRouteOwnedIdentityAdmission(req, handler, { createUserClient })).status).toBe(200);
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
    expect((await withRouteOwnedIdentityAdmission(proxied, handler, {
      createUserClient: () => client(),
    })).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  describe('work started beside the lifecycle round trip', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((settle) => { resolve = settle; });
      return { promise, resolve };
    }
    const ACTIVE = { state: 'active', session_valid: true, banned: false, created_at: '2026-09-21T00:00:00Z' };

    function started(settled: Promise<unknown> = Promise.resolve('counted')) {
      return { settled, release: vi.fn(async () => undefined) };
    }
    /** Collects what runs after the response, to run it when the test says. */
    function afterResponse() {
      const tasks: Array<() => Promise<void>> = [];
      return {
        tasks,
        schedule: (task: () => Promise<void>) => { tasks.push(task); },
        runAll: () => Promise.all(tasks.splice(0).map((task) => task())),
      };
    }

    it('starts it from the verified subject while the round trip is out, and hands it to the handler once admitted', async () => {
      const lifecycle = deferred<{ data: unknown; error: unknown }>();
      const identity = client();
      identity.rpc.mockImplementation(() => lifecycle.promise);
      const work = started();
      const besideLifecycle = vi.fn(() => work);
      const handler = vi.fn(async () => new Response('feed'));
      const after = afterResponse();

      const pending = withRouteOwnedIdentityAdmission(
        request(),
        handler,
        { createUserClient: () => identity },
        besideLifecycle,
        after.schedule,
      );
      await vi.waitFor(() => expect(besideLifecycle).toHaveBeenCalledOnce());
      // The subject alone: the claims stay admission's own.
      expect(besideLifecycle).toHaveBeenCalledWith({ userId: USER_ID });
      expect(identity.rpc).toHaveBeenCalledOnce();
      expect(besideLifecycle.mock.invocationCallOrder[0]).toBeLessThan(identity.rpc.mock.invocationCallOrder[0]);
      expect(handler).not.toHaveBeenCalled();

      lifecycle.resolve({ data: ACTIVE, error: null });
      expect((await pending).status).toBe(200);
      expect(handler).toHaveBeenCalledWith(expect.any(NextRequest), work);
      // Released only after the answer, and only through the after-response runner.
      expect(work.release).not.toHaveBeenCalled();
      await after.runAll();
      expect(work.release).toHaveBeenCalledOnce();
    });

    it.each([
      [{ session_valid: false, state: 'active' }, 401],
      [{ session_valid: true, state: 'merged' }, 409],
      [null, 401],
      [{ session_valid: true, state: 'unknown' }, 503],
    ])('answers a refusal at once, exactly as without it, and releases it after (%j)', async (admission, status) => {
      const count = deferred<string>();
      const work = started(count.promise);
      const handler = vi.fn(async () => new Response('feed'));
      const after = afterResponse();

      // The work is still out when the refusal is answered.
      const response = await withRouteOwnedIdentityAdmission(
        request(),
        handler,
        { createUserClient: () => client(admission) },
        () => work,
        after.schedule,
      );
      const alone = await withRouteOwnedIdentityAdmission(request(), handler, { createUserClient: () => client(admission) });
      expect(response.status).toBe(status);
      expect(response.status).toBe(alone.status);
      expect(await response.json()).toEqual(await alone.json());
      expect([...response.headers]).toEqual([...alone.headers]);
      expect(handler).not.toHaveBeenCalled();

      expect(work.release).not.toHaveBeenCalled();
      expect(after.tasks).toHaveLength(1);
      count.resolve('counted');
      await after.runAll();
      expect(work.release).toHaveBeenCalledOnce();
    });

    it('releases work the handler answered without using, after the answer', async () => {
      const work = started(new Promise(() => undefined));
      const after = afterResponse();

      const response = await withRouteOwnedIdentityAdmission(
        request(),
        async () => new Response('early answer'),
        { createUserClient: () => client() },
        () => work,
        after.schedule,
      );

      expect(await response.text()).toBe('early answer');
      expect(after.tasks).toHaveLength(1);
      await after.runAll();
      expect(work.release).toHaveBeenCalledOnce();
    });

    it('never lets work that rejects go unhandled, admitted or refused', async () => {
      for (const [admission, status] of [[undefined, 200], [{ session_valid: false, state: 'active' }, 401]] as const) {
        const after = afterResponse();
        const response = await withRouteOwnedIdentityAdmission(
          request(),
          async () => new Response('feed'),
          { createUserClient: () => client(admission) },
          () => ({
            settled: Promise.reject(new Error('rejected beside admission')),
            release: () => Promise.reject(new Error('release rejected')),
          }),
          after.schedule,
        );
        expect(response.status).toBe(status);
        await expect(after.runAll()).resolves.toBeDefined();
      }
    });

    it('runs the release after the response through after(), and at once outside a request scope', async () => {
      const work = started();
      // Called directly, as here, the route has no request scope, so after() throws and the
      // release runs at once instead.
      const response = await withRouteOwnedIdentityAdmission(
        request(),
        async () => new Response('feed'),
        { createUserClient: () => client() },
        () => work,
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(work.release).toHaveBeenCalledOnce());
    });

    it('starts nothing for a request without a token, or a token refused before the round trip', async () => {
      const besideLifecycle = vi.fn(() => started(Promise.resolve()));
      const after = afterResponse();
      const tokenless = request();
      tokenless.headers.delete('authorization');
      const invalid = client();
      invalid.auth.getClaims.mockResolvedValue({ data: null, error: new Error('bad token') } as never);
      const agent = client(undefined, null, { sub: USER_ID, role: 'authenticated', client_id: 'client-claude' });

      expect((await withRouteOwnedIdentityAdmission(tokenless, async () => new Response('feed'), {}, besideLifecycle, after.schedule)).status).toBe(200);
      expect((await withRouteOwnedIdentityAdmission(request(), async () => new Response('feed'), { createUserClient: () => invalid }, besideLifecycle, after.schedule)).status).toBe(401);
      expect((await withRouteOwnedIdentityAdmission(request(), async () => new Response('feed'), { createUserClient: () => agent }, besideLifecycle, after.schedule)).status).toBe(403);
      expect(besideLifecycle).not.toHaveBeenCalled();
      expect(after.tasks).toHaveLength(0);
    });
  });

  it('rebuilds an admitted POST with its body, the fresh assertion and none of the caller\'s', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const original = request('POST', '/api/mcp', body);
    const identity = client(undefined, null, { sub: USER_ID, role: 'authenticated', is_anonymous: false });
    const admission = await evaluateUserFacingRouteIdentity(original, { createUserClient: () => identity });
    expect(admission.rejection).toBeNull();
    expect(admission.claims?.sub).toBe(USER_ID);
    const admitted = await rebuildAdmittedRequest(original, admission);
    expect(admitted.method).toBe('POST');
    expect(await admitted.text()).toBe(body);
    expect(admitted.headers.get('content-type')).toBe('application/json');
    expect(admitted.headers.get(IDENTITY_ADMISSION_HEADER)).not.toBe('forged');
    expect(admitted.headers.get(IDENTITY_ADMISSION_HEADER)).toBe(admission.assertion);
    expect(admitted.headers.get(IDENTITY_PROXY_TIMING_HEADER)).toMatch(/^route-identity;dur=/);
  });
});
