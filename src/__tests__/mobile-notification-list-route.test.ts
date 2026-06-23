import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const createUserClientMock = vi.fn();

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

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

function createListQuery() {
  const query = {
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    lt: vi.fn(() => query),
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
      error: null,
    }),
  };

  return query;
}

function createUnreadCountQuery() {
  const query = {
    eq: vi.fn(() => query),
    ...resolvedQuery({
      count: 7,
      data: null,
      error: null,
    }),
  };

  return query;
}

function createUserSupabaseMock() {
  const listQuery = createListQuery();
  const unreadCountQuery = createUnreadCountQuery();

  return {
    listQuery,
    unreadCountQuery,
    client: {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
      from(table: string) {
        if (table !== 'mobile_notifications') {
          throw new Error(`Unexpected table ${table}`);
        }

        return {
          select(fields: string, options?: Record<string, unknown>) {
            if (options?.head) {
              expect(fields).toBe('id');
              expect(options).toEqual({ count: 'exact', head: true });
              return unreadCountQuery;
            }

            expect(fields).toContain('id, type, category');
            return listQuery;
          },
        };
      },
    },
  };
}

describe('/api/mobile/notifications route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
  });

  it('returns private trace headers when notification list authentication fails', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { GET } = await import('@/app/api/mobile/notifications/route');
    const response = await GET(new NextRequest('http://localhost/api/mobile/notifications', {
      headers: { 'x-request-id': 'mobile-notifications-auth-1' },
    }));

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-notifications-auth-1');
  });

  it('returns a private traceable notification list for authenticated users', async () => {
    const supabase = createUserSupabaseMock();
    createUserClientMock.mockReturnValueOnce(supabase.client);

    const { GET } = await import('@/app/api/mobile/notifications/route');
    const response = await GET(new NextRequest('http://localhost/api/mobile/notifications?limit=10&before=2026-06-22T06:02:00.000Z', {
      headers: { 'x-request-id': 'mobile-notifications-list-1' },
    }));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-notifications-list-1');
    await expect(response.json()).resolves.toEqual(mobileApiContract.endpoints.mobileNotifications.response);
    expect(supabase.listQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(supabase.listQuery.order).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(supabase.listQuery.limit).toHaveBeenCalledWith(10);
    expect(supabase.listQuery.lt).toHaveBeenCalledWith('updated_at', '2026-06-22T06:02:00.000Z');
    expect(supabase.unreadCountQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(supabase.unreadCountQuery.eq).toHaveBeenCalledWith('is_read', false);
  });
});
