import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postShowcaseShareRouteResponse } from '@/lib/showcase-share-route-adapter-service';

function createUserClient(userId: string | null = 'user-1', shouldThrow = false) {
  return {
    auth: {
      getUser: vi.fn(async () => {
        if (shouldThrow) {
          throw new Error('auth unavailable');
        }

        return { data: { user: userId ? { id: userId } : null }, error: null };
      }),
    },
  } as unknown as SupabaseClient;
}

function createServiceClient() {
  return {
    rpc: vi.fn(async () => ({
      data: {
        allowed: true,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 0,
        resetAt: '2026-06-23T11:00:00.000Z',
      },
      error: null,
    })),
  } as unknown as SupabaseClient;
}

describe('postShowcaseShareRouteResponse', () => {
  it('rejects malformed share payloads before auth or service-client work', async () => {
    const createUserClientMock = vi.fn();
    const createServiceClientMock = vi.fn();
    const shareShowcasePostForRoute = vi.fn();

    const response = await postShowcaseShareRouteResponse({
      request: new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'showcase-share-invalid-1',
        },
        body: JSON.stringify({ postId: 'post-1', sourceSurface: 'showcase', channel: 'bad-channel' }),
      }),
      dependencies: {
        createServiceClient: createServiceClientMock,
        createUserClient: createUserClientMock,
        shareShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-share-invalid-1');
    await expect(response.json()).resolves.toEqual({ error: 'Invalid share channel' });
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(createServiceClientMock).not.toHaveBeenCalled();
    expect(shareShowcasePostForRoute).not.toHaveBeenCalled();
  });

  it('tracks authenticated share clicks with a user-scoped rate-limit key', async () => {
    const serviceClient = createServiceClient();
    const shareShowcasePostForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const },
    }));

    const response = await postShowcaseShareRouteResponse({
      request: new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          postId: 'post-1',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: () => createUserClient('user-1'),
        shareShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(serviceClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase:share',
      p_subject_key: 'user-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(shareShowcasePostForRoute).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-1',
      serviceClient,
      sourceSurface: 'showcase',
    });
  });

  it('falls back to the forwarded IP when optional auth fails', async () => {
    const serviceClient = createServiceClient();
    const shareShowcasePostForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const },
    }));

    const response = await postShowcaseShareRouteResponse({
      request: new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '203.0.113.55, 10.0.0.1',
        },
        body: JSON.stringify({
          postId: 'post-1',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: () => createUserClient(null, true),
        shareShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(serviceClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase:share',
      p_subject_key: '203.0.113.55',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(shareShowcasePostForRoute).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: null,
    }));
  });

  it('maps backend rate-limit errors before public post lookup or event recording', async () => {
    const serviceClient = {
      rpc: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false,
          limit: 120,
          remaining: 0,
          retryAfterSeconds: 44,
          resetAt: '2026-06-23T11:05:00.000Z',
        });
      }),
    } as unknown as SupabaseClient;
    const shareShowcasePostForRoute = vi.fn();

    const response = await postShowcaseShareRouteResponse({
      request: new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postId: 'post-1',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: () => createUserClient(null),
        shareShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('44');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 44,
      limit: 120,
    });
    expect(shareShowcasePostForRoute).not.toHaveBeenCalled();
  });
});
