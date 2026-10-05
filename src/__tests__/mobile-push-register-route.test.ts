import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const registrationRpcMock = vi.fn();

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
  };
}

function createAdminSupabaseMock() {
  return { rpc: (name: string, args: unknown) => name === 'register_mobile_push_token'
    ? registrationRpcMock(name, args) : rateLimitRpcMock(name, args) };
}

describe('/api/mobile/notifications/register route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T08:00:00.000Z'));
    createUserClientMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    registrationRpcMock.mockReset();
    registrationRpcMock.mockResolvedValue({data: 'token-row', error: null});
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

  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers through the atomic RPC and keeps response tracing and cache headers', async () => {
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
    expect(registrationRpcMock).toHaveBeenCalledWith('register_mobile_push_token', {
      p_user_id: 'user-1', p_expo_push_token: 'ExponentPushToken[new123]',
      p_platform: 'android', p_device_id: 'device-1', p_app_version: '1.0.0',
    });
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-push-token:register',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(registrationRpcMock).toHaveBeenCalledTimes(1);
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
    expect(registrationRpcMock).not.toHaveBeenCalled();
  });
});
