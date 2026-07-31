import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postShowcaseRemixRouteResponse } from '@/lib/showcase-remix-route-adapter-service';

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

describe('showcase remix route adapter service', () => {
  it('rejects unauthenticated remix requests before privileged work or body parsing', async () => {
    const request = new Request('http://localhost/api/showcase/remix', {
      method: 'POST',
      headers: { 'x-request-id': 'showcase-remix-auth-1' },
      body: JSON.stringify({ postId: 'post-1' }),
    });
    const jsonSpy = vi.spyOn(request, 'json');
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const remixShowcasePostForRoute = vi.fn();

    const response = await postShowcaseRemixRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        enforceBackendRateLimit,
        remixShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-remix-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized: Please log in to remix creations' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(remixShowcasePostForRoute).not.toHaveBeenCalled();
  });

  it('rate limits remix requests before parsing the body', async () => {
    const request = new Request('http://localhost/api/showcase/remix', {
      method: 'POST',
      headers: { 'x-request-id': 'showcase-remix-limit-1' },
      body: JSON.stringify({ postId: 'post-1' }),
    });
    const jsonSpy = vi.spyOn(request, 'json');
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 28,
      resetAt: '2026-06-23T08:00:00.000Z',
    });
    const remixShowcasePostForRoute = vi.fn();

    const response = await postShowcaseRemixRouteResponse({
      request,
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit: vi.fn(async () => {
          throw rateLimitError;
        }),
        remixShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('28');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-remix-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 28,
      limit: 60,
    });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(remixShowcasePostForRoute).not.toHaveBeenCalled();
  });

  it('validates the remix reference and delegates valid requests', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const userSupabase = createUserClient('user-1');
    const remixShowcasePostForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        redirectTo: '/create-image?remix=gen-1&remixPost=post-1',
        prefill: {
          prompt: 'Create a clean UGC product reveal.',
          settings: { model: 'nano-banana-2' },
        },
      },
    }));

    const response = await postShowcaseRemixRouteResponse({
      request: new Request('http://localhost/api/showcase/remix', {
        method: 'POST',
        headers: { 'x-request-id': 'showcase-remix-success-1' },
        body: JSON.stringify({ generationId: 'gen-1', postId: 'post-1' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => userSupabase,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 60,
          remaining: 59,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T10:10:00.000Z',
        })),
        remixShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-remix-success-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      redirectTo: '/create-image?remix=gen-1&remixPost=post-1',
    });
    expect(remixShowcasePostForRoute).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: adminSupabase,
    });
  });
});
