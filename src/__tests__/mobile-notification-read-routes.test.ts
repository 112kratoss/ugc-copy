import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const updateCalls: Array<{
  table: string;
  values: Record<string, unknown>;
  eqFilters: Array<[string, unknown]>;
  inFilters: Array<[string, unknown[]]>;
}> = [];

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

function createUserSupabaseMock() {
  return {
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
        update(values: Record<string, unknown>) {
          const call = {
            table,
            values,
            eqFilters: [] as Array<[string, unknown]>,
            inFilters: [] as Array<[string, unknown[]]>,
            error: null as null,
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
  };
}

describe('mobile notification read routes', () => {
  beforeEach(() => {
    vi.resetModules();
    updateCalls.length = 0;
    createUserClientMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    createUserClientMock.mockReturnValue(createUserSupabaseMock());
    createServiceClientMock.mockReturnValue({ rpc: rateLimitRpcMock });
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
  });

  it('rate limits before marking selected mobile notifications read', async () => {
    const { POST } = await import('@/app/api/mobile/notifications/read/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/read', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-read-selected-success-1',
        },
        body: JSON.stringify({ ids: ['notification-1', 'notification-2'] }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-read-selected-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notifications:read',
      p_subject_key: 'user-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([
      {
        table: 'mobile_notifications',
        values: { is_read: true },
        eqFilters: [['user_id', 'user-1']],
        inFilters: [['id', ['notification-1', 'notification-2']]],
        error: null,
        eq: expect.any(Function),
        in: expect.any(Function),
      },
    ]);
  });

  it('returns 429 before marking selected notifications read when the backend limit is exhausted', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 120,
        remaining: 0,
        retryAfterSeconds: 18,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/mobile/notifications/read/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/read', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-read-selected-rate-limit-1',
        },
        body: JSON.stringify({ ids: ['notification-1'] }),
      }) as never
    );
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('18');
    expectPrivateNoStoreTraceHeaders(response, 'mobile-read-selected-rate-limit-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 18,
    });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notifications:read',
      p_subject_key: 'user-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([]);
  });

  it('rate limits before marking all mobile notifications read', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 30,
        remaining: 29,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/mobile/notifications/read-all/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/read-all', {
        method: 'POST',
        headers: { 'x-request-id': 'mobile-read-all-success-1' },
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-read-all-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notifications:read-all',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([
      {
        table: 'mobile_notifications',
        values: { is_read: true },
        eqFilters: [
          ['user_id', 'user-1'],
          ['is_read', false],
        ],
        inFilters: [],
        error: null,
        eq: expect.any(Function),
        in: expect.any(Function),
      },
    ]);
  });

  it('returns 429 before marking all notifications read when the backend limit is exhausted', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 55,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/mobile/notifications/read-all/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/read-all', {
        method: 'POST',
        headers: { 'x-request-id': 'mobile-read-all-rate-limit-1' },
      }) as never
    );
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('55');
    expectPrivateNoStoreTraceHeaders(response, 'mobile-read-all-rate-limit-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 55,
    });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notifications:read-all',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([]);
  });
});
