import { describe, expect, it, vi } from 'vitest';

import {
  MOBILE_NOTIFICATION_INBOX_FILTER_COLUMNS,
  MOBILE_NOTIFICATION_INBOX_SELECT,
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
    is: vi.fn(() => listQuery),
    order: vi.fn(() => listQuery),
    limit: vi.fn(() => listQuery),
    lt: vi.fn(() => listQuery),
    lte: vi.fn(() => listQuery),
    or: vi.fn(() => listQuery),
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
        is_read: true,
        created_at: '2026-06-22T06:00:00.000Z',
        last_event_at: '2026-06-22T06:01:00.000Z',
        // Stamped when the alert was read, half an hour after its last event.
        updated_at: '2026-06-22T06:30:00.000Z',
      }],
      error: listError,
    }),
  };
  const unreadQuery = {
    eq: vi.fn(() => unreadQuery),
    is: vi.fn(() => unreadQuery),
    ...resolvedQuery({ count: 7, data: null, error: unreadError }),
  };
  const listSelect = vi.fn<(fields: string) => typeof listQuery>(() => listQuery);
  const updateCalls: Array<{
    values: Record<string, unknown>;
    eqFilters: Array<[string, unknown]>;
    inFilters: Array<[string, unknown[]]>;
  }> = [];

  return {
    listQuery,
    listSelect,
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
          select(fields: string, options?: Record<string, unknown>) {
            return options?.head ? unreadQuery : listSelect(fields);
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

type InboxRow = { id: string; last_event_at: string };

/**
 * The inbox as PostgREST would answer it: the filters the service writes,
 * applied to these rows of user-1's, in the inbox order (last event, then id,
 * both descending). Timestamps share one format, so they compare as text.
 */
function createPagedInboxClient(rows: InboxRow[]) {
  const compare = (operator: string, left: string, right: string) => (
    operator === 'lt' ? left < right : operator === 'lte' ? left <= right : left === right
  );
  const listQuery = () => {
    const filters: Array<(row: InboxRow & { user_id: string }) => boolean> = [];
    let limit = Infinity;
    const query = {
      eq: (column: string, value: string) => {
        filters.push((row) => (row as Record<string, string>)[column] === value);
        return query;
      },
      lt: (column: string, value: string) => {
        filters.push((row) => compare('lt', (row as Record<string, string>)[column], value));
        return query;
      },
      lte: (column: string, value: string) => {
        filters.push((row) => compare('lte', (row as Record<string, string>)[column], value));
        return query;
      },
      or: (expression: string) => {
        const clauses = expression.split(',').map((clause) => {
          const [column, operator, ...value] = clause.split('.');
          return { column, operator, value: value.join('.') };
        });
        filters.push((row) => clauses.some(({ column, operator, value }) => (
          compare(operator, (row as Record<string, string>)[column], value)
        )));
        return query;
      },
      order: () => query,
      limit: (count: number) => {
        limit = count;
        return query;
      },
      then<TResult>(onfulfilled: (value: { data: unknown[]; error: null }) => TResult) {
        const data = rows
          .map((row) => ({ ...row, user_id: 'user-1' }))
          .filter((row) => filters.every((filter) => filter(row)))
          .sort((left, right) => (
            right.last_event_at.localeCompare(left.last_event_at) || right.id.localeCompare(left.id)
          ))
          .slice(0, limit)
          .map((row) => ({ ...row, type: 'post_saved', category: 'social', title: 'Saved', body: '', created_at: row.last_event_at }));
        return Promise.resolve({ data, error: null }).then(onfulfilled);
      },
    };
    return query;
  };
  const unreadQuery = {
    eq: () => unreadQuery,
    ...resolvedQuery({ count: 0, data: null, error: null }),
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => ({
      select: (_fields: string, options?: Record<string, unknown>) => (options?.head ? unreadQuery : listQuery()),
    }),
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
    expect(inbox.listQuery.lt).toHaveBeenCalledWith('last_event_at', '2026-06-22T06:02:00.000Z');
    expect(inbox.unreadQuery.eq).toHaveBeenCalledWith('is_read', false);
  });

  it('reads the list and the unread count by owner alone, in the columns the owner may read', async () => {
    // A named save that was unsaved, or one between two accounts that blocked
    // each other, is deleted with its save, not hidden in the table: there is
    // nothing for Alerts to filter out.
    const inbox = createInboxClient();

    await getMobileNotificationInboxForRoute({ userSupabase: inbox.client });

    expect(inbox.listQuery.eq.mock.calls).toEqual([['user_id', 'user-1']]);
    expect(inbox.unreadQuery.eq.mock.calls).toEqual([['user_id', 'user-1'], ['is_read', false]]);
    expect(inbox.listQuery.is).not.toHaveBeenCalled();
    expect(inbox.unreadQuery.is).not.toHaveBeenCalled();
    expect(inbox.listSelect).toHaveBeenCalledWith(MOBILE_NOTIFICATION_INBOX_SELECT);
    expect(MOBILE_NOTIFICATION_INBOX_FILTER_COLUMNS).toEqual(['user_id']);
  });

  // Marking an alert read writes its row, and every write stamps updated_at. An
  // inbox ordered by updated_at lifted each alert to the top as it was read,
  // aged "Just now".
  it('orders and ages alerts by their last event, never by the last write to the row', async () => {
    const inbox = createInboxClient();

    const result = await getMobileNotificationInboxForRoute({
      before: '2026-06-22T06:02:00.000Z',
      userSupabase: inbox.client,
    });

    expect(inbox.listQuery.order.mock.calls).toEqual([
      ['last_event_at', { ascending: false }],
      // Settles alerts that share a time, so a page never depends on chance.
      ['id', { ascending: false }],
    ]);
    expect(inbox.listQuery.lt.mock.calls).toEqual([['last_event_at', '2026-06-22T06:02:00.000Z']]);

    const fields = inbox.listSelect.mock.calls[0][0].split(', ');
    expect(fields).toContain('last_event_at');
    expect(fields).not.toContain('updated_at');

    expect(result).toMatchObject({
      ok: true,
      body: {
        notifications: [{
          id: 'notification-1',
          isRead: true,
          createdAt: '2026-06-22T06:00:00.000Z',
          updatedAt: '2026-06-22T06:01:00.000Z',
        }],
      },
    });
  });

  // A time alone skipped every alert that shared the oldest alert's time but
  // had not fit on its page. Alerts written in one transaction share it to
  // the microsecond.
  it('pages by last event and then id, so no alert sharing the cursor\'s time is skipped', async () => {
    const tied = '2026-10-14T09:02:00.500000+00:00';
    const rows: InboxRow[] = [
      { id: '00000000-0000-4000-8000-000000000001', last_event_at: '2026-10-14T09:03:00.000001+00:00' },
      { id: '00000000-0000-4000-8000-000000000005', last_event_at: tied },
      { id: '00000000-0000-4000-8000-000000000004', last_event_at: tied },
      { id: '00000000-0000-4000-8000-000000000003', last_event_at: tied },
      { id: '00000000-0000-4000-8000-000000000002', last_event_at: tied },
      { id: '00000000-0000-4000-8000-000000000006', last_event_at: '2026-10-14T09:01:00.000000+00:00' },
    ];
    const client = createPagedInboxClient(rows);

    const seen: string[] = [];
    let cursor: { before: string; beforeId: string } | null = null;
    for (let page = 0; page < 6; page += 1) {
      const result = await getMobileNotificationInboxForRoute({ ...cursor, limitValue: '2', userSupabase: client });
      if (!result.ok || !('notifications' in result.body)) throw new Error('The inbox did not answer.');
      const { notifications } = result.body;
      if (notifications.length === 0) break;
      seen.push(...notifications.map((notification) => notification.id));
      const oldest = notifications[notifications.length - 1];
      cursor = { before: oldest.updatedAt, beforeId: oldest.id };
    }

    expect(seen).toEqual(rows.map((row) => row.id));
  });

  it('keeps the time-only cursor for a caller that sends no id', async () => {
    const inbox = createInboxClient();

    await getMobileNotificationInboxForRoute({ before: '2026-06-22T06:02:00.000Z', userSupabase: inbox.client });

    expect(inbox.listQuery.lt).toHaveBeenCalledWith('last_event_at', '2026-06-22T06:02:00.000Z');
    expect(inbox.listQuery.or).not.toHaveBeenCalled();
  });

  it('writes the cursor into the filter only in its exact shapes', async () => {
    const id = '00000000-0000-4000-8000-000000000005';
    for (const cursor of [
      { before: '2026-06-22T06:02:00.000Z,user_id.neq.user-1', beforeId: id },
      { before: '2026-06-22T06:02:00.000Z', beforeId: 'id),or(id.gt.0' },
      { before: '2026-06-22 06:02:00+00', beforeId: id },
    ]) {
      const inbox = createInboxClient();

      await getMobileNotificationInboxForRoute({ ...cursor, userSupabase: inbox.client });

      expect(inbox.listQuery.or).not.toHaveBeenCalled();
      expect(inbox.listQuery.lt).toHaveBeenCalledWith('last_event_at', cursor.before);
    }

    const inbox = createInboxClient();
    await getMobileNotificationInboxForRoute({ before: '2026-06-22T06:02:00.123456+00:00', beforeId: id, userSupabase: inbox.client });
    expect(inbox.listQuery.lte).toHaveBeenCalledWith('last_event_at', '2026-06-22T06:02:00.123456+00:00');
    expect(inbox.listQuery.or).toHaveBeenCalledWith(`last_event_at.lt.2026-06-22T06:02:00.123456+00:00,id.lt.${id}`);
    expect(inbox.listQuery.lt).not.toHaveBeenCalled();
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
