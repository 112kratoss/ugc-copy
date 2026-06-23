import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  postProfileMediaCleanupRouteResponse,
  postProfileMediaSignRouteResponse,
} from '@/lib/profile-media-route-adapter-service';

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

describe('profile media route adapter service', () => {
  it('rejects unauthenticated upload-sign requests before service-client creation or JSON parsing', async () => {
    const createServiceClient = vi.fn();
    const createProfileMediaUploadIntent = vi.fn();
    const request = new Request('http://localhost/api/profile/media/sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'profile-media-sign-adapter-auth-1',
      },
      body: '{',
    });

    const response = await postProfileMediaSignRouteResponse({
      request,
      dependencies: {
        createProfileMediaUploadIntent,
        createServiceClient,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('profile-media-sign-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createProfileMediaUploadIntent).not.toHaveBeenCalled();
  });

  it('returns the stable invalid metadata response for malformed upload-sign JSON', async () => {
    const createProfileMediaUploadIntent = vi.fn();

    const response = await postProfileMediaSignRouteResponse({
      request: new Request('http://localhost/api/profile/media/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-media-sign-adapter-json-1',
        },
        body: '{',
      }),
      dependencies: {
        createProfileMediaUploadIntent,
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Invalid profile media metadata.' });
    expect(createProfileMediaUploadIntent).not.toHaveBeenCalled();
  });

  it('delegates upload-sign requests and maps rate limits to standard private responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 45,
      resetAt: '2026-06-23T13:00:00.000Z',
    });
    const adminClient = { kind: 'admin' } as unknown as SupabaseClient;
    const createProfileMediaUploadIntent = vi.fn(async () => ({
      ok: false as const,
      status: 429 as const,
      rateLimitError,
      body: { code: 'RATE_LIMITED' },
    }));
    const request = new Request('http://localhost/api/profile/media/sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'profile-media-sign-adapter-limit-1',
      },
      body: JSON.stringify({ role: 'avatar', fileName: 'avatar.jpg', mimeType: 'image/jpeg', sizeBytes: 1234 }),
    });

    const response = await postProfileMediaSignRouteResponse({
      request,
      dependencies: {
        createProfileMediaUploadIntent,
        createServiceClient: vi.fn(() => adminClient),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 45,
      limit: 30,
    });
    expect(createProfileMediaUploadIntent).toHaveBeenCalledWith({
      body: { role: 'avatar', fileName: 'avatar.jpg', mimeType: 'image/jpeg', sizeBytes: 1234 },
      userId: 'user-1',
      client: expect.any(Function),
    });
  });

  it('rejects unauthenticated cleanup requests before service-client creation or JSON parsing', async () => {
    const cleanupProfileMedia = vi.fn();
    const createServiceClient = vi.fn();

    const response = await postProfileMediaCleanupRouteResponse({
      request: new Request('http://localhost/api/profile/media/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-media-cleanup-adapter-auth-1',
        },
        body: '{',
      }),
      dependencies: {
        cleanupProfileMedia,
        createServiceClient,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('profile-media-cleanup-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(cleanupProfileMedia).not.toHaveBeenCalled();
  });

  it('returns the stable invalid cleanup response for malformed cleanup JSON', async () => {
    const cleanupProfileMedia = vi.fn();

    const response = await postProfileMediaCleanupRouteResponse({
      request: new Request('http://localhost/api/profile/media/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-media-cleanup-adapter-json-1',
        },
        body: '{',
      }),
      dependencies: {
        cleanupProfileMedia,
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Invalid profile media cleanup request.' });
    expect(cleanupProfileMedia).not.toHaveBeenCalled();
  });

  it('delegates cleanup requests and maps successful responses', async () => {
    const adminClient = { kind: 'admin' } as unknown as SupabaseClient;
    const cleanupProfileMedia = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const },
    }));
    const request = new Request('http://localhost/api/profile/media/cleanup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'profile-media-cleanup-adapter-success-1',
      },
      body: JSON.stringify({ paths: ['user-1/avatar.png'] }),
    });

    const response = await postProfileMediaCleanupRouteResponse({
      request,
      dependencies: {
        cleanupProfileMedia,
        createServiceClient: vi.fn(() => adminClient),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('profile-media-cleanup-adapter-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(cleanupProfileMedia).toHaveBeenCalledWith({
      body: { paths: ['user-1/avatar.png'] },
      userId: 'user-1',
      client: expect.any(Function),
    });
  });
});
