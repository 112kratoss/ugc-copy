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
          ['is_active', true],
        ],
        error: null,
        eq: expect.any(Function),
      },
    ]);
  });

  it('answers 400 to the all-device request installed apps still send on sign-out', async () => {
    const { POST } = await import('@/app/api/mobile/notifications/unregister/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/unregister', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-push-unregister-all-devices-1',
        },
        body: JSON.stringify({
          platform: 'android',
          allDevices: true,
        }),
      }) as never
    );

    expect(response.status).toBe(400);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-push-unregister-all-devices-1');
    await expect(response.json()).resolves.toEqual({ error: 'Provide an Expo push token or device ID.' });
    expect(rateLimitRpcMock).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([]);
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
  // "Sign out everywhere" asks for the whole account here first, and the route ends the apps
  // connected through the app's own authorization server with it.
  it('ends the account\'s connected apps with the account-wide request', async () => {
    const revoke = ['agent_oauth_revoke_grants', { p_user_id: 'user-1', p_client_id: null, p_reason: 'user' }];
    const { POST } = await import('@/app/api/mobile/notifications/unregister/route');
    const response = await POST(new Request('http://localhost/api/mobile/notifications/unregister', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'account' }),
    }) as never);
    expect(response.status).toBe(200);
    expect(rateLimitRpcMock.mock.calls).toContainEqual(revoke);
    // Before the limit is counted.
    expect(rateLimitRpcMock.mock.calls[0]).toEqual(revoke);
  });

  it('ends no connected app for one device\'s sign-out', async () => {
    const { POST } = await import('@/app/api/mobile/notifications/unregister/route');
    await POST(new Request('http://localhost/api/mobile/notifications/unregister', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-1' }),
    }) as never);
    expect(rateLimitRpcMock.mock.calls.map(([name]) => name)).toEqual(['check_backend_rate_limit']);
  });

  it('marks the answer when the apps could not be ended, and still retires the push tokens', async () => {
    rateLimitRpcMock.mockImplementation(async (name: string) => (
      name === 'agent_oauth_revoke_grants'
        ? { data: null, error: { message: 'db down' } }
        : { data: { allowed: true, limit: 20, remaining: 19, retryAfterSeconds: 0, resetAt: '2026-06-22T06:30:00.000Z' }, error: null }
    ));
    const { POST } = await import('@/app/api/mobile/notifications/unregister/route');
    const response = await POST(new Request('http://localhost/api/mobile/notifications/unregister', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'account' }),
    }) as never);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'AGENT_ACCESS_NOT_ENDED' });
    expect(updateCalls).toHaveLength(1);
  });
});
