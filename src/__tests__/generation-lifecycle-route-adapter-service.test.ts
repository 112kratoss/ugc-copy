import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  generationArchiveRouteResponse,
  generationDeleteRouteResponse,
  generationRestoreRouteResponse,
} from '@/lib/generation-lifecycle-route-adapter-service';
import type { GenerationDeleteRouteResult } from '@/lib/generation-delete-service';
import type { GenerationLifecycleResult } from '@/lib/generation-lifecycle-service';

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

function createIdentityAdminClient({
  error = null,
  state,
}: {
  error?: Error | null;
  state: 'active' | 'merged' | 'deleting';
}) {
  return {
    from: vi.fn((table: string) => {
      if (table !== 'profiles') throw new Error(`Unexpected table: ${table}`);
      const query = {
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({
          data: { identity_state: state },
          error,
        })),
      };
      return { select: vi.fn(() => query) };
    }),
  } as unknown as SupabaseClient;
}

describe('generation lifecycle route adapter service', () => {
  it('rejects unauthenticated archive requests before privileged clients or lifecycle work', async () => {
    const archiveOwnerGenerationForRoute = vi.fn();
    const createServiceClient = vi.fn();

    const response = await generationArchiveRouteResponse({
      generationId: 'generation-1',
      request: new Request('http://localhost/api/generations/generation-1/archive', {
        method: 'POST',
        headers: { 'x-request-id': 'generation-archive-adapter-auth-1' },
      }),
      dependencies: {
        archiveOwnerGenerationForRoute,
        createServiceClient,
        createUserClient: () => createUserClient(null),
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-archive-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(archiveOwnerGenerationForRoute).not.toHaveBeenCalled();
  });

  it('delegates successful archive requests with owner and generation ids', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const archiveOwnerGenerationForRoute = vi.fn(
      async (): Promise<GenerationLifecycleResult> => ({
        ok: true,
        body: { success: true, archived: true },
      }),
    );

    const response = await generationArchiveRouteResponse({
      generationId: 'generation-1',
      request: new Request('http://localhost/api/generations/generation-1/archive', {
        method: 'POST',
        headers: { 'x-request-id': 'generation-archive-adapter-success-1' },
      }),
      dependencies: {
        archiveOwnerGenerationForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('user-1'),
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-archive-adapter-success-1');
    await expect(response.json()).resolves.toEqual({ success: true, archived: true });
    expect(archiveOwnerGenerationForRoute).toHaveBeenCalledWith({
      adminSupabase,
      generationId: 'generation-1',
      ownerUserId: 'user-1',
    });
  });

  it('maps lifecycle rate-limit responses with standard private headers for restore', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 33,
      resetAt: '2026-06-23T12:00:00.000Z',
    });
    const restoreOwnerGenerationForRoute = vi.fn(
      async (): Promise<GenerationLifecycleResult> => ({
        ok: false,
        rateLimitError,
      }),
    );

    const response = await generationRestoreRouteResponse({
      generationId: 'generation-1',
      request: new Request('http://localhost/api/generations/generation-1/restore', {
        method: 'POST',
        headers: { 'x-request-id': 'generation-restore-adapter-limit-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
        requireIdentity: requireIdentityForTest,
        restoreOwnerGenerationForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('33');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-restore-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 33,
      limit: 60,
    });
  });

  it('maps unexpected restore failures to stable responses', async () => {
    const logError = vi.fn();
    const restoreOwnerGenerationForRoute = vi.fn(async () => {
      throw new Error('database unavailable');
    });

    const response = await generationRestoreRouteResponse({
      generationId: 'generation-1',
      request: new Request('http://localhost/api/generations/generation-1/restore', {
        method: 'POST',
        headers: { 'x-request-id': 'generation-restore-adapter-failed-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
        logError,
        requireIdentity: requireIdentityForTest,
        restoreOwnerGenerationForRoute,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-restore-adapter-failed-1');
    await expect(response.json()).resolves.toEqual({ error: 'Failed to restore creation.' });
    expect(logError).toHaveBeenCalledWith('Failed to restore owner generation:', expect.any(Error));
  });

  it('delegates delete requests with lazy Supabase factories and private trace headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const userSupabase = createUserClient('user-1');
    const createServiceClient = vi.fn(() => adminSupabase);
    const createUserClientDependency = vi.fn(() => userSupabase);
    // Typed with the real signature so `mock.calls` is a tuple of its actual
    // arguments; a bare vi.fn() infers zero parameters and calls[0][0] cannot compile.
    const deleteOwnerGenerationForRoute = vi.fn<typeof import('@/lib/generation-delete-service').deleteOwnerGenerationForRoute>(
      async (): Promise<GenerationDeleteRouteResult> => ({
        ok: true,
        body: { success: true, deleted: true },
      }),
    );
    const request = new Request('http://localhost/api/generations/generation-1', {
      method: 'DELETE',
      headers: { 'x-request-id': 'generation-delete-adapter-success-1' },
    });

    const response = await generationDeleteRouteResponse({
      generationId: 'generation-1',
      request,
      dependencies: {
        createServiceClient,
        createUserClient: createUserClientDependency,
        deleteOwnerGenerationForRoute,
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-delete-adapter-success-1');
    await expect(response.json()).resolves.toEqual({ success: true, deleted: true });
    expect(deleteOwnerGenerationForRoute).toHaveBeenCalledTimes(1);

    const serviceInput = deleteOwnerGenerationForRoute.mock.calls[0][0];
    expect(serviceInput.generationId).toBe('generation-1');
    expect(serviceInput.request).toBe(request);
    expect(serviceInput.createAdminSupabase()).toBe(adminSupabase);
    expect(serviceInput.createUserSupabase()).toBe(userSupabase);
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createUserClientDependency).toHaveBeenCalledWith(request);
  });

  it('maps delete rate-limit responses with standard private headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 28,
      resetAt: '2026-06-23T12:10:00.000Z',
    });

    const response = await generationDeleteRouteResponse({
      generationId: 'generation-1',
      request: new Request('http://localhost/api/generations/generation-1', {
        method: 'DELETE',
        headers: { 'x-request-id': 'generation-delete-adapter-limit-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
        deleteOwnerGenerationForRoute: vi.fn(
          async (): Promise<GenerationDeleteRouteResult> => ({
            ok: false,
            status: 429,
            body: { error: 'Too many generation changes.' },
            rateLimitError,
          }),
        ),
        requireIdentity: requireIdentityForTest,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('28');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-delete-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 28,
      limit: 60,
    });
  });

  it.each([
    {
      action: 'archive' as const,
      identityLookupError: null,
      identityState: 'merged' as const,
      failure: {
        ok: false as const,
        status: 409,
        code: 'SESSION_MERGED' as const,
        error: 'This guest session has been linked to an account. Sign in to continue.',
      },
    },
    {
      action: 'restore' as const,
      identityLookupError: null,
      identityState: 'deleting' as const,
      failure: {
        ok: false as const,
        status: 409,
        code: 'ACCOUNT_DELETING' as const,
        error: 'This account is being permanently deleted.',
      },
    },
    {
      action: 'restore' as const,
      identityLookupError: new Error('database unavailable'),
      identityState: 'active' as const,
      failure: {
        ok: false as const,
        status: 503,
        code: 'IDENTITY_CHECK_UNAVAILABLE' as const,
        error: 'Identity verification is temporarily unavailable. Please try again.',
      },
    },
  ])('rejects $failure.code identities before $action mutation work', async ({
    action,
    failure,
    identityLookupError,
    identityState,
  }) => {
    const archiveOwnerGenerationForRoute = vi.fn();
    const restoreOwnerGenerationForRoute = vi.fn();
    const adminSupabase = createIdentityAdminClient({
      error: identityLookupError,
      state: identityState,
    });
    const createServiceClient = vi.fn(() => adminSupabase);
    const input = {
      generationId: 'generation-1',
      request: new Request(`http://localhost/api/generations/generation-1/${action}`, {
        method: 'POST',
      }),
      dependencies: {
        archiveOwnerGenerationForRoute,
        createServiceClient,
        createUserClient: () => createUserClient('user-1'),
        restoreOwnerGenerationForRoute,
      },
    };

    const response = action === 'archive'
      ? await generationArchiveRouteResponse(input)
      : await generationRestoreRouteResponse(input);

    expect(response.status).toBe(failure.status);
    await expect(response.json()).resolves.toEqual({
      error: failure.error,
      code: failure.code,
    });
    expect(createServiceClient).toHaveBeenCalledOnce();
    expect(archiveOwnerGenerationForRoute).not.toHaveBeenCalled();
    expect(restoreOwnerGenerationForRoute).not.toHaveBeenCalled();
  });
});
