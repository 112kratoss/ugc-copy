import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 60,
    remaining: 59,
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

function createFollowQuery() {
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
        data: followRows.find((row) =>
          Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value)
        ) ?? null,
        error: null,
      };
    },
    async insert(value: { follower_id: string; following_id: string }) {
      followRows.push(value);
      return { error: null };
    },
    delete() {
      return {
        eq(column: string, value: unknown) {
          filters[column] = value;
          return this;
        },
        async then(resolve: (value: { error: null }) => void) {
          followRows = followRows.filter((row) =>
            !Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value)
          );
          resolve({ error: null });
        },
      };
    },
  };

  return query;
}

function createProfileQuery() {
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
        data: profileRows.find((row) =>
          Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value)
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

describe('/api/profile/follow route', () => {
  beforeEach(() => {
    vi.resetModules();
    followRows = [];
    profileRows = [{ id: 'follower-1', username: 'athul' }];
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 60,
        remaining: 59,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === 'follows') return createFollowQuery();
      if (table === 'profiles') return createProfileQuery();
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

  it('loads follow state through the backend without mutating or notifying', async () => {
    followRows = [{ follower_id: 'follower-1', following_id: 'creator-1' }];

    const { GET } = await import('@/app/api/profile/follow/route');
    const response = await GET(
      new Request('http://localhost/api/profile/follow?followingId=creator-1', {
        headers: { 'x-request-id': 'profile-follow-get-1' },
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-follow-get-1');
    await expect(response.json()).resolves.toEqual({ following: true });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
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

    const { POST } = await import('@/app/api/profile/follow/route');
    const response = await POST(
      new Request('http://localhost/api/profile/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-follow-auth-1',
        },
        body: JSON.stringify({ followingId: 'creator-1', following: true }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'profile-follow-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });

  it('creates follows and notifies the creator after backend rate limiting', async () => {
    const { POST } = await import('@/app/api/profile/follow/route');
    const response = await POST(
      new Request('http://localhost/api/profile/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-follow-success-1',
        },
        body: JSON.stringify({ followingId: 'creator-1', following: true }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-follow-success-1');
    await expect(response.json()).resolves.toEqual({ following: true });
    expect(followRows).toContainEqual({ follower_id: 'follower-1', following_id: 'creator-1' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'creator-follow:mutate',
      p_subject_key: 'follower-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(notifyCreatorFollowedMock).toHaveBeenCalledWith(adminClient, {
      followerUserId: 'follower-1',
      followingUserId: 'creator-1',
      followerUsername: 'athul',
    });
  });

  it('removes follows without sending follow notifications', async () => {
    followRows = [{ follower_id: 'follower-1', following_id: 'creator-1' }];

    const { POST } = await import('@/app/api/profile/follow/route');
    const response = await POST(
      new Request('http://localhost/api/profile/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: 'creator-1', following: false }),
      }) as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ following: false });
    expect(followRows).toEqual([]);
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });
});
