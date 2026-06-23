import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 30,
    remaining: 29,
    retryAfterSeconds: 0,
    resetAt: '2026-06-21T06:30:00.000Z',
  },
  error: null,
}));
const fromMock = vi.fn();
const adminClient = { from: fromMock, rpc: rpcMock };
const createServiceClientFactory = vi.fn(() => adminClient);
const notifyCreatorFollowedMock = vi.fn();

let followRows: Array<{ follower_id: string; following_id: string }> = [];
let profileRows: Array<{ id: string; username: string | null }> = [];

function createQuery<T extends Record<string, unknown>>(rows: T[]) {
  const filters: Record<string, unknown> = {};
  const query = {
    select() {
      return query;
    },
    eq(column: string, value: unknown) {
      filters[column] = value;
      return query;
    },
    async maybeSingle() {
      return {
        data: rows.find((row) =>
          Object.entries(filters).every(([key, value]) => row[key] === value)
        ) ?? null,
        error: null,
      };
    },
  };

  return query;
}

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyCreatorFollowed: (...args: unknown[]) => notifyCreatorFollowedMock(...args),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/profile/follow/notify route', () => {
  beforeEach(() => {
    vi.resetModules();
    followRows = [{ follower_id: 'follower-1', following_id: 'creator-1' }];
    profileRows = [{ id: 'follower-1', username: 'athul' }];
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 30,
        remaining: 29,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === 'follows') return createQuery(followRows);
      if (table === 'profiles') return createQuery(profileRows);
      throw new Error(`Unexpected table: ${table}`);
    });
    notifyCreatorFollowedMock.mockClear();
    notifyCreatorFollowedMock.mockResolvedValue(null);
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'follower-1' } },
          error: null,
        })),
      },
    });
  });

  it('does not create an admin client before authentication succeeds', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { POST } = await import('@/app/api/profile/follow/notify/route');
    const response = await POST(
      new Request('http://localhost/api/profile/follow/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-follow-notify-auth-1',
        },
        body: JSON.stringify({ followingId: 'creator-1' }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'profile-follow-notify-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });

  it('rejects self follow notifications before creating an admin client', async () => {
    const { POST } = await import('@/app/api/profile/follow/notify/route');
    const response = await POST(
      new Request('http://localhost/api/profile/follow/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: 'follower-1' }),
      }) as never
    );

    expect(response.status).toBe(400);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });

  it('rate limits follow notifications before follow lookup and notification work', async () => {
    rpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 44,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/profile/follow/notify/route');
    const response = await POST(
      new Request('http://localhost/api/profile/follow/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-follow-notify-rate-limit-1',
        },
        body: JSON.stringify({ followingId: 'creator-1' }),
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('44');
    expectPrivateNoStoreTraceHeaders(response, 'profile-follow-notify-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'creator-follow:notify',
      p_subject_key: 'follower-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(fromMock).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });

  it('notifies followed creators after passing the backend rate limit', async () => {
    const { POST } = await import('@/app/api/profile/follow/notify/route');
    const response = await POST(
      new Request('http://localhost/api/profile/follow/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-follow-notify-success-1',
        },
        body: JSON.stringify({ followingId: 'creator-1' }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-follow-notify-success-1');
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'creator-follow:notify',
      p_subject_key: 'follower-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(notifyCreatorFollowedMock).toHaveBeenCalledWith(adminClient, {
      followerUserId: 'follower-1',
      followingUserId: 'creator-1',
      followerUsername: 'athul',
    });
  });
});
