import { describe, expect, it, vi } from 'vitest';

import { getOwnerGenerationsRouteResponse } from '@/lib/owner-generations-route-adapter-service';

function createUserClient(userId: string | null = 'user-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  };
}

async function requireIdentityForTest(userClient: ReturnType<typeof createUserClient>) {
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    return { ok: false as const, status: 401, code: 'UNAUTHORIZED' as const, error: 'Unauthorized' };
  }
  return {
    ok: true as const,
    identity: { user, userId: user.id, kind: 'registered' as const, isGuest: false },
  };
}

describe('owner generations route adapter service', () => {
  it('authenticates and delegates owner generation listing with private trace headers', async () => {
    const userSupabase = createUserClient('user-1');
    const createServiceClient = vi.fn();
    const listOwnerGenerationsForRoute = vi.fn(async () => ({
      generations: [{ id: 'gen-1' }],
      pagination: { limit: 80, hasMore: false, nextCursor: null },
    }));

    const response = await getOwnerGenerationsRouteResponse({
      request: new Request('http://localhost/api/generations?limit=2&detail=summary', {
        headers: { 'x-request-id': 'owner-generations-1' },
      }),
      dependencies: {
        createServiceClient,
        createUserClient: vi.fn(() => userSupabase as never),
        enforceBackendRateLimit: vi.fn(),
        listOwnerGenerationsForRoute,
        requireIdentity: requireIdentityForTest as never,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-generations-1');
    await expect(response.json()).resolves.toEqual({
      generations: [{ id: 'gen-1' }],
      pagination: { limit: 80, hasMore: false, nextCursor: null },
    });
    expect(listOwnerGenerationsForRoute).toHaveBeenCalledWith({
      userId: 'user-1',
      supabase: userSupabase,
      getAdminSupabase: expect.any(Function),
      searchParams: new URLSearchParams('limit=2&detail=summary'),
    });
    // Exactly one, for the read limiter. Rate-limit state is service-role only,
    // so throttling this endpoint costs a privileged client per request, where
    // it used to be created lazily and often not at all. The read service still
    // receives the factory rather than an instance, so it builds no second one.
    expect(createServiceClient).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthenticated requests before service or privileged client work', async () => {
    const createServiceClient = vi.fn();
    const listOwnerGenerationsForRoute = vi.fn();

    const response = await getOwnerGenerationsRouteResponse({
      request: new Request('http://localhost/api/generations', {
        headers: {
          Authorization: 'Bearer private-token',
          'x-request-id': 'owner-generations-auth-1',
        },
      }),
      dependencies: {
        createServiceClient,
        createUserClient: vi.fn(() => createUserClient(null) as never),
        listOwnerGenerationsForRoute,
        requireIdentity: requireIdentityForTest as never,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-generations-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(listOwnerGenerationsForRoute).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('maps unexpected owner generation failures to stable private responses', async () => {
    const logError = vi.fn();

    const response = await getOwnerGenerationsRouteResponse({
      request: new Request('http://localhost/api/generations', {
        headers: { 'x-request-id': 'owner-generations-error-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: vi.fn(() => createUserClient('user-1') as never),
        enforceBackendRateLimit: vi.fn(),
        listOwnerGenerationsForRoute: vi.fn(async () => {
          throw new Error('database tired');
        }),
        logError,
        requireIdentity: requireIdentityForTest as never,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-generations-error-1');
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith('Error fetching generations:', expect.any(Error));
  });

  it('rejects a merged session before privileged owner hydration', async () => {
    const listOwnerGenerationsForRoute = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const response = await getOwnerGenerationsRouteResponse({
      request: new Request('http://localhost/api/generations'),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: vi.fn(() => createUserClient('guest-1') as never),
        enforceBackendRateLimit,
        listOwnerGenerationsForRoute,
        requireIdentity: vi.fn(async () => ({
          ok: false as const,
          status: 409 as const,
          code: 'SESSION_MERGED' as const,
          error: 'This guest session has been linked to an account. Sign in to continue.',
        })),
      },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(listOwnerGenerationsForRoute).not.toHaveBeenCalled();
  });
});
