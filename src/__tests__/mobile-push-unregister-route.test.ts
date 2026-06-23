import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const updateCalls: Array<{
  values: Record<string, unknown>;
  eqFilters: Array<[string, unknown]>;
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
      if (table !== 'mobile_push_tokens') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        update(values: Record<string, unknown>) {
          const call = {
            values,
            eqFilters: [] as Array<[string, unknown]>,
            error: null as null,
            eq(column: string, value: unknown) {
              call.eqFilters.push([column, value]);
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

describe('/api/mobile/notifications/unregister route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T08:00:00.000Z'));
    updateCalls.length = 0;
    createUserClientMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    createUserClientMock.mockReturnValue(createUserSupabaseMock());
    createServiceClientMock.mockReturnValue({ rpc: rateLimitRpcMock });
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 20,
        remaining: 19,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
  });

  it('rate limits before deactivating a push token', async () => {
    const { POST } = await import('@/app/api/mobile/notifications/unregister/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/unregister', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-push-unregister-success-1',
        },
        body: JSON.stringify({
          expoPushToken: 'ExponentPushToken[old123]',
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-push-unregister-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-push-token:unregister',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([
      {
        values: {
          is_active: false,
          disabled_at: '2026-05-26T08:00:00.000Z',
        },
        eqFilters: [
          ['user_id', 'user-1'],
          ['expo_push_token', 'ExponentPushToken[old123]'],
        ],
        error: null,
        eq: expect.any(Function),
      },
    ]);
  });

  it('returns 429 before updating tokens when unregister requests exceed the backend limit', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 20,
        remaining: 0,
        retryAfterSeconds: 25,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/mobile/notifications/unregister/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/unregister', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-push-unregister-rate-limit-1',
        },
        body: JSON.stringify({
          deviceId: 'device-1',
        }),
      }) as never
    );
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('25');
    expectPrivateNoStoreTraceHeaders(response, 'mobile-push-unregister-rate-limit-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 25,
    });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-push-token:unregister',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([]);
  });
});
