import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  postModerationReportRouteResponse,
  userBlockRouteResponse,
} from '@/lib/moderation-route-adapter-service';

function userClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;
}

describe('moderation route adapter service', () => {
  it('rejects unauthenticated moderation reports before service access', async () => {
    const submitModerationReportForRoute = vi.fn();
    const response = await postModerationReportRouteResponse({
      request: new Request('http://localhost/api/moderation/reports', { method: 'POST' }),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: vi.fn(() => userClient(null)),
        submitModerationReportForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(submitModerationReportForRoute).not.toHaveBeenCalled();
  });

  it('binds report identity to the verified access token', async () => {
    const submitModerationReportForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const },
    }));
    const adminClient = { kind: 'admin' } as unknown as SupabaseClient;
    const body = {
      targetType: 'user',
      targetId: 'creator-1',
      reason: 'harassment',
      sourceSurface: 'creator-profile',
    };
    const response = await postModerationReportRouteResponse({
      request: new Request('http://localhost/api/moderation/reports', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => adminClient),
        createUserClient: vi.fn(() => userClient('reporter-1')),
        submitModerationReportForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(submitModerationReportForRoute).toHaveBeenCalledWith({
      adminSupabase: adminClient,
      body,
      reporterUserId: 'reporter-1',
    });
  });

  it('binds block mutations to the verified access token and path target', async () => {
    const setUserBlockForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const, blocked: true },
    }));
    const adminClient = { kind: 'admin' } as unknown as SupabaseClient;
    const response = await userBlockRouteResponse({
      blockedUserId: 'creator-1',
      request: new Request('http://localhost/api/moderation/blocks/creator-1', { method: 'POST' }),
      shouldBlock: true,
      dependencies: {
        createServiceClient: vi.fn(() => adminClient),
        createUserClient: vi.fn(() => userClient('viewer-1')),
        setUserBlockForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(setUserBlockForRoute).toHaveBeenCalledWith({
      actorUserId: 'viewer-1',
      adminSupabase: adminClient,
      blockedUserId: 'creator-1',
      shouldBlock: true,
    });
  });
});
