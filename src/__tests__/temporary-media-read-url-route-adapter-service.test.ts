import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postTemporaryMediaReadUrlRouteResponse } from '@/lib/temporary-media-read-url-route-adapter-service';

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

describe('temporary media read-url route adapter service', () => {
  it('rejects unauthenticated read-url requests before parsing JSON or creating privileged clients', async () => {
    const createServiceClient = vi.fn();
    const createTemporaryMediaReadUrl = vi.fn();
    const request = new Request('http://localhost/api/uploads/media/read-url', {
      method: 'POST',
      headers: { 'x-request-id': 'media-read-url-auth-1' },
      body: JSON.stringify({
        storagePath: 'uploads/user-1/reference.png',
      }),
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postTemporaryMediaReadUrlRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createTemporaryMediaReadUrl,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-read-url-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createTemporaryMediaReadUrl).not.toHaveBeenCalled();
  });

  it('delegates read-url work with lazy service-client creation and private headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const createTemporaryMediaReadUrl = vi.fn(async () => ({
      ok: true as const,
      response: {
        success: true,
        signedUrl: 'https://storage.example.test/signed/reference.png',
        expiresInSeconds: 3600,
      },
    }));
    const body = {
      storagePath: 'uploads/user-1/reference.png',
    };

    const response = await postTemporaryMediaReadUrlRouteResponse({
      request: new Request('http://localhost/api/uploads/media/read-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'media-read-url-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient,
        createTemporaryMediaReadUrl,
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-read-url-success-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      signedUrl: 'https://storage.example.test/signed/reference.png',
      expiresInSeconds: 3600,
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createTemporaryMediaReadUrl).toHaveBeenCalledWith({
      body,
      userId: 'user-1',
      client: createServiceClient,
    });
  });

  it('maps read-url rate limits to stable route responses', async () => {
    const response = await postTemporaryMediaReadUrlRouteResponse({
      request: new Request('http://localhost/api/uploads/media/read-url', {
        method: 'POST',
        headers: { 'x-request-id': 'media-read-url-limit-1' },
        body: JSON.stringify({
          storagePath: 'uploads/user-1/reference.png',
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(),
        createTemporaryMediaReadUrl: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          error: 'Too many media reads. Try again shortly.',
          code: 'RATE_LIMITED',
          retryAfterSeconds: 31,
          limit: 120,
          remaining: 0,
          resetAt: '2026-06-23T13:00:00.000Z',
        })),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-read-url-limit-1');
    expect(response.headers.get('Retry-After')).toBe('31');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('120');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('2026-06-23T13:00:00.000Z');
    await expect(response.json()).resolves.toMatchObject({
      error: 'Too many media reads. Try again shortly.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 31,
      limit: 120,
      resetAt: '2026-06-23T13:00:00.000Z',
    });
  });
});
