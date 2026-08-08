import { describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postShowcasePublishRouteResponse } from '@/lib/showcase-publish-route-adapter-service';

function publishSuccess(postId: string | null) {
  return {
    ok: true as const,
    body: {
      success: true as const,
      isPublic: true,
      visibility: 'public' as const,
      postId,
      showcasePath: postId ? `/showcase/${postId}` : null,
      ownerPath: null,
      resourceBundlePath: null,
      resourceBundleStatus: null,
      message: 'Published.',
    },
  };
}

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

describe('showcase publish route adapter service', () => {
  it('wraps requests in provider request-id context and rejects unauthenticated publishing before privileged work', async () => {
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const publishGenerationToShowcaseForRoute = vi.fn();
    const withProviderFetchRequestId = mockRequestIdPassthrough();
    const request = new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: { 'x-request-id': 'showcase-publish-auth-1' },
      body: JSON.stringify({ generationId: 'gen-1' }),
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postShowcasePublishRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        enforceBackendRateLimit,
        publishGenerationToShowcaseForRoute,
        withProviderFetchRequestId,
      },
    });

    expect(withProviderFetchRequestId).toHaveBeenCalledWith('showcase-publish-auth-1', expect.any(Function));
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-publish-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
  });

  it('rate limits publish requests before parsing the body', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 17,
      resetAt: '2026-06-23T13:00:00.000Z',
    });
    const request = new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: { 'x-request-id': 'showcase-publish-limit-1' },
      body: JSON.stringify({ generationId: 'gen-1' }),
    });
    const jsonSpy = vi.spyOn(request, 'json');
    const publishGenerationToShowcaseForRoute = vi.fn();

    const response = await postShowcasePublishRouteResponse({
      request,
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit: vi.fn(async () => {
          throw rateLimitError;
        }),
        publishGenerationToShowcaseForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-publish-limit-1');
    expect(response.headers.get('Retry-After')).toBe('17');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 17,
      limit: 20,
    });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
  });

  it('validates generation id before delegating publish work', async () => {
    const publishGenerationToShowcaseForRoute = vi.fn();
    const response = await postShowcasePublishRouteResponse({
      request: new Request('http://localhost/api/showcase/publish', {
        method: 'POST',
        headers: { 'x-request-id': 'showcase-publish-validation-1' },
        body: JSON.stringify({ visibility: 'public' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 60,
          remaining: 59,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T10:10:00.000Z',
        })),
        publishGenerationToShowcaseForRoute,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-publish-validation-1');
    await expect(response.json()).resolves.toEqual({ error: 'Missing generation ID' });
    expect(publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid publish requests with provider timeout dependency and private headers', async () => {
    const supabase = createUserClient('user-1');
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 60,
      remaining: 59,
      retryAfterSeconds: 0,
      resetAt: '2026-06-23T10:10:00.000Z',
    }));
    const fetchWithProviderTimeout = vi.fn();
    const body = {
      generationId: 'gen-1',
      visibility: 'public' as const,
      title: 'Launch post',
    };
    const publishGenerationToShowcaseForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        isPublic: true,
        visibility: 'public' as const,
        postId: 'post-1',
        showcasePath: 'showcase/gen-1/example.jpg',
        ownerPath: '/post/post-1/edit',
        resourceBundlePath: null,
        resourceBundleStatus: null,
        message: 'Published to showcase',
      },
    }));

    const response = await postShowcasePublishRouteResponse({
      request: new Request('http://localhost/api/showcase/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'showcase-publish-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => supabase,
        enforceBackendRateLimit,
        fetchWithProviderTimeout,
        publishGenerationToShowcaseForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-publish-success-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      postId: 'post-1',
      visibility: 'public',
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(adminSupabase, {
      key: 'user-1',
      limit: 20,
      scope: 'showcase:publish',
      windowSeconds: 600,
    });
    // The user-scoped client authenticates the request but is deliberately not
    // handed to the service: the publish read must use the service client, so
    // the column-scoped Data API grant on `generations` cannot break it.
    expect(publishGenerationToShowcaseForRoute).toHaveBeenCalledWith({
      adminSupabase,
      body,
      dependencies: {
        fetchWithProviderTimeout,
      },
      userId: 'user-1',
    });
  });

  it('kicks the rendition repair after a successful publish instead of waiting for the sweep', async () => {
    // Publishing copies the provider's file in untranscoded. Without this kick
    // the only thing that ever builds a rendition is the hourly sweep, so a
    // burst of publishes serves full-bitrate sources for hours.
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const repairMediaForPost = vi.fn(async () => ({ attempted: 1, completed: 1, failed: 0 }));
    const scheduled: Array<() => Promise<void>> = [];

    const response = await postShowcasePublishRouteResponse({
      request: new Request('http://localhost/api/showcase/publish', {
        method: 'POST',
        body: JSON.stringify({ generationId: 'gen-1' }),
      }),
      dependencies: {
        createServiceClient: () => adminSupabase,
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit: vi.fn(),
        publishGenerationToShowcaseForRoute: vi.fn(async () => publishSuccess('post-1')),
        repairMediaForPost,
        schedulePostMediaRepair: (callback) => { scheduled.push(callback); },
        withProviderFetchRequestId: mockRequestIdPassthrough(),
      },
    });

    expect(response.status).toBe(200);
    // Scheduled, not awaited -- the publish response must not wait on a transcode.
    expect(repairMediaForPost).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    await scheduled[0]();
    expect(repairMediaForPost).toHaveBeenCalledWith(adminSupabase, 'post-1');
  });

  it('never turns a successful publish into an error when the repair fails', async () => {
    // The post is already published and the hourly sweep repairs exactly this
    // work, so a repair failure must stay invisible to the caller.
    const scheduled: Array<() => Promise<void>> = [];

    const response = await postShowcasePublishRouteResponse({
      request: new Request('http://localhost/api/showcase/publish', {
        method: 'POST',
        body: JSON.stringify({ generationId: 'gen-1' }),
      }),
      dependencies: {
        createServiceClient: () => ({ kind: 'admin' } as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit: vi.fn(),
        publishGenerationToShowcaseForRoute: vi.fn(async () => publishSuccess('post-1')),
        repairMediaForPost: vi.fn(async () => { throw new Error('ffmpeg exploded'); }),
        schedulePostMediaRepair: (callback) => { scheduled.push(callback); },
        withProviderFetchRequestId: mockRequestIdPassthrough(),
      },
    });

    expect(response.status).toBe(200);
    await expect(scheduled[0]()).resolves.toBeUndefined();
  });

  it('schedules nothing when the publish produced no post', async () => {
    const schedulePostMediaRepair = vi.fn();

    await postShowcasePublishRouteResponse({
      request: new Request('http://localhost/api/showcase/publish', {
        method: 'POST',
        body: JSON.stringify({ generationId: 'gen-1' }),
      }),
      dependencies: {
        createServiceClient: () => ({ kind: 'admin' } as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
        enforceBackendRateLimit: vi.fn(),
        publishGenerationToShowcaseForRoute: vi.fn(async () => publishSuccess(null)),
        schedulePostMediaRepair,
        withProviderFetchRequestId: mockRequestIdPassthrough(),
      },
    });

    expect(schedulePostMediaRepair).not.toHaveBeenCalled();
  });
});
