import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postProfileShareRouteResponse } from '@/lib/profile-share-route-adapter-service';

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
        resetAt: '2026-08-03T11:00:00.000Z',
      },
      error: null,
    })),
  } as unknown as SupabaseClient;
}

function shareRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/profile/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('postProfileShareRouteResponse', () => {
  it('rejects malformed payloads before auth or service-client work', async () => {
    const createUserClientMock = vi.fn();
    const createServiceClientMock = vi.fn();
    const shareCreatorProfileForRoute = vi.fn();

    const response = await postProfileShareRouteResponse({
      request: shareRequest(
        { username: 'nova', sourceSurface: 'creator-profile', channel: 'bad-channel' },
        { 'x-request-id': 'profile-share-invalid-1' },
      ),
      dependencies: {
        createServiceClient: createServiceClientMock,
        createUserClient: createUserClientMock,
        shareCreatorProfileForRoute,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('profile-share-invalid-1');
    await expect(response.json()).resolves.toEqual({ error: 'Invalid share channel' });
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(createServiceClientMock).not.toHaveBeenCalled();
    expect(shareCreatorProfileForRoute).not.toHaveBeenCalled();
  });

  it('tracks authenticated profile shares with a user-scoped rate-limit key', async () => {
    const serviceClient = createServiceClient();
    const shareCreatorProfileForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const },
    }));

    const response = await postProfileShareRouteResponse({
      request: shareRequest(
        { username: 'nova', sourceSurface: 'creator-profile', channel: 'copy-link' },
        { Authorization: 'Bearer token' },
      ),
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: () => createUserClient('user-1'),
        shareCreatorProfileForRoute,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(serviceClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile:share',
      p_subject_key: 'user-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(shareCreatorProfileForRoute).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      channel: 'copy-link',
      serviceClient,
      sourceSurface: 'creator-profile',
      username: 'nova',
    });
  });

  it('falls back to the forwarded IP when optional auth fails', async () => {
    const serviceClient = createServiceClient();
    const shareCreatorProfileForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const },
    }));

    const response = await postProfileShareRouteResponse({
      request: shareRequest(
        { username: 'nova', sourceSurface: 'creator-profile', channel: 'copy-link' },
        { 'x-forwarded-for': '203.0.113.55, 10.0.0.1' },
      ),
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: () => createUserClient(null, true),
        shareCreatorProfileForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(serviceClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile:share',
      p_subject_key: '203.0.113.55',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(shareCreatorProfileForRoute).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: null,
    }));
  });

  it('maps rate-limit errors before any profile lookup', async () => {
    const serviceClient = {
      rpc: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false,
          limit: 120,
          remaining: 0,
          retryAfterSeconds: 44,
          resetAt: '2026-08-03T11:05:00.000Z',
        });
      }),
    } as unknown as SupabaseClient;
    const shareCreatorProfileForRoute = vi.fn();

    const response = await postProfileShareRouteResponse({
      request: shareRequest({ username: 'nova', sourceSurface: 'creator-profile', channel: 'copy-link' }),
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: () => createUserClient(null),
        shareCreatorProfileForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('44');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 44,
      limit: 120,
    });
    expect(shareCreatorProfileForRoute).not.toHaveBeenCalled();
  });

  it('passes a service-layer 404 through unchanged', async () => {
    const serviceClient = createServiceClient();

    const response = await postProfileShareRouteResponse({
      request: shareRequest({ username: 'ghost', sourceSurface: 'creator-profile', channel: 'native-share' }),
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: () => createUserClient(null),
        shareCreatorProfileForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 404 as const,
          body: { error: 'Only public creator profiles can be shared' },
        })),
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'Only public creator profiles can be shared',
    });
  });
});
