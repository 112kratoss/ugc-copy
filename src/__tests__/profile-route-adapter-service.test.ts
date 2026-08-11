import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProfileRouteHandlers,
  getProfileRouteResult,
  patchProfileRouteResult,
} from '@/lib/profile-route-adapter-service';

describe('profile route adapter service', () => {
  const createUserClient = vi.fn();
  const createServiceClient = vi.fn();
  const getProfileForRoute = vi.fn();
  const updateProfileForRoute = vi.fn();
  const adminSupabase = { service: 'supabase-admin' };
  const user = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'creator@example.test',
    user_metadata: { full_name: 'Creator' },
  };

  beforeEach(() => {
    createUserClient.mockReset();
    createUserClient.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user },
          error: null,
        })),
      },
    });
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(adminSupabase);
    getProfileForRoute.mockReset();
    getProfileForRoute.mockResolvedValue({
      ok: true,
      response: {
        id: user.id,
        username: 'creator',
        suggestedUsername: 'creator-11111111',
        displayName: 'Creator',
        bio: null,
        avatarUrl: null,
        coverUrl: null,
        websiteUrl: null,
        twitterHandle: null,
        instagramHandle: null,
        tiktokHandle: null,
        location: null,
        credits: 25,
      },
    });
    updateProfileForRoute.mockReset();
    updateProfileForRoute.mockResolvedValue({
      ok: true,
      response: {
        id: user.id,
        username: 'creator-name',
        suggestedUsername: 'creator-11111111',
        displayName: 'Creator Name',
        bio: null,
        avatarUrl: null,
        coverUrl: null,
        websiteUrl: null,
        twitterHandle: null,
        instagramHandle: null,
        tiktokHandle: null,
        location: null,
        credits: 25,
      },
    });
  });

  it('authenticates and loads the current profile with private no-store headers', async () => {
    const request = new Request('http://localhost/api/profile', {
      headers: { 'x-request-id': 'profile-adapter-get' },
    });

    const result = await getProfileRouteResult({
      request,
      dependencies: {
        createUserClient,
        createServiceClient,
        getProfileForRoute,
      },
    });

    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    expect(result.headers.get('x-request-id')).toBe('profile-adapter-get');
    expect(result.body).toMatchObject({
      id: user.id,
      username: 'creator',
      credits: 25,
    });
    expect(getProfileForRoute).toHaveBeenCalledWith({
      user,
      client: createServiceClient,
    });
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('parses the patch payload and delegates profile updates after auth', async () => {
    const request = new Request('http://localhost/api/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'profile-adapter-patch',
      },
      body: JSON.stringify({
        username: 'Creator-Name',
        displayName: 'Creator Name',
      }),
    });

    const result = await patchProfileRouteResult({
      request,
      dependencies: {
        createUserClient,
        createServiceClient,
        updateProfileForRoute,
      },
    });

    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    expect(result.body).toMatchObject({
      username: 'creator-name',
      displayName: 'Creator Name',
    });
    expect(updateProfileForRoute).toHaveBeenCalledWith({
      userId: user.id,
      body: {
        username: 'Creator-Name',
        displayName: 'Creator Name',
      },
      client: createServiceClient,
    });
  });

  it('refuses to let a guest claim a username', async () => {
    // Two reasons, one gate. A username is unique and finite, and anonymous
    // sessions are free and unlimited, so guests could squat every good handle.
    // Setting one was also enough to pass the welcome-credit eligibility check,
    // which reads "identity claimed" as a proxy for "registered" — that payout
    // is refused in the database now, and this stops the attempt earlier.
    createUserClient.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { ...user, email: null, is_anonymous: true } },
          error: null,
        })),
      },
    });

    const result = await patchProfileRouteResult({
      request: new Request('https://app.example/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'freeloader', displayName: 'Free Loader' }),
      }),
      dependencies: {
        createUserClient,
        createServiceClient,
        updateProfileForRoute,
      },
    });

    expect(result.status).toBe(403);
    expect(updateProfileForRoute).not.toHaveBeenCalled();
  });

  it('maps profile rate-limit failures into body and headers', async () => {
    updateProfileForRoute.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: 'Too many profile updates.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 40,
      limit: 30,
      remaining: 0,
      resetAt: '2026-06-22T06:30:00.000Z',
    });

    const result = await patchProfileRouteResult({
      request: new Request('http://localhost/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Creator Name' }),
      }),
      dependencies: {
        createUserClient,
        createServiceClient,
        updateProfileForRoute,
      },
    });

    expect(result.status).toBe(429);
    expect(result.headers.get('Retry-After')).toBe('40');
    expect(result.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(result.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(result.headers.get('X-RateLimit-Reset')).toBe('2026-06-22T06:30:00.000Z');
    expect(result.body).toEqual({
      error: 'Too many profile updates.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 40,
      limit: 30,
      resetAt: '2026-06-22T06:30:00.000Z',
    });
  });

  it('rejects unauthenticated profile updates before privileged work or body parsing', async () => {
    const json = vi.fn(async () => ({ displayName: 'Should not parse' }));
    createUserClient.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: { message: 'missing session' },
        })),
      },
    });

    const result = await patchProfileRouteResult({
      request: {
        headers: new Headers(),
        json,
      } as unknown as Request,
      dependencies: {
        createUserClient,
        createServiceClient,
        updateProfileForRoute,
      },
    });

    expect(result).toMatchObject({
      status: 401,
      body: { error: 'Unauthorized' },
    });
    expect(json).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(updateProfileForRoute).not.toHaveBeenCalled();
  });

  it('creates compact GET and PATCH handlers for the profile route entrypoint', async () => {
    const { GET, PATCH } = createProfileRouteHandlers({
      dependencies: {
        createUserClient,
        createServiceClient,
        getProfileForRoute,
        updateProfileForRoute,
      },
    });

    const getResponse = await GET(new Request('http://localhost/api/profile', {
      headers: { 'x-request-id': 'profile-factory-get' },
    }));
    const patchResponse = await PATCH(new Request('http://localhost/api/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'profile-factory-patch',
      },
      body: JSON.stringify({ username: 'Creator-Name' }),
    }));

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getResponse.headers.get('x-request-id')).toBe('profile-factory-get');
    await expect(getResponse.json()).resolves.toMatchObject({
      id: user.id,
      username: 'creator',
    });
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(patchResponse.headers.get('x-request-id')).toBe('profile-factory-patch');
    await expect(patchResponse.json()).resolves.toMatchObject({
      id: user.id,
      username: 'creator-name',
    });
    expect(getProfileForRoute).toHaveBeenCalledTimes(1);
    expect(updateProfileForRoute).toHaveBeenCalledTimes(1);
  });
});
