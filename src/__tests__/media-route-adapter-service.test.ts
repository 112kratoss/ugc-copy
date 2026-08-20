import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { getMediaRouteResponse } from '@/lib/media-route-adapter-service';

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
    return { ok: false as const, status: 401, code: 'UNAUTHORIZED' as const, error: 'Unauthorized' };
  }
  return {
    ok: true as const,
    identity: { user, userId: user.id, kind: 'registered' as const, isGuest: false },
  };
}

describe('getMediaRouteResponse', () => {
  it('rejects invalid media paths before creating auth or service clients', async () => {
    const createMediaSupabaseClient = vi.fn();
    const createServiceClient = vi.fn();
    const createMediaReadSignedUrlForRoute = vi.fn();

    const response = await getMediaRouteResponse({
      request: new Request('http://localhost/api/media?bucket=avatars&path=user%2Ffile.jpg'),
      dependencies: {
        createMediaSupabaseClient,
        createServiceClient,
        createMediaReadSignedUrlForRoute,
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid media path' });
    expect(createMediaSupabaseClient).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createMediaReadSignedUrlForRoute).not.toHaveBeenCalled();
  });

  it('requires an authenticated user before creating the service client', async () => {
    const createServiceClient = vi.fn();
    const createMediaReadSignedUrlForRoute = vi.fn();

    const response = await getMediaRouteResponse({
      request: new Request('http://localhost/api/media?bucket=generated_images&path=user%2Ffile.jpg'),
      dependencies: {
        createMediaSupabaseClient: vi.fn(async () => createUserClient(null)),
        createServiceClient,
        createMediaReadSignedUrlForRoute,
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createMediaReadSignedUrlForRoute).not.toHaveBeenCalled();
  });

  it('redirects to the signed media URL with short private caching', async () => {
    const userClient = createUserClient('user-1');
    const rateLimitClient = { rpc: vi.fn() } as unknown as SupabaseClient;
    const createMediaReadSignedUrlForRoute = vi.fn(async () => ({
      ok: true as const,
      signedUrl: 'https://project.supabase.co/storage/v1/object/sign/generated_images/user/file.jpg?token=abc',
    }));

    const response = await getMediaRouteResponse({
      request: new Request('http://localhost/api/media?bucket=generated_images&path=user%2Ffile.jpg'),
      dependencies: {
        createMediaSupabaseClient: vi.fn(async () => userClient),
        createServiceClient: vi.fn(() => rateLimitClient),
        createMediaReadSignedUrlForRoute,
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://project.supabase.co/storage/v1/object/sign/generated_images/user/file.jpg?token=abc',
    );
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(createMediaReadSignedUrlForRoute).toHaveBeenCalledWith({
      payload: {
        bucket: 'generated_images',
        filePath: 'user/file.jpg',
        downloadFilename: null,
      },
      rateLimitClient,
      userClient,
      userId: 'user-1',
    });
  });

  it('maps media read rate-limit failures to standard backend responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 300,
      remaining: 0,
      retryAfterSeconds: 25,
      resetAt: '2026-06-23T11:30:00.000Z',
    });

    const response = await getMediaRouteResponse({
      request: new Request('http://localhost/api/media?bucket=generated_images&path=user%2Ffile.jpg'),
      dependencies: {
        createMediaSupabaseClient: vi.fn(async () => createUserClient('user-1')),
        createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
        createMediaReadSignedUrlForRoute: vi.fn(async () => ({
          ok: false as const,
          rateLimitError,
        })),
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('25');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 25,
      limit: 300,
    });
  });

  it.each([
    {
      status: 409,
      code: 'SESSION_MERGED' as const,
      error: 'This guest session has been linked to an account. Sign in to continue.',
    },
    {
      status: 409,
      code: 'ACCOUNT_DELETING' as const,
      error: 'This account is being permanently deleted.',
    },
  ])('returns stable $code admission for cookie-authenticated sessions', async (failure) => {
    const createMediaReadSignedUrlForRoute = vi.fn();
    const profileQuery = {
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({
        data: {
          identity_state: failure.code === 'SESSION_MERGED' ? 'merged' : 'deleting',
        },
        error: null,
      })),
    };
    profileQuery.eq.mockReturnValue(profileQuery);
    const createServiceClient = vi.fn(() => ({
      from: vi.fn(() => ({ select: vi.fn(() => profileQuery) })),
    }) as unknown as SupabaseClient);
    const response = await getMediaRouteResponse({
      request: new Request(
        'http://localhost/api/media?bucket=generated_images&path=user%2Ffile.jpg',
        { headers: { Cookie: 'sb-auth-token=browser-session' } },
      ),
      dependencies: {
        createMediaSupabaseClient: vi.fn(async () => createUserClient('user-1')),
        createServiceClient,
        createMediaReadSignedUrlForRoute,
      },
    });

    expect(response.status).toBe(failure.status);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: failure.error,
      code: failure.code,
    });
    expect(createServiceClient).toHaveBeenCalledOnce();
    expect(createMediaReadSignedUrlForRoute).not.toHaveBeenCalled();
  });
});
