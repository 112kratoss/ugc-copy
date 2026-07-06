import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const ensureMobileNotificationPreferencesMock = vi.fn();
const upsertCalls: Array<{ values: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
const deactivateCalls: Array<{
  values: Record<string, unknown>;
  eqFilters: Array<[string, unknown]>;
  neqFilters: Array<[string, unknown]>;
}> = [];
const crossUserDeactivateCalls: Array<{
  values: Record<string, unknown>;
  eqFilters: Array<[string, unknown]>;
  neqFilters: Array<[string, unknown]>;
}> = [];

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
}));

vi.mock('@/lib/mobile-notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mobile-notifications')>('@/lib/mobile-notifications');
  return {
    ...actual,
    ensureMobileNotificationPreferences: (...args: unknown[]) => ensureMobileNotificationPreferencesMock(...args),
  };
});

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
        async upsert(values: Record<string, unknown>, options?: Record<string, unknown>) {
          upsertCalls.push({ values, options });
          return { error: null };
        },
        update(values: Record<string, unknown>) {
          const call = {
            values,
            eqFilters: [] as Array<[string, unknown]>,
            neqFilters: [] as Array<[string, unknown]>,
            error: null as null,
            eq(column: string, value: unknown) {
              call.eqFilters.push([column, value]);
              return call;
            },
            neq(column: string, value: unknown) {
              call.neqFilters.push([column, value]);
              return call;
            },
          };

          deactivateCalls.push(call);
          return call;
        },
      };
    },
  };
}

function createAdminSupabaseMock() {
  return {
    rpc: rateLimitRpcMock,
    from(table: string) {
      if (table !== 'mobile_push_tokens') {
        throw new Error(`Unexpected admin table ${table}`);
      }

      return {
        update(values: Record<string, unknown>) {
          const call = {
            values,
            eqFilters: [] as Array<[string, unknown]>,
            neqFilters: [] as Array<[string, unknown]>,
            error: null as null,
            eq(column: string, value: unknown) {
              call.eqFilters.push([column, value]);
              return call;
            },
            neq(column: string, value: unknown) {
              call.neqFilters.push([column, value]);
              return call;
            },
          };

          crossUserDeactivateCalls.push(call);
          return call;
        },
      };
    },
  };
}

describe('/api/mobile/notifications/register route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T08:00:00.000Z'));
    upsertCalls.length = 0;
    deactivateCalls.length = 0;
    crossUserDeactivateCalls.length = 0;
    createUserClientMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    ensureMobileNotificationPreferencesMock.mockReset();
    createUserClientMock.mockReturnValue(createUserSupabaseMock());
    createServiceClientMock.mockReturnValue(createAdminSupabaseMock());
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
    ensureMobileNotificationPreferencesMock.mockResolvedValue({
      pushEnabled: true,
      generationEnabled: true,
      commerceEnabled: true,
      socialEnabled: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deactivates older active tokens for the same device after registering the latest token', async () => {
    const { POST } = await import('@/app/api/mobile/notifications/register/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-push-register-success-1',
        },
        body: JSON.stringify({
          expoPushToken: 'ExponentPushToken[new123]',
          platform: 'android',
          deviceId: 'device-1',
          appVersion: '1.0.0',
        }),
      }) as never
    );

    await expect(response.json()).resolves.toEqual({ success: true });
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-push-register-success-1');
    expect(upsertCalls).toEqual([
      {
        values: {
          user_id: 'user-1',
          expo_push_token: 'ExponentPushToken[new123]',
          platform: 'android',
          device_id: 'device-1',
          app_version: '1.0.0',
          is_active: true,
          disabled_at: null,
          last_seen_at: '2026-05-26T08:00:00.000Z',
        },
        options: { onConflict: 'user_id,expo_push_token' },
      },
    ]);
    expect(deactivateCalls).toEqual([
      {
        values: {
          is_active: false,
          disabled_at: '2026-05-26T08:00:00.000Z',
        },
        eqFilters: [
          ['user_id', 'user-1'],
          ['device_id', 'device-1'],
          ['is_active', true],
        ],
        neqFilters: [
          ['expo_push_token', 'ExponentPushToken[new123]'],
        ],
        error: null,
        eq: expect.any(Function),
        neq: expect.any(Function),
      },
    ]);
    expect(crossUserDeactivateCalls).toEqual([
      {
        values: {
          is_active: false,
          disabled_at: '2026-05-26T08:00:00.000Z',
        },
        eqFilters: [
          ['expo_push_token', 'ExponentPushToken[new123]'],
          ['is_active', true],
        ],
        neqFilters: [
          ['user_id', 'user-1'],
        ],
        error: null,
        eq: expect.any(Function),
        neq: expect.any(Function),
      },
    ]);
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-push-token:register',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(ensureMobileNotificationPreferencesMock).toHaveBeenCalledTimes(1);
  });

  it('rate limits push token registration before token and preference writes', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 20,
        remaining: 0,
        retryAfterSeconds: 35,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/mobile/notifications/register/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-push-register-rate-limit-1',
        },
        body: JSON.stringify({
          expoPushToken: 'ExponentPushToken[new123]',
          platform: 'android',
          deviceId: 'device-1',
          appVersion: '1.0.0',
        }),
      }) as never
    );
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('35');
    expectPrivateNoStoreTraceHeaders(response, 'mobile-push-register-rate-limit-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 35,
    });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-push-token:register',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(upsertCalls).toEqual([]);
    expect(deactivateCalls).toEqual([]);
    expect(crossUserDeactivateCalls).toEqual([]);
    expect(ensureMobileNotificationPreferencesMock).not.toHaveBeenCalled();
  });
});
