import { describe, expect, it, vi } from 'vitest';

import {
  getMobileNotificationInboxForRoute,
  markAllMobileNotificationsReadForRoute,
  markMobileNotificationsReadForRoute,
} from '@/lib/mobile-notification-inbox-service';

function resolvedQuery<T>(result: T) {
  return {
    then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
}

function createRateLimitClient(allowed = true) {
  return {
    rpc: vi.fn(async () => ({
      data: {
        allowed,
        limit: 120,
        remaining: allowed ? 119 : 0,
        retryAfterSeconds: allowed ? 0 : 18,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    })),
  };
}

function createInboxClient({
  authenticated = true,
  listError = null,
  mutationError = null,
  unreadError = null,
}: {
  authenticated?: boolean;
  listError?: Error | null;
  mutationError?: Error | null;
  unreadError?: Error | null;
} = {}) {
  const listQuery = {
    eq: vi.fn(() => listQuery),
    order: vi.fn(() => listQuery),
    limit: vi.fn(() => listQuery),
    lt: vi.fn(() => listQuery),
    ...resolvedQuery({
      data: [{
        id: 'notification-1',
        type: 'credits_purchased',
        category: 'commerce',
        title: 'Credits added',
        body: 'Your credits are ready.',
        deep_link: '/pricing',
        object_type: 'transaction',
        object_id: 'txn-1',
        event_count: 1,
        is_read: false,
        created_at: '2026-06-22T06:00:00.000Z',
        updated_at: '2026-06-22T06:01:00.000Z',
      }],
      error: listError,
    }),
  };
  const unreadQuery = {
    eq: vi.fn(() => unreadQuery),
    ...resolvedQuery({ count: 7, data: null, error: unreadError }),
  };
  const updateCalls: Array<{
    values: Record<string, unknown>;
    eqFilters: Array<[string, unknown]>;
    inFilters: Array<[string, unknown[]]>;
  }> = [];

  return {
    listQuery,
    unreadQuery,
    updateCalls,
    client: {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: authenticated ? { id: 'user-1' } : null },
          error: authenticated ? null : new Error('missing session'),
        })),
      },
      from(table: string) {
        expect(table).toBe('mobile_notifications');
        return {
          select(_fields: string, options?: Record<string, unknown>) {
            return options?.head ? unreadQuery : listQuery;
          },
          update(values: Record<string, unknown>) {
            const call = {
              values,
              eqFilters: [] as Array<[string, unknown]>,
              inFilters: [] as Array<[string, unknown[]]>,
              error: mutationError,
              eq(column: string, value: unknown) {
                call.eqFilters.push([column, value]);
                return call;
              },
              in(column: string, values: unknown[]) {
                call.inFilters.push([column, values]);
                return call;
              },
            };
            updateCalls.push(call);
            return call;
          },
        };
      },
    },
  };
}

describe('mobile notification inbox service', () => {
  it('loads a bounded cursor page and unread count for the authenticated user', async () => {
    const inbox = createInboxClient();

    await expect(getMobileNotificationInboxForRoute({
      before: '2026-06-22T06:02:00.000Z',
      limitValue: '999',
      userSupabase: inbox.client,
    })).resolves.toMatchObject({
      ok: true,
      body: {
        success: true,
        unreadCount: 7,
        notifications: [{ id: 'notification-1', deepLink: '/pricing' }],
      },
    });

    expect(inbox.listQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(inbox.listQuery.limit).toHaveBeenCalledWith(80);
    expect(inbox.listQuery.lt).toHaveBeenCalledWith('updated_at', '2026-06-22T06:02:00.000Z');
    expect(inbox.unreadQuery.eq).toHaveBeenCalledWith('is_read', false);
  });

  it('rejects unauthenticated inbox reads before querying notifications', async () => {
    const inbox = createInboxClient({ authenticated: false });

    await expect(getMobileNotificationInboxForRoute({
      userSupabase: inbox.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Unauthorized' },
      status: 401,
    });

    expect(inbox.listQuery.eq).not.toHaveBeenCalled();
  });

  it('returns the stable inbox failure when list or unread-count queries fail', async () => {
    const inbox = createInboxClient({ unreadError: new Error('count failed') });

    await expect(getMobileNotificationInboxForRoute({
      userSupabase: inbox.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Failed to load notifications.' },
      status: 500,
    });
  });

  it('validates selected notification ids before creating the rate-limit client', async () => {
    const inbox = createInboxClient();
    const getAdminSupabase = vi.fn();

    await expect(markMobileNotificationsReadForRoute({
      getAdminSupabase,
      requestBody: { ids: ['', 42] },
      userSupabase: inbox.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Missing notification IDs.' },
      status: 400,
    });

    expect(getAdminSupabase).not.toHaveBeenCalled();
    expect(inbox.updateCalls).toEqual([]);
  });

  it('rate limits before marking selected notifications read', async () => {
    const inbox = createInboxClient();
    const adminSupabase = createRateLimitClient();

    await expect(markMobileNotificationsReadForRoute({
      getAdminSupabase: () => adminSupabase,
      requestBody: { ids: ['notification-1', 'notification-2'] },
      userSupabase: inbox.client,
    })).resolves.toEqual({ ok: true, body: { success: true } });

    expect(adminSupabase.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notifications:read',
      p_subject_key: 'user-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(inbox.updateCalls[0]).toMatchObject({
      values: { is_read: true },
      eqFilters: [['user_id', 'user-1']],
      inFilters: [['id', ['notification-1', 'notification-2']]],
    });
  });

  it('returns a rate-limit error before marking all notifications read', async () => {
    const inbox = createInboxClient();
    const adminSupabase = createRateLimitClient(false);

    const result = await markAllMobileNotificationsReadForRoute({
      getAdminSupabase: () => adminSupabase,
      userSupabase: inbox.client,
    });

    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(result).toHaveProperty('rateLimitError');
    expect(inbox.updateCalls).toEqual([]);
    expect(adminSupabase.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notifications:read-all',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
  });
});
