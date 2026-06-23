import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createProfileFollowRouteHandlers,
  getProfileFollowRouteResponse,
  postProfileFollowNotifyRouteResponse,
  postProfileFollowRouteResponse,
} from '@/lib/profile-follow-route-adapter-service';

function createUserClient(userId: string | null = 'follower-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('profile follow route adapter service', () => {
  it('loads follow state after authentication and applies private response headers', async () => {
    const serviceClientFactory = vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient);
    const getCreatorFollowStateForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { following: true },
    }));

    const response = await getProfileFollowRouteResponse({
      request: new Request('http://localhost/api/profile/follow?followingId=%20creator-1%20', {
        headers: { 'x-request-id': 'follow-get-1' },
      }),
      dependencies: {
        createServiceClient: serviceClientFactory,
        createUserClient: () => createUserClient('follower-1'),
        getCreatorFollowStateForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('follow-get-1');
    await expect(response.json()).resolves.toEqual({ following: true });
    expect(getCreatorFollowStateForRoute).toHaveBeenCalledWith({
      adminSupabase: serviceClientFactory,
      followerId: 'follower-1',
      followingId: 'creator-1',
    });
  });

  it('rejects unauthenticated mutations before creating the service client or parsing JSON', async () => {
    const createServiceClient = vi.fn();
    const updateCreatorFollowForRoute = vi.fn();

    const response = await postProfileFollowRouteResponse({
      request: new Request('http://localhost/api/profile/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'follow-auth-1',
        },
        body: '{',
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        updateCreatorFollowForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('follow-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(updateCreatorFollowForRoute).not.toHaveBeenCalled();
  });

  it('maps follow rate-limit results to standard backend rate-limit responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 37,
      resetAt: '2026-06-23T11:00:00.000Z',
    });

    const response = await postProfileFollowRouteResponse({
      request: new Request('http://localhost/api/profile/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: 'creator-1', following: true }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('follower-1'),
        updateCreatorFollowForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          rateLimitError,
          body: { code: 'RATE_LIMITED' },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('37');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 37,
      limit: 60,
    });
  });

  it('maps unexpected follow state failures to the stable internal error response', async () => {
    const logError = vi.fn();

    const response = await getProfileFollowRouteResponse({
      request: new Request('http://localhost/api/profile/follow?followingId=creator-1'),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('follower-1'),
        getCreatorFollowStateForRoute: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
        logError,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith(
      'Creator follow state failed:',
      expect.objectContaining({ message: 'database unavailable' }),
    );
  });

  it('rejects unauthenticated follow notifications before service-client creation or JSON parsing', async () => {
    const createServiceClient = vi.fn();
    const notifyCreatorFollowForRoute = vi.fn();
    const request = new Request('http://localhost/api/profile/follow/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'follow-notify-auth-1',
      },
      body: '{',
    });

    const response = await postProfileFollowNotifyRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        notifyCreatorFollowForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('follow-notify-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(notifyCreatorFollowForRoute).not.toHaveBeenCalled();
  });

  it('delegates follow notifications with malformed JSON normalized to null', async () => {
    const serviceClientFactory = vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient);
    const notifyCreatorFollowForRoute = vi.fn(async () => ({
      ok: false as const,
      status: 400 as const,
      body: { error: 'Missing creator profile.' },
    }));

    const response = await postProfileFollowNotifyRouteResponse({
      request: new Request('http://localhost/api/profile/follow/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'follow-notify-bad-json-1',
        },
        body: '{',
      }),
      dependencies: {
        createServiceClient: serviceClientFactory,
        createUserClient: () => createUserClient('follower-1'),
        notifyCreatorFollowForRoute,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Missing creator profile.' });
    expect(notifyCreatorFollowForRoute).toHaveBeenCalledWith({
      adminSupabase: serviceClientFactory,
      followerId: 'follower-1',
      body: null,
    });
  });

  it('maps follow notification rate-limit results to standard backend rate-limit responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 41,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postProfileFollowNotifyRouteResponse({
      request: new Request('http://localhost/api/profile/follow/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: 'creator-1' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('follower-1'),
        notifyCreatorFollowForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          rateLimitError,
          body: { code: 'RATE_LIMITED' },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 41,
      limit: 30,
    });
  });

  it('maps unexpected follow notification failures to the stable internal error response', async () => {
    const logError = vi.fn();

    const response = await postProfileFollowNotifyRouteResponse({
      request: new Request('http://localhost/api/profile/follow/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: 'creator-1' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('follower-1'),
        notifyCreatorFollowForRoute: vi.fn(async () => {
          throw new Error('notification queue unavailable');
        }),
        logError,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith(
      'Creator follow notification failed:',
      expect.objectContaining({ message: 'notification queue unavailable' }),
    );
  });

  it('creates route handlers that forward GET and POST follow requests through the adapter', async () => {
    const getCreatorFollowStateForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { following: false },
    }));
    const updateCreatorFollowForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { following: true },
    }));
    const { GET, POST } = createProfileFollowRouteHandlers({
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('follower-1'),
        getCreatorFollowStateForRoute,
        updateCreatorFollowForRoute,
      },
    });

    const getResponse = await GET(new Request(
      'http://localhost/api/profile/follow?followingId=creator-1',
      { headers: { 'x-request-id': 'follow-factory-get-1' } },
    ));
    const postResponse = await POST(new Request('http://localhost/api/profile/follow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'follow-factory-post-1',
      },
      body: JSON.stringify({ followingId: 'creator-1', following: true }),
    }));

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('x-request-id')).toBe('follow-factory-get-1');
    expect(postResponse.status).toBe(200);
    expect(postResponse.headers.get('x-request-id')).toBe('follow-factory-post-1');
    await expect(getResponse.json()).resolves.toEqual({ following: false });
    await expect(postResponse.json()).resolves.toEqual({ following: true });
    expect(getCreatorFollowStateForRoute).toHaveBeenCalledWith(expect.objectContaining({
      followerId: 'follower-1',
      followingId: 'creator-1',
    }));
    expect(updateCreatorFollowForRoute).toHaveBeenCalledWith(expect.objectContaining({
      followerId: 'follower-1',
      body: { followingId: 'creator-1', following: true },
    }));
  });
});
