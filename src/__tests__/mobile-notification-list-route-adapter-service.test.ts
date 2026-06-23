import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { MobileNotificationInboxRouteResult } from '@/lib/mobile-notification-inbox-service';
import { getMobileNotificationListRouteResponse } from '@/lib/mobile-notification-list-route-adapter-service';

function createUserClient() {
  return { kind: 'user' } as unknown as SupabaseClient;
}

describe('mobile notification list route adapter service', () => {
  it('delegates inbox loading with cursor params, user-client handoff, and private trace headers', async () => {
    const userSupabase = createUserClient();
    const createUserClientDependency = vi.fn(() => userSupabase);
    const getMobileNotificationInboxForRoute = vi.fn(
      async (): Promise<MobileNotificationInboxRouteResult> => ({
        ok: true,
        body: {
          success: true,
          notifications: [],
          unreadCount: 3,
        },
      }),
    );
    const request = new Request(
      'http://localhost/api/mobile/notifications?limit=12&before=2026-06-23T10:30:00.000Z',
      {
        headers: { 'x-request-id': 'mobile-notification-list-adapter-1' },
      },
    );

    const response = await getMobileNotificationListRouteResponse({
      request,
      dependencies: {
        createUserClient: createUserClientDependency,
        getMobileNotificationInboxForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-notification-list-adapter-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      notifications: [],
      unreadCount: 3,
    });
    expect(createUserClientDependency).toHaveBeenCalledWith(request);
    expect(getMobileNotificationInboxForRoute).toHaveBeenCalledWith({
      before: '2026-06-23T10:30:00.000Z',
      limitValue: '12',
      userSupabase,
    });
  });

  it('maps inbox failures with stable private headers', async () => {
    const response = await getMobileNotificationListRouteResponse({
      request: new Request('http://localhost/api/mobile/notifications', {
        headers: { 'x-request-id': 'mobile-notification-list-unauthorized-1' },
      }),
      dependencies: {
        createUserClient: () => createUserClient(),
        getMobileNotificationInboxForRoute: vi.fn(
          async (): Promise<MobileNotificationInboxRouteResult> => ({
            ok: false,
            status: 401,
            body: { error: 'Unauthorized' },
          }),
        ),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-notification-list-unauthorized-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });
});
