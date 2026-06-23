import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getShowcaseSavedMediaRouteResponse } from '@/lib/showcase-saved-media-route-adapter-service';

describe('showcase saved media route adapter service', () => {
  const createUserClient = vi.fn();
  const createServiceClient = vi.fn();
  const getSavedMediaFeedForRoute = vi.fn();
  const logError = vi.fn();
  const user = { id: 'user-1' };
  const userSupabase = {
    auth: {
      getUser: vi.fn(),
    },
  };

  beforeEach(() => {
    createUserClient.mockReset();
    userSupabase.auth.getUser.mockReset();
    userSupabase.auth.getUser.mockResolvedValue({
      data: { user },
      error: null,
    });
    createUserClient.mockReturnValue(userSupabase);
    createServiceClient.mockReset();
    getSavedMediaFeedForRoute.mockReset();
    getSavedMediaFeedForRoute.mockResolvedValue({
      ok: true,
      body: {
        items: [{ id: 'post-1', isSaved: true }],
        pageInfo: {
          hasMore: false,
          nextOffset: null,
          limit: 48,
          offset: 12,
        },
      },
    });
    logError.mockReset();
  });

  it('authenticates, clamps query params, and delegates saved-media loading with private headers', async () => {
    const response = await getShowcaseSavedMediaRouteResponse({
      request: new Request('http://localhost/api/showcase/saved-media?limit=999&offset=12', {
        headers: { 'x-request-id': 'saved-media-route-1' },
      }),
      dependencies: {
        createServiceClient,
        createUserClient,
        getSavedMediaFeedForRoute,
        logError,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('saved-media-route-1');
    await expect(response.json()).resolves.toMatchObject({
      items: [{ id: 'post-1', isSaved: true }],
      pageInfo: {
        limit: 48,
        offset: 12,
      },
    });
    expect(getSavedMediaFeedForRoute).toHaveBeenCalledWith({
      createAdminSupabase: createServiceClient,
      limit: 48,
      offset: 12,
      userId: user.id,
      userSupabase,
    });
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated saved-media reads before admin work or feed loading', async () => {
    userSupabase.auth.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error('missing session'),
    });

    const response = await getShowcaseSavedMediaRouteResponse({
      request: new Request('http://localhost/api/showcase/saved-media', {
        headers: { 'x-request-id': 'saved-media-auth-1' },
      }),
      dependencies: {
        createServiceClient,
        createUserClient,
        getSavedMediaFeedForRoute,
        logError,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('saved-media-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(getSavedMediaFeedForRoute).not.toHaveBeenCalled();
  });

  it('maps saved-media service failures into private no-store route responses', async () => {
    getSavedMediaFeedForRoute.mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: { error: 'Failed to fetch saved media' },
    });

    const response = await getShowcaseSavedMediaRouteResponse({
      request: new Request('http://localhost/api/showcase/saved-media?limit=bad&offset=-1'),
      dependencies: {
        createServiceClient,
        createUserClient,
        getSavedMediaFeedForRoute,
        logError,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch saved media' });
    expect(getSavedMediaFeedForRoute).toHaveBeenCalledWith({
      createAdminSupabase: createServiceClient,
      limit: 24,
      offset: 0,
      userId: user.id,
      userSupabase,
    });
  });
});
