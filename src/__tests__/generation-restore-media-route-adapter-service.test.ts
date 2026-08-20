import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postGenerationRestoreMediaRouteResponse } from '@/lib/generation-restore-media-route-adapter-service';

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

async function requireIdentityForTest(userClient: SupabaseClient) {
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    return {
      ok: false as const,
      status: 401,
      code: 'UNAUTHORIZED' as const,
      error: 'Unauthorized',
    };
  }
  return {
    ok: true as const,
    identity: { user, userId: user.id, kind: 'registered' as const, isGuest: false },
  };
}

describe('generation restore-media route adapter service', () => {
  it('rejects unauthenticated restore requests before parsing JSON or creating privileged clients', async () => {
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const restoreGenerationMediaForRoute = vi.fn();
    const request = new Request('http://localhost/api/generations/gen-1/restore-media', {
      method: 'POST',
      headers: { 'x-request-id': 'restore-media-auth-1' },
      body: JSON.stringify({
        storagePath: 'uploads/user-1/replacement.png',
      }),
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postGenerationRestoreMediaRouteResponse({
      context: { params: Promise.resolve({ id: 'gen-1' }) },
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        enforceBackendRateLimit,
        requireIdentity: requireIdentityForTest,
        restoreGenerationMediaForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('restore-media-auth-1');
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
    });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(restoreGenerationMediaForRoute).not.toHaveBeenCalled();
  });

  it('rejects malformed restore JSON before creating privileged clients', async () => {
    const createServiceClient = vi.fn();
    const response = await postGenerationRestoreMediaRouteResponse({
      context: { params: Promise.resolve({ id: 'gen-1' }) },
      request: new Request('http://localhost/api/generations/gen-1/restore-media', {
        method: 'POST',
        headers: { 'x-request-id': 'restore-media-json-1' },
        body: '{',
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('user-1'),
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('restore-media-json-1');
    await expect(response.json()).resolves.toEqual({ error: 'Invalid restore request.' });
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it.each([
    { status: 409, code: 'SESSION_MERGED', error: 'This guest session has been linked to an account. Sign in to continue.' },
    { status: 409, code: 'ACCOUNT_DELETING', error: 'This account is being permanently deleted.' },
    { status: 503, code: 'IDENTITY_CHECK_UNAVAILABLE', error: 'Identity verification is temporarily unavailable. Please try again.' },
  ] as const)('rejects $code before parsing or restore work', async (failure) => {
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const restoreGenerationMediaForRoute = vi.fn();
    const request = new Request('http://localhost/api/generations/gen-1/restore-media', {
      method: 'POST',
      body: JSON.stringify({ storagePath: 'uploads/user-1/replacement.png' }),
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postGenerationRestoreMediaRouteResponse({
      context: { params: Promise.resolve({ id: 'gen-1' }) },
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit,
        requireIdentity: vi.fn(async () => ({ ok: false as const, ...failure })),
        restoreGenerationMediaForRoute,
      },
    });

    expect(response.status).toBe(failure.status);
    await expect(response.json()).resolves.toEqual({
      error: failure.error,
      code: failure.code,
    });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(restoreGenerationMediaForRoute).not.toHaveBeenCalled();
  });

  it('rate limits generation restore before delegating media replacement work', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 21,
      resetAt: '2026-06-23T13:00:00.000Z',
    });
    const restoreGenerationMediaForRoute = vi.fn();

    const response = await postGenerationRestoreMediaRouteResponse({
      context: { params: Promise.resolve({ id: 'gen-1' }) },
      request: new Request('http://localhost/api/generations/gen-1/restore-media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'restore-media-limit-1',
        },
        body: JSON.stringify({
          storagePath: 'uploads/user-1/replacement.png',
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit: vi.fn(async () => {
          throw rateLimitError;
        }),
        requireIdentity: requireIdentityForTest,
        restoreGenerationMediaForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('restore-media-limit-1');
    expect(response.headers.get('Retry-After')).toBe('21');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 21,
      limit: 60,
    });
    expect(restoreGenerationMediaForRoute).not.toHaveBeenCalled();
  });

  it('delegates authenticated restore requests to the restore service with private headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 60,
      remaining: 59,
      retryAfterSeconds: 0,
      resetAt: '2026-06-23T10:10:00.000Z',
    }));
    const body = {
      storagePath: 'uploads/user-1/replacement.png',
      originalName: 'replacement.png',
      contentType: 'image/png',
    };
    const restoreGenerationMediaForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        outputUrl: 'generated_images/user-1/restored-gen-1.png',
      },
    }));

    const response = await postGenerationRestoreMediaRouteResponse({
      context: { params: Promise.resolve({ id: 'gen-1' }) },
      request: new Request('http://localhost/api/generations/gen-1/restore-media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'restore-media-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit,
        requireIdentity: requireIdentityForTest,
        restoreGenerationMediaForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('restore-media-success-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      outputUrl: 'generated_images/user-1/restored-gen-1.png',
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(adminSupabase, {
      key: 'user-1',
      limit: 60,
      scope: 'generation-lifecycle:mutate',
      windowSeconds: 600,
    });
    expect(restoreGenerationMediaForRoute).toHaveBeenCalledWith({
      adminSupabase,
      body,
      generationId: 'gen-1',
      userId: 'user-1',
    });
  });
});
