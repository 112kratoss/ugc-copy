import type { SupabaseClient, User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { HomeShelfUnavailableError } = await import('@/lib/home-shelf-server');
const { getHomeShelfRouteResponse } = await import('@/lib/home-shelf-route-adapter-service');

/** The route with every dependency stood in; the user lookup answers what the test says. */
function call({
  authorization = 'Bearer token',
  lookup = { data: { user: { id: 'user-2', is_anonymous: false } as Pick<User, 'id' | 'is_anonymous'> | null }, error: null as unknown },
  loadHomeShelfForApi = vi.fn(async () => []),
}: {
  authorization?: string | null;
  lookup?: { data: { user: Pick<User, 'id' | 'is_anonymous'> | null }; error: unknown };
  loadHomeShelfForApi?: ReturnType<typeof vi.fn>;
} = {}) {
  return getHomeShelfRouteResponse({
    request: new Request('http://localhost/api/home/shelf', {
      headers: authorization ? { Authorization: authorization } : {},
    }),
    dependencies: {
      createServiceClient: vi.fn(() => ({}) as unknown as SupabaseClient),
      createUserClient: vi.fn(() => ({ auth: { getUser: async () => lookup } }) as unknown as SupabaseClient),
      enforceBackendRateLimit: vi.fn(async () => ({
        allowed: true,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 0,
        resetAt: '2026-10-26T06:10:00.000Z',
      })),
      getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
      loadHomeShelfForApi: loadHomeShelfForApi as never,
      logError: vi.fn(),
    },
  });
}

describe('/api/home/shelf', () => {
  it('answers a shelf it could not read with an error nothing keeps, not an empty shelf', async () => {
    const response = await call({
      loadHomeShelfForApi: vi.fn(async () => {
        throw new HomeShelfUnavailableError('The shelf could not be read.');
      }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it("does not answer a token whose user cannot be read as signed out, which would skip that viewer's blocks", async () => {
    const loadHomeShelfForApi = vi.fn(async () => []);
    const response = await call({
      lookup: { data: { user: null }, error: new Error('auth is unavailable') },
      loadHomeShelfForApi,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(loadHomeShelfForApi).not.toHaveBeenCalled();
  });

  it('reads a guest token as a guest, and no token as signed out', async () => {
    const guest = vi.fn(async () => []);
    await call({ lookup: { data: { user: { id: 'guest-1', is_anonymous: true } }, error: null }, loadHomeShelfForApi: guest });
    expect(guest).toHaveBeenCalledWith({ viewerUserId: 'guest-1', isAnonymous: true });

    const signedOut = vi.fn(async () => []);
    await call({ authorization: null, loadHomeShelfForApi: signedOut });
    expect(signedOut).toHaveBeenCalledWith({ viewerUserId: null, isAnonymous: false });
  });
});
