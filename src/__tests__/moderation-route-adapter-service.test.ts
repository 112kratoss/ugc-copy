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

const GUEST_ID = '10000000-0000-4000-8000-00000000000a';
const OTHER_USER_ID = '20000000-0000-4000-8000-00000000000b';
const GENERATION_ID = '30000000-0000-4000-8000-00000000000c';

/** What Supabase returns for an anonymous sign-in: a real user with this one claim. */
function guestClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: GUEST_ID, is_anonymous: true } },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;
}

function reportRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/moderation/reports', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function generationReport() {
  return {
    targetType: 'generation',
    targetId: GENERATION_ID,
    reason: 'offensive_ai_output',
    sourceSurface: 'generation-viewer',
  };
}

/** The service client the real report service writes through, with one generation in it. */
function reportStore(generationOwnerId: string) {
  const reports: Array<Record<string, unknown>> = [];
  const client = {
    rpc: vi.fn(async () => ({
      data: { allowed: true, limit: 10, remaining: 9, retryAfterSeconds: 0, resetAt: '2026-10-15T06:10:00.000Z' },
      error: null,
    })),
    from(table: string) {
      if (table === 'generations') {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: { id: GENERATION_ID, user_id: generationOwnerId }, error: null }),
        };
        return query;
      }
      if (table === 'profiles') {
        // The linked-identity lookup: nobody is linked to a guest.
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      if (table === 'moderation_reports') {
        return {
          insert: async (row: Record<string, unknown>) => {
            reports.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected admin table: ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, reports };
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
      reporterIsGuest: false,
      reporterUserId: 'reporter-1',
    });
  });

  // The app's guest generates with its own credits and needs a way to flag an
  // offensive result without leaving the app; the proxy now lets that one
  // report through (GUEST_WRITABLE_REGISTERED_ROUTES).
  it("takes a guest's report of a generation, filed as the guest's own", async () => {
    const submitModerationReportForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const },
    }));
    const adminClient = { kind: 'admin' } as unknown as SupabaseClient;

    const response = await postModerationReportRouteResponse({
      request: reportRequest(generationReport()),
      dependencies: {
        createServiceClient: vi.fn(() => adminClient),
        createUserClient: vi.fn(() => guestClient()),
        submitModerationReportForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(submitModerationReportForRoute).toHaveBeenCalledWith({
      adminSupabase: adminClient,
      body: generationReport(),
      reporterIsGuest: true,
      reporterUserId: GUEST_ID,
    });
  });

  it("answers a guest's report of a person or a comment with the proxy's 403, before any work", async () => {
    for (const body of [
      { targetType: 'user', targetId: OTHER_USER_ID, reason: 'harassment', sourceSurface: 'creator-profile' },
      { targetType: 'comment', targetId: OTHER_USER_ID, reason: 'spam', sourceSurface: 'comments' },
      {},
    ]) {
      const createServiceClient = vi.fn();
      const submitModerationReportForRoute = vi.fn();

      const response = await postModerationReportRouteResponse({
        request: reportRequest(body),
        dependencies: {
          createServiceClient,
          createUserClient: vi.fn(() => guestClient()),
          submitModerationReportForRoute,
        },
      });

      // 403, not 401: the app reads a 401 as a session that has ended.
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        error: 'Create an account to use this feature.',
        code: 'REGISTRATION_REQUIRED',
      });
      expect(createServiceClient).not.toHaveBeenCalled();
      expect(submitModerationReportForRoute).not.toHaveBeenCalled();
    }
  });

  it("files a guest's report of its own generation and refuses one of someone else's", async () => {
    const own = reportStore(GUEST_ID);
    const ownResponse = await postModerationReportRouteResponse({
      request: reportRequest(generationReport()),
      dependencies: {
        createServiceClient: vi.fn(() => own.client),
        createUserClient: vi.fn(() => guestClient()),
      },
    });
    expect(ownResponse.status).toBe(200);
    await expect(ownResponse.json()).resolves.toEqual({ success: true });
    expect(own.reports).toEqual([expect.objectContaining({
      reporter_user_id: GUEST_ID,
      target_type: 'generation',
      generation_id: GENERATION_ID,
      reason: 'offensive_ai_output',
    })]);

    const someoneElses = reportStore(OTHER_USER_ID);
    const refused = await postModerationReportRouteResponse({
      request: reportRequest(generationReport()),
      dependencies: {
        createServiceClient: vi.fn(() => someoneElses.client),
        createUserClient: vi.fn(() => guestClient()),
      },
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({
      error: 'Create an account to use this feature.',
      code: 'REGISTRATION_REQUIRED',
    });
    expect(someoneElses.reports).toEqual([]);
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
