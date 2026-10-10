import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postShowcaseViewerExclusionsRouteResponse } from '@/lib/showcase-viewer-exclusions-route-adapter-service';
import type { ShowcaseViewerExclusionsRouteResult } from '@/lib/showcase-viewer-exclusions-service';

const POST_ID = '10000000-0000-4000-8000-000000000001';
const CREATOR_ID = '00000000-0000-4000-8000-00000000000a';

function createUserClient(user: { id: string; is_anonymous?: boolean } | null = { id: 'user-1' }) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user },
        error: user ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

function exclusionsRequest(body: unknown, requestId = 'exclusions-1') {
  return new Request('http://localhost/api/showcase/viewer-exclusions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('showcase viewer exclusions route adapter service', () => {
  it.each([
    ['a signed-out request', null],
    ['a guest, who holds a valid token and no account', { id: 'guest-1', is_anonymous: true }],
  ])('refuses %s before anything is read', async (_label, user) => {
    const getShowcaseViewerExclusionsForRoute = vi.fn();
    const createServiceClient = vi.fn();

    const response = await postShowcaseViewerExclusionsRouteResponse({
      request: exclusionsRequest({ items: [{ postId: POST_ID, creatorId: CREATOR_ID }] }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(user),
        getShowcaseViewerExclusionsForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(getShowcaseViewerExclusionsForRoute).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("answers for the signed-in viewer, never for an id the request names, and keeps the answer out of every cache", async () => {
    const adminSupabase = { marker: 'service' } as unknown as SupabaseClient;
    const getShowcaseViewerExclusionsForRoute = vi.fn(async (): Promise<ShowcaseViewerExclusionsRouteResult> => ({
      ok: true,
      body: { blockedCreatorIds: [CREATOR_ID], hiddenCreatorIds: [], hiddenPostIds: [] },
    }));

    const response = await postShowcaseViewerExclusionsRouteResponse({
      request: exclusionsRequest({
        viewerUserId: 'someone-else',
        items: [{ postId: POST_ID, creatorId: CREATOR_ID }, { postId: 'not-an-id', creatorId: CREATOR_ID }],
      }, 'exclusions-success-1'),
      dependencies: {
        createServiceClient: () => adminSupabase,
        createUserClient: () => createUserClient({ id: 'user-1' }),
        getShowcaseViewerExclusionsForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('exclusions-success-1');
    await expect(response.json()).resolves.toEqual({
      blockedCreatorIds: [CREATOR_ID],
      hiddenCreatorIds: [],
      hiddenPostIds: [],
    });
    expect(getShowcaseViewerExclusionsForRoute).toHaveBeenCalledWith({
      adminSupabase,
      items: [{ postId: POST_ID, creatorId: CREATOR_ID }],
      viewerUserId: 'user-1',
    });
  });

  it.each([
    ['no list of posts', {}],
    ['a body that is not JSON', 'not json'],
  ])('refuses %s', async (_label, body) => {
    const getShowcaseViewerExclusionsForRoute = vi.fn();

    const response = await postShowcaseViewerExclusionsRouteResponse({
      request: exclusionsRequest(body),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: () => createUserClient({ id: 'user-1' }),
        getShowcaseViewerExclusionsForRoute,
      },
    });

    expect(response.status).toBe(400);
    expect(getShowcaseViewerExclusionsForRoute).not.toHaveBeenCalled();
  });

  // The page keeps what it drew when this fails, so a failure has to read as one.
  it('answers 500, and logs, when a read fails', async () => {
    const logError = vi.fn();

    const response = await postShowcaseViewerExclusionsRouteResponse({
      request: exclusionsRequest({ items: [{ postId: POST_ID, creatorId: CREATOR_ID }] }),
      dependencies: {
        createServiceClient: () => ({}) as unknown as SupabaseClient,
        createUserClient: () => createUserClient({ id: 'user-1' }),
        getShowcaseViewerExclusionsForRoute: vi.fn(async () => {
          throw new Error('user_blocks unavailable');
        }),
        logError,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Failed to check the viewer\'s feed exclusions' });
    expect(logError).toHaveBeenCalledWith('Showcase viewer exclusions error:', expect.any(Error));
  });
});
