import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  postOwnerPostArchiveRouteResponse,
  postOwnerPostRestoreRouteResponse,
} from '@/lib/post-lifecycle-route-adapter-service';
import type { PostLifecycleResult } from '@/lib/post-lifecycle-service';

function createUserClient(userId: string | null = 'user-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('post lifecycle route adapter service', () => {
  it('rejects unauthenticated archive requests before privileged clients or lifecycle work', async () => {
    const archiveOwnerPostForRoute = vi.fn();
    const createServiceClient = vi.fn();

    const response = await postOwnerPostArchiveRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/archive', {
        method: 'POST',
        headers: { 'x-request-id': 'post-archive-adapter-auth-1' },
      }),
      postId: 'post-1',
      dependencies: {
        archiveOwnerPostForRoute,
        createServiceClient,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-archive-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(archiveOwnerPostForRoute).not.toHaveBeenCalled();
  });

  it('delegates successful archive requests with owner and post ids', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const archiveOwnerPostForRoute = vi.fn(async (): Promise<PostLifecycleResult> => ({
      ok: true,
      body: { success: true, archived: true },
    }));

    const response = await postOwnerPostArchiveRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/archive', {
        method: 'POST',
        headers: { 'x-request-id': 'post-archive-adapter-success-1' },
      }),
      postId: 'post-1',
      dependencies: {
        archiveOwnerPostForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-archive-adapter-success-1');
    await expect(response.json()).resolves.toEqual({ success: true, archived: true });
    expect(archiveOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase,
      ownerUserId: 'user-1',
      postId: 'post-1',
    });
  });

  it('maps lifecycle rate-limit responses with standard private headers for restore', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 44,
      resetAt: '2026-06-23T12:00:00.000Z',
    });
    const restoreOwnerPostForRoute = vi.fn(async (): Promise<PostLifecycleResult> => ({
      ok: false,
      rateLimitError,
    }));

    const response = await postOwnerPostRestoreRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/restore', {
        method: 'POST',
        headers: { 'x-request-id': 'post-restore-adapter-limit-1' },
      }),
      postId: 'post-1',
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
        restoreOwnerPostForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('44');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-restore-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 44,
      limit: 60,
    });
  });

  it('maps service failures and unexpected restore failures to stable responses', async () => {
    const logError = vi.fn();
    const restoreOwnerPostForRoute = vi.fn(async () => {
      throw new Error('database unavailable');
    });

    const response = await postOwnerPostRestoreRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/restore', {
        method: 'POST',
        headers: { 'x-request-id': 'post-restore-adapter-failed-1' },
      }),
      postId: 'post-1',
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
        logError,
        restoreOwnerPostForRoute,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-restore-adapter-failed-1');
    await expect(response.json()).resolves.toEqual({ error: 'Failed to restore post.' });
    expect(logError).toHaveBeenCalledWith('Failed to restore owner post:', expect.any(Error));
  });
});
