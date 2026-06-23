import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getShowcaseSavedStateRouteResponse } from '@/lib/showcase-saved-state-route-adapter-service';
import type { ShowcaseSavedStateRouteResult } from '@/lib/showcase-saved-state-service';

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

describe('showcase saved-state route adapter service', () => {
  it('rejects unauthenticated reads before saved-state loading', async () => {
    const getShowcaseSavedStateForRoute = vi.fn();

    const response = await getShowcaseSavedStateRouteResponse({
      request: new Request('http://localhost/api/showcase/saved-state?ids=post-1', {
        headers: { 'x-request-id': 'saved-state-adapter-auth-1' },
      }),
      dependencies: {
        createUserClient: () => createUserClient(null),
        getShowcaseSavedStateForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('saved-state-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(getShowcaseSavedStateForRoute).not.toHaveBeenCalled();
  });

  it('parses ids and delegates saved-state loading with private headers', async () => {
    const userSupabase = createUserClient('user-1');
    const getShowcaseSavedStateForRoute = vi.fn(async (): Promise<ShowcaseSavedStateRouteResult> => ({
      ok: true,
      body: ['post-1', 'post-2'],
    }));

    const response = await getShowcaseSavedStateRouteResponse({
      request: new Request('http://localhost/api/showcase/saved-state?ids=post-1,%20,post-2', {
        headers: { 'x-request-id': 'saved-state-adapter-success-1' },
      }),
      dependencies: {
        createUserClient: () => userSupabase,
        getShowcaseSavedStateForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('saved-state-adapter-success-1');
    await expect(response.json()).resolves.toEqual(['post-1', 'post-2']);
    expect(getShowcaseSavedStateForRoute).toHaveBeenCalledWith({
      ids: ['post-1', 'post-2'],
      userId: 'user-1',
      userSupabase,
    });
  });

  it('maps saved-state service failures to private no-store responses', async () => {
    const getShowcaseSavedStateForRoute = vi.fn(async (): Promise<ShowcaseSavedStateRouteResult> => ({
      ok: false,
      status: 500,
      body: { error: 'Failed to fetch saved state' },
    }));

    const response = await getShowcaseSavedStateRouteResponse({
      request: new Request('http://localhost/api/showcase/saved-state?ids=post-1'),
      dependencies: {
        createUserClient: () => createUserClient('user-1'),
        getShowcaseSavedStateForRoute,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch saved state' });
  });

  it('logs unexpected failures and returns the stable saved-state failure response', async () => {
    const logError = vi.fn();
    const getShowcaseSavedStateForRoute = vi.fn(async () => {
      throw new Error('database unavailable');
    });

    const response = await getShowcaseSavedStateRouteResponse({
      request: new Request('http://localhost/api/showcase/saved-state?ids=post-1', {
        headers: { 'x-request-id': 'saved-state-adapter-failed-1' },
      }),
      dependencies: {
        createUserClient: () => createUserClient('user-1'),
        getShowcaseSavedStateForRoute,
        logError,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('saved-state-adapter-failed-1');
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch saved state' });
    expect(logError).toHaveBeenCalledWith('Showcase saved-state error:', expect.any(Error));
  });
});
