import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
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
  userBlocks = [] as Array<{ blocker_user_id: string; blocked_user_id: string }>,
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
    if (table === 'user_blocks') {
      const filters: Record<string, unknown> = {};
      const inFilters: Record<string, unknown[]> = {};
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        in(column: string, values: unknown[]) {
          inFilters[column] = values;
          return query;
        },
        then(resolve: (value: { data: typeof userBlocks; error: null }) => void) {
          resolve({
            data: userBlocks.filter((row) => (
              Object.entries(filters).every(([column, value]) => row[column as keyof typeof row] === value)
              && Object.entries(inFilters).every(([column, values]) => values.includes(row[column as keyof typeof row]))
            )),
            error: null,
          });
        },
      };
      return query;
    }

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

  it('does not allow a follow across a block in either direction', async () => {
    const client = createClient({
      userBlocks: [{ blocker_user_id: 'creator-1', blocked_user_id: 'follower-1' }],
    });

    await expect(updateCreatorFollowForRoute({
      adminSupabase: client.client,
      followerId: 'follower-1',
      body: { followingId: 'creator-1', following: true },
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Creator not found.' },
    });
    expect(client.insertFollow).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
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

  it('suppresses standalone follow notifications across a block in either direction', async () => {
    const client = createClient({
      rateLimitLimit: 30,
      initialFollows: [{ follower_id: 'follower-1', following_id: 'creator-1' }],
      userBlocks: [{ blocker_user_id: 'creator-1', blocked_user_id: 'follower-1' }],
    });

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

describe('creator follow notifications', () => {
  // The real notifier runs here against held notification history: one
  // notification, to the creator who was followed.
  const existingFollow = { follower_id: 'follower-1', following_id: 'creator-1' };
  const followDedupeKey = 'creator-follow:follower-1:creator-1';
  const followNotification = expect.objectContaining({
    user_id: 'creator-1',
    actor_user_id: 'follower-1',
    type: 'creator_followed',
    category: 'social',
    body: '@athul followed you.',
    dedupe_key: followDedupeKey,
  });

  // Both routes end by telling the creator: the follow itself, and the
  // standalone notification for a follow that is already in the table.
  const notifyingRequests = [
    {
      kind: 'a new follow',
      send: updateCreatorFollowForRoute,
      body: { followingId: 'creator-1', following: true },
      initialFollows: [] as Array<typeof existingFollow>,
      answer: { ok: true, body: { following: true } },
    },
    {
      kind: 'a standalone follow notification',
      send: notifyCreatorFollowForRoute,
      body: { followingId: 'creator-1' },
      initialFollows: [existingFollow],
      answer: { ok: true, body: { success: true } },
    },
  ];

  beforeEach(async () => {
    const { notifyCreatorFollowed } = await vi.importActual<typeof import('@/lib/mobile-notifications')>(
      '@/lib/mobile-notifications',
    );
    notifyCreatorFollowedMock.mockReset();
    notifyCreatorFollowedMock.mockImplementation(notifyCreatorFollowed);
  });

  it.each(notifyingRequests)(
    'answers $kind before the creator is told when the caller can run work after the response',
    async ({ send, body, initialFollows, answer }) => {
      // The notification ends in a push request to Expo for the creator's
      // devices. In production on 2026-10-01, before an account's devices went
      // out in one request, one with 32 held an unlock's answer for 14 s. Here
      // the person waiting on that request is the follower.
      const client = createClient({ initialFollows });
      const history = createMobileNotificationHistory();
      history.hold();
      const deferred: Array<() => Promise<unknown>> = [];

      const request = send({
        adminSupabase: withMobileNotificationHistory(client.client, history),
        followerId: 'follower-1',
        body,
        runAfterResponse: (task) => { deferred.push(task); },
      });

      // A notification that has not finished no longer holds the answer back,
      // and the follow behind that answer is recorded as it always was.
      expect(await hasAnswered(request)).toBe(true);
      await expect(request).resolves.toEqual(answer);
      expect(client.followRows).toEqual([existingFollow]);
      expect(history.started).toEqual([]);
      expect(deferred).toHaveLength(1);

      history.release();
      await deferred[0]();
      expect(history.sent).toEqual([followNotification]);
    },
  );

  it.each(notifyingRequests)(
    'tells the creator before answering $kind when the caller has nowhere to run it afterwards',
    async ({ send, body, initialFollows, answer }) => {
      const client = createClient({ initialFollows });
      const history = createMobileNotificationHistory();
      history.hold();

      const request = send({
        adminSupabase: withMobileNotificationHistory(client.client, history),
        followerId: 'follower-1',
        body,
      });

      expect(await hasAnswered(request)).toBe(false);
      expect(history.started).toEqual([followDedupeKey]);

      history.release();
      await expect(request).resolves.toEqual(answer);
      expect(client.followRows).toEqual([existingFollow]);
      expect(history.sent).toEqual([followNotification]);
    },
  );

  it.each([
    {
      kind: 'a follow that already exists',
      send: updateCreatorFollowForRoute,
      body: { followingId: 'creator-1', following: true },
      options: { initialFollows: [existingFollow] },
    },
    {
      kind: 'an unfollow',
      send: updateCreatorFollowForRoute,
      body: { followingId: 'creator-1', following: false },
      options: { initialFollows: [existingFollow] },
    },
    {
      kind: 'a follow across a block',
      send: updateCreatorFollowForRoute,
      body: { followingId: 'creator-1', following: true },
      options: { userBlocks: [{ blocker_user_id: 'creator-1', blocked_user_id: 'follower-1' }] },
    },
    {
      kind: 'a follow over the rate limit',
      send: updateCreatorFollowForRoute,
      body: { followingId: 'creator-1', following: true },
      options: { rateLimitAllowed: false },
    },
    {
      kind: 'a standalone notification for a follow that is gone',
      send: notifyCreatorFollowForRoute,
      body: { followingId: 'creator-1' },
      options: { rateLimitLimit: 30 },
    },
  ])('defers nothing for $kind', async ({ send, body, options }) => {
    const client = createClient(options);
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();

    await send({
      adminSupabase: withMobileNotificationHistory(client.client, history),
      followerId: 'follower-1',
      body,
      runAfterResponse,
    });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it.each(notifyingRequests)(
    'tells the creator in front of the answer rather than fail $kind when the task cannot be queued',
    async ({ send, body, initialFollows, answer }) => {
      const client = createClient({ initialFollows });
      const history = createMobileNotificationHistory();
      const logged: BackendLogRecord[] = [];
      const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

      try {
        // The follow is already in the table. A scheduler that will not take
        // the task must not turn that into a failed request.
        await expect(send({
          adminSupabase: withMobileNotificationHistory(client.client, history),
          followerId: 'follower-1',
          body,
          runAfterResponse: () => {
            throw new Error('`after` was called outside a request scope.');
          },
        })).resolves.toEqual(answer);
      } finally {
        restoreLogSink();
      }

      expect(client.followRows).toEqual([existingFollow]);
      expect(history.sent).toEqual([followNotification]);
      expect(logged).toEqual([
        expect.objectContaining({
          level: 'error',
          msg: 'mobile_notification_deferral_failed',
          errorMessage: '`after` was called outside a request scope.',
        }),
      ]);
    },
  );
});
