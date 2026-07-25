import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import type { MobileNotificationInboxRouteResult } from '@/lib/mobile-notification-inbox-service';
import {
  postMobileNotificationReadAllRouteResponse,
  postMobileNotificationReadRouteResponse,
} from '@/lib/mobile-notification-read-route-adapter-service';

function createUserClient() {
  return { kind: 'user' } as unknown as SupabaseClient;
}

describe('mobile notification read route adapter service', () => {
  it('delegates selected-read updates with lazy body and admin-client handoff plus private trace headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const userSupabase = createUserClient();
    const createServiceClient = vi.fn(() => adminSupabase);
    const createUserClientDependency = vi.fn(() => userSupabase);
    // Typed with the real signature so `mock.calls` is a tuple of its actual
    // arguments; a bare vi.fn() infers zero parameters and calls[0][0] cannot compile.
    const markMobileNotificationsReadForRoute = vi.fn<typeof import('@/lib/mobile-notification-inbox-service').markMobileNotificationsReadForRoute>(
      async (): Promise<MobileNotificationInboxRouteResult> => ({
        ok: true,
        body: { success: true },
      }),
    );
    const request = new Request('http://localhost/api/mobile/notifications/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'mobile-notification-read-adapter-1',
      },
      body: JSON.stringify({ ids: ['notification-1', 'notification-2'] }),
    });

    const response = await postMobileNotificationReadRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: createUserClientDependency,
        markMobileNotificationsReadForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-notification-read-adapter-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(markMobileNotificationsReadForRoute).toHaveBeenCalledTimes(1);

    const serviceInput = markMobileNotificationsReadForRoute.mock.calls[0][0];
    expect(serviceInput.userSupabase).toBe(userSupabase);
    expect(serviceInput.getAdminSupabase()).toBe(adminSupabase);
    await expect(serviceInput.readRequestBody?.()).resolves.toEqual({
      ids: ['notification-1', 'notification-2'],
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createUserClientDependency).toHaveBeenCalledWith(request);
  });

  it('maps read-all rate-limit responses with standard private headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 52,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postMobileNotificationReadAllRouteResponse({
      request: new Request('http://localhost/api/mobile/notifications/read-all', {
        method: 'POST',
        headers: { 'x-request-id': 'mobile-notification-read-all-adapter-limit-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient(),
        markAllMobileNotificationsReadForRoute: vi.fn(
          async (): Promise<MobileNotificationInboxRouteResult> => ({
            ok: false,
            status: 429,
            body: { error: 'Too many notification read-all requests.' },
            rateLimitError,
          }),
        ),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('52');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe(
      'mobile-notification-read-all-adapter-limit-1',
    );
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 52,
      limit: 30,
    });
  });
});
