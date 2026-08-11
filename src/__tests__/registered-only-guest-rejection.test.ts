import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { postPostsRouteResponse } from '@/lib/posts-route-adapter-service';
import { postProfileFollowRouteResponse } from '@/lib/profile-follow-route-adapter-service';
import { postShowcasePublishRouteResponse } from '@/lib/showcase-publish-route-adapter-service';

/**
 * Guests must not reach the community and money surfaces.
 *
 * `route-identity-policy.ts` declares which routes are registered-only, and
 * `route-identity-policy.test.ts` makes every route declare something. Neither
 * proves the declaration is enforced. These do, against the real adapters.
 *
 * The failure this guards is silent by construction: a guest holds an ordinary
 * valid JWT, so an adapter that still asks "is there a user?" admits them with
 * no error, no log, and no failing test — it just quietly starts letting
 * unregistered devices publish, comment, follow and buy.
 */
function guestClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        // Exactly what Supabase returns for signInAnonymously(): a real user
        // row, a valid session, and this one claim.
        data: { user: { id: 'guest-1', is_anonymous: true } },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;
}

describe('registered-only routes reject guests', () => {
  it('refuses to let a guest create a post', async () => {
    const createServiceClient = vi.fn();
    const createOwnerPostForRoute = vi.fn();
    const request = new Request('http://localhost/api/posts', {
      method: 'POST',
      body: new FormData(),
    });
    const formDataSpy = vi.spyOn(request, 'formData');

    const response = await postPostsRouteResponse({
      request,
      dependencies: {
        createOwnerPostForRoute,
        createServiceClient,
        createUserClient: () => guestClient(),
      },
    });

    expect(response.status).toBe(401);
    // Rejected before any work: no service client, no body parsing.
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it('refuses to let a guest publish to the showcase', async () => {
    const createServiceClient = vi.fn();
    const publishGenerationToShowcaseForRoute = vi.fn();

    const response = await postShowcasePublishRouteResponse({
      request: new Request('http://localhost/api/showcase/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationId: 'generation-1' }),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => guestClient(),
        publishGenerationToShowcaseForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
  });

  it('refuses to let a guest follow a creator', async () => {
    const createServiceClient = vi.fn();
    const updateCreatorFollowForRoute = vi.fn();

    const response = await postProfileFollowRouteResponse({
      request: new Request('http://localhost/api/profile/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'someone' }),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => guestClient(),
        updateCreatorFollowForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(updateCreatorFollowForRoute).not.toHaveBeenCalled();
  });
});
