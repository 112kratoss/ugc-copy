import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postShowcaseSaveRouteResponse } from '@/lib/showcase-save-route-adapter-service';

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

describe('showcase save route adapter service', () => {
  it('rejects unauthenticated save requests before privileged clients, rate limits, or body parsing', async () => {
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const saveShowcasePostForRoute = vi.fn();
    const request = new Request('http://localhost/api/showcase/save', {
      method: 'POST',
      headers: { 'x-request-id': 'showcase-save-auth-1' },
      body: JSON.stringify({
        postId: 'post-1',
        shouldSave: true,
      }),
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postShowcaseSaveRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        enforceBackendRateLimit,
        saveShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-save-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(saveShowcasePostForRoute).not.toHaveBeenCalled();
  });

  it('rate limits saves before parsing the save body', async () => {
    const serviceClient = { kind: 'service' } as unknown as SupabaseClient;
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 120,
      remaining: 0,
      retryAfterSeconds: 34,
      resetAt: '2026-06-23T13:00:00.000Z',
    });
    const request = new Request('http://localhost/api/showcase/save', {
      method: 'POST',
      headers: { 'x-request-id': 'showcase-save-limit-1' },
      body: JSON.stringify({
        postId: 'post-1',
        shouldSave: true,
      }),
    });
    const jsonSpy = vi.spyOn(request, 'json');
    const saveShowcasePostForRoute = vi.fn();

    const response = await postShowcaseSaveRouteResponse({
      request,
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit: vi.fn(async () => {
          throw rateLimitError;
        }),
        saveShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-save-limit-1');
    expect(response.headers.get('Retry-After')).toBe('34');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 34,
      limit: 120,
    });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(saveShowcasePostForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid save requests with normalized state and private headers', async () => {
    const serviceClient = { kind: 'service' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => serviceClient);
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 120,
      remaining: 119,
      retryAfterSeconds: 0,
      resetAt: '2026-06-23T10:10:00.000Z',
    }));
    const body = {
      postId: 'post-1',
      shouldSave: true,
      sourceSurface: 'showcase',
    };
    const saveShowcasePostForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        isSaved: true,
        saveCount: 5,
        changed: true,
        message: 'Saved to bookmarks',
      },
    }));

    const response = await postShowcaseSaveRouteResponse({
      request: new Request('http://localhost/api/showcase/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'showcase-save-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit,
        saveShowcasePostForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-save-success-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      isSaved: true,
      saveCount: 5,
      changed: true,
      message: 'Saved to bookmarks',
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(serviceClient, {
      key: 'user-1',
      limit: 120,
      scope: 'showcase:save',
      windowSeconds: 600,
    });
    expect(saveShowcasePostForRoute).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState: true,
      serviceClient,
      sourceSurface: 'showcase',
    });
  });

  it('returns stable validation errors for missing ids and invalid save state', async () => {
    const dependencies = {
      createServiceClient: vi.fn(() => ({ kind: 'service' }) as unknown as SupabaseClient),
      createUserClient: () => createUserClient('user-1'),
      enforceBackendRateLimit: vi.fn(async () => ({
        allowed: true,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 0,
        resetAt: '2026-06-23T10:10:00.000Z',
      })),
      saveShowcasePostForRoute: vi.fn(),
    };

    const missingId = await postShowcaseSaveRouteResponse({
      request: new Request('http://localhost/api/showcase/save', {
        method: 'POST',
        body: JSON.stringify({ shouldSave: true }),
      }),
      dependencies,
    });
    expect(missingId.status).toBe(400);
    await expect(missingId.json()).resolves.toEqual({ error: 'Missing post ID' });

    const invalidState = await postShowcaseSaveRouteResponse({
      request: new Request('http://localhost/api/showcase/save', {
        method: 'POST',
        body: JSON.stringify({ postId: 'post-1', shouldSave: 'yes' }),
      }),
      dependencies,
    });
    expect(invalidState.status).toBe(400);
    await expect(invalidState.json()).resolves.toEqual({ error: 'Invalid save state' });
    expect(dependencies.saveShowcasePostForRoute).not.toHaveBeenCalled();
  });
});
