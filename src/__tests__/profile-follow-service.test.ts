import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCreatorFollowStateForRoute,
  notifyCreatorFollowForRoute,
  updateCreatorFollowForRoute,
  type ProfileFollowServiceClient,
} from '@/lib/profile-follow-service';

const notifyCreatorFollowedMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/mobile-notifications', () => ({
  notifyCreatorFollowed: (...args: unknown[]) => notifyCreatorFollowedMock(...args),
}));

function createClient({
  rateLimitAllowed = true,
  rateLimitLimit = 60,
  initialFollows = [] as Array<{ follower_id: string; following_id: string }>,
  profileRows = [{ id: 'follower-1', username: 'athul' }] as Array<{ id: string; username: string | null }>,
} = {}) {
  let followRows = [...initialFollows];
  const rpc = vi.fn(async () => ({
    data: {
      allowed: rateLimitAllowed,
      limit: rateLimitLimit,
      remaining: rateLimitAllowed ? rateLimitLimit - 1 : 0,
      retryAfterSeconds: rateLimitAllowed ? 0 : 41,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const insertFollow = vi.fn(async (value: { follower_id: string; following_id: string }) => {
    followRows.push(value);
    return { error: null };
  });
  const deleteFollow = vi.fn();

  const from = vi.fn((table: string) => {
    if (table === 'follows') {
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
        insert: insertFollow,
        delete() {
          return {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return this;
            },
            async then(resolve: (value: { error: null }) => void) {
              deleteFollow({ ...filters });
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

    if (table === 'profiles') {
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

    throw new Error(`Unexpected table: ${table}`);
  });

  return {
    client: { from, rpc } as unknown as ProfileFollowServiceClient,
    from,
    rpc,
    insertFollow,
    deleteFollow,
    get followRows() {
      return followRows;
    },
  };
}

describe('profile follow service', () => {
  beforeEach(() => {
    notifyCreatorFollowedMock.mockReset();
    notifyCreatorFollowedMock.mockResolvedValue(null);
  });

  it('loads follow state without rate limiting or notifying', async () => {
    const client = createClient({
      initialFollows: [{ follower_id: 'follower-1', following_id: 'creator-1' }],
    });

    await expect(getCreatorFollowStateForRoute({
      adminSupabase: client.client,
      followerId: 'follower-1',
      followingId: 'creator-1',
    })).resolves.toEqual({
      ok: true,
      body: { following: true },
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });

  it('rate limits follow mutations before lookup or persistence', async () => {
    const client = createClient({ rateLimitAllowed: false });

    const result = await updateCreatorFollowForRoute({
      adminSupabase: client.client,
      followerId: 'follower-1',
      body: { followingId: 'creator-1', following: true },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: { code: 'RATE_LIMITED', retryAfterSeconds: 41 },
    });
    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'creator-follow:mutate',
      p_subject_key: 'follower-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(client.from).not.toHaveBeenCalled();
    expect(client.insertFollow).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });

  it('creates new follows and notifies creators with the follower username', async () => {
    const client = createClient();

    const result = await updateCreatorFollowForRoute({
      adminSupabase: client.client,
      followerId: 'follower-1',
      body: { followingId: 'creator-1', following: true },
    });

    expect(result).toEqual({
      ok: true,
      body: { following: true },
    });
    expect(client.followRows).toContainEqual({ follower_id: 'follower-1', following_id: 'creator-1' });
    expect(notifyCreatorFollowedMock).toHaveBeenCalledWith(client.client, {
      followerUserId: 'follower-1',
      followingUserId: 'creator-1',
      followerUsername: 'athul',
    });
  });

  it('rate limits standalone follow notifications before lookup or notification work', async () => {
    const client = createClient({ rateLimitAllowed: false, rateLimitLimit: 30 });

    const result = await notifyCreatorFollowForRoute({
      adminSupabase: client.client,
      followerId: 'follower-1',
      body: { followingId: 'creator-1' },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: { code: 'RATE_LIMITED', retryAfterSeconds: 41 },
    });
    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'creator-follow:notify',
      p_subject_key: 'follower-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(client.from).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });

  it('verifies an existing follow before sending a standalone notification', async () => {
    const client = createClient({
      rateLimitLimit: 30,
      initialFollows: [{ follower_id: 'follower-1', following_id: 'creator-1' }],
    });

    await expect(notifyCreatorFollowForRoute({
      adminSupabase: client.client,
      followerId: 'follower-1',
      body: { followingId: 'creator-1' },
    })).resolves.toEqual({
      ok: true,
      body: { success: true },
    });
    expect(notifyCreatorFollowedMock).toHaveBeenCalledWith(client.client, {
      followerUserId: 'follower-1',
      followingUserId: 'creator-1',
      followerUsername: 'athul',
    });
  });

  it('rejects standalone notifications when the follow no longer exists', async () => {
    const client = createClient({ rateLimitLimit: 30 });

    await expect(notifyCreatorFollowForRoute({
      adminSupabase: client.client,
      followerId: 'follower-1',
      body: { followingId: 'creator-1' },
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Follow not found.' },
    });
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });

  it('removes follows without sending notifications', async () => {
    const client = createClient({
      initialFollows: [{ follower_id: 'follower-1', following_id: 'creator-1' }],
    });

    await expect(updateCreatorFollowForRoute({
      adminSupabase: client.client,
      followerId: 'follower-1',
      body: { followingId: 'creator-1', following: false },
    })).resolves.toEqual({
      ok: true,
      body: { following: false },
    });
    expect(client.followRows).toEqual([]);
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });
});
