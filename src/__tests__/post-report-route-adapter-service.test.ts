import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postReportRouteResponse } from '@/lib/post-report-route-adapter-service';
import type { PostReportRouteResult } from '@/lib/post-report-service';

function createUserClient(userId: string | null = 'reporter-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('postReportRouteResponse', () => {
  it('rejects unauthenticated reports before parsing the body or creating an admin client', async () => {
    const createServiceClient = vi.fn();
    const submitPostReportForRoute = vi.fn();

    const response = await postReportRouteResponse({
      postId: 'post-1',
      request: new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: 'Bearer private-token',
          'x-request-id': 'post-report-adapter-auth-1',
        },
        body: '{',
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        submitPostReportForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-report-adapter-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(submitPostReportForRoute).not.toHaveBeenCalled();
  });

  it('delegates authenticated reports with reporter, post id, lazy body reader, and admin factory', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const submitPostReportForRoute = vi.fn(
      async ({ createAdminSupabase, readBody }): Promise<PostReportRouteResult> => {
        await expect(readBody()).resolves.toEqual({ reason: 'spam' });
        expect(createAdminSupabase()).toBe(adminSupabase);
        return { ok: true, body: { success: true } };
      },
    );

    const response = await postReportRouteResponse({
      postId: 'post-1',
      request: new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'post-report-adapter-success-1',
        },
        body: JSON.stringify({ reason: 'spam' }),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('reporter-1'),
        submitPostReportForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-report-adapter-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(submitPostReportForRoute).toHaveBeenCalledWith({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: expect.any(Function),
      createAdminSupabase: expect.any(Function),
    });
  });

  it('maps post report rate limits to standard private backend rate-limit responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 55,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postReportRouteResponse({
      postId: 'post-1',
      request: new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'post-report-adapter-limit-1',
        },
        body: JSON.stringify({ reason: 'spam' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('reporter-1'),
        submitPostReportForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429 as const,
          rateLimitError,
          body: {
            code: 'RATE_LIMITED' as const,
            error: 'Too many reports.',
            retryAfterSeconds: 55,
            limit: 10,
            resetAt: '2026-06-23T12:00:00.000Z',
          },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('55');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-report-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 55,
      limit: 10,
    });
  });

  it('maps report validation failures with private headers', async () => {
    const createServiceClient = vi.fn();

    const response = await postReportRouteResponse({
      postId: 'post-1',
      request: new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'post-report-adapter-invalid-1',
        },
        body: JSON.stringify({ reason: 'not-a-real-reason' }),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('reporter-1'),
        submitPostReportForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 400 as const,
          body: { error: 'Choose a valid report reason.' },
        })),
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-report-adapter-invalid-1');
    await expect(response.json()).resolves.toEqual({
      error: 'Choose a valid report reason.',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
  });
});
