import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  postMobilePushRegisterRouteResponse,
  postMobilePushUnregisterRouteResponse,
} from '@/lib/mobile-push-route-adapter-service';
import type { MobilePushRegistrationRouteResult } from '@/lib/mobile-push-registration-service';
import type { MobilePushUnregisterRouteResult } from '@/lib/mobile-push-unregister-service';

function createUserClient() {
  return { kind: 'user' } as unknown as SupabaseClient;
}

describe('mobile push route adapter service', () => {
  it('delegates push registration with lazy body and admin-client handoff plus private trace headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const userSupabase = createUserClient();
    const createServiceClient = vi.fn(() => adminSupabase);
    const createUserClientDependency = vi.fn(() => userSupabase);
    // Typed with the real signature so `mock.calls` is a tuple of its actual
    // arguments; a bare vi.fn() infers zero parameters and calls[0][0] cannot compile.
    const registerMobilePushTokenForRoute = vi.fn<typeof import('@/lib/mobile-push-registration-service').registerMobilePushTokenForRoute>(
      async (): Promise<MobilePushRegistrationRouteResult> => ({
        ok: true,
        body: { success: true },
      }),
    );
    const request = new Request('http://localhost/api/mobile/notifications/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'mobile-push-register-adapter-1',
      },
      body: JSON.stringify({ expoPushToken: 'ExponentPushToken[new]' }),
    });

    const response = await postMobilePushRegisterRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: createUserClientDependency,
        registerMobilePushTokenForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-push-register-adapter-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(registerMobilePushTokenForRoute).toHaveBeenCalledTimes(1);

    const serviceInput = registerMobilePushTokenForRoute.mock.calls[0][0];
    expect(serviceInput.userSupabase).toBe(userSupabase);
    expect(serviceInput.getAdminSupabase()).toBe(adminSupabase);
    await expect(serviceInput.readRequestBody?.()).resolves.toEqual({
      expoPushToken: 'ExponentPushToken[new]',
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createUserClientDependency).toHaveBeenCalledWith(request);
  });

  it('maps push unregister rate-limit responses with standard private headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 41,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postMobilePushUnregisterRouteResponse({
      request: new Request('http://localhost/api/mobile/notifications/unregister', {
        method: 'POST',
        headers: { 'x-request-id': 'mobile-push-unregister-adapter-limit-1' },
        body: JSON.stringify({ deviceId: 'device-1' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient(),
        unregisterMobilePushTokenForRoute: vi.fn(
          async (): Promise<MobilePushUnregisterRouteResult> => ({
            ok: false,
            status: 429,
            body: { error: 'Too many push unregister requests.' },
            rateLimitError,
          }),
        ),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-push-unregister-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 41,
      limit: 20,
    });
  });
});
