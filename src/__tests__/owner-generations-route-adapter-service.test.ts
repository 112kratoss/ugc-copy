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
        listOwnerGenerationsForRoute,
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
      getAdminSupabase: createServiceClient,
      searchParams: new URLSearchParams('limit=2&detail=summary'),
    });
    expect(createServiceClient).not.toHaveBeenCalled();
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
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-generations-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
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
        listOwnerGenerationsForRoute: vi.fn(async () => {
          throw new Error('database tired');
        }),
        logError,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-generations-error-1');
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith('Error fetching generations:', expect.any(Error));
  });
});
