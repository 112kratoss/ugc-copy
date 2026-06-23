import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const upsertCalls: Array<{
  values: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
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
      if (table !== 'mobile_notification_preferences') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        upsert(values: Record<string, unknown>, options?: Record<string, unknown>) {
          upsertCalls.push({ values, options });
          return {
            select(fields: string) {
              expect(fields).toBe('push_enabled, generation_enabled, commerce_enabled, social_enabled');
              return {
                async single() {
                  return {
                    data: {
                      push_enabled: values.push_enabled ?? true,
                      generation_enabled: values.generation_enabled ?? true,
                      commerce_enabled: values.commerce_enabled ?? true,
                      social_enabled: values.social_enabled ?? true,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe('/api/mobile/notifications/preferences route', () => {
  beforeEach(() => {
    vi.resetModules();
    upsertCalls.length = 0;
    createUserClientMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    createUserClientMock.mockReturnValue(createUserSupabaseMock());
    createServiceClientMock.mockReturnValue({ rpc: rateLimitRpcMock });
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
  });

  it('returns private trace headers when preferences authentication fails', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { GET } = await import('@/app/api/mobile/notifications/preferences/route');
    const response = await GET(
      new Request('http://localhost/api/mobile/notifications/preferences', {
        headers: { 'x-request-id': 'mobile-pref-auth-1' },
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-pref-auth-1');
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });

  it('rate limits before updating mobile notification preferences', async () => {
    const { PATCH } = await import('@/app/api/mobile/notifications/preferences/route');
    const response = await PATCH(
      new Request('http://localhost/api/mobile/notifications/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-pref-update-success-1',
        },
        body: JSON.stringify({
          pushEnabled: false,
          socialEnabled: false,
        }),
      }) as never
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'mobile-pref-update-success-1');
    expect(data).toEqual({
      success: true,
      preferences: {
        pushEnabled: false,
        generationEnabled: true,
        commerceEnabled: true,
        socialEnabled: false,
      },
    });
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notification-preferences:update',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(upsertCalls).toEqual([
      {
        values: {
          user_id: 'user-1',
          push_enabled: false,
          social_enabled: false,
        },
        options: { onConflict: 'user_id' },
      },
    ]);
  });

  it('returns 429 before upserting preferences when updates exceed the backend limit', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 45,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { PATCH } = await import('@/app/api/mobile/notifications/preferences/route');
    const response = await PATCH(
      new Request('http://localhost/api/mobile/notifications/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-pref-update-rate-limit-1',
        },
        body: JSON.stringify({
          pushEnabled: true,
        }),
      }) as never
    );
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expectPrivateNoStoreTraceHeaders(response, 'mobile-pref-update-rate-limit-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 45,
    });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notification-preferences:update',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(upsertCalls).toEqual([]);
  });
});
