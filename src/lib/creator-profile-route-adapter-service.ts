import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import {
  createApiResponseHeaders,
  createPrivateNoStoreApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  getCreatorProfilePageData,
  loadCreatorBlockRelationship,
  type CreatorProfilePage,
} from '@/lib/creator-profile';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import {
  BackendRateLimitError,
  CREATOR_PROFILE_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getCreatorFollowStateForRoute } from '@/lib/profile-follow-service';
import { attachViewerStateToFeed } from '@/lib/showcase-feed';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { parsePositiveInt } from '@/lib/showcase';

type CreatorProfileRouteContext = {
  params: Promise<{ username: string }>;
};

type CreatorProfileRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  getCreatorFollowStateForRoute?: typeof getCreatorFollowStateForRoute;
  loadCreatorBlockRelationship?: typeof loadCreatorBlockRelationship;
  getCreatorProfilePageData?: typeof getCreatorProfilePageData;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: CreatorProfileRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    getCreatorFollowStateForRoute: dependencies?.getCreatorFollowStateForRoute ?? getCreatorFollowStateForRoute,
    loadCreatorBlockRelationship: dependencies?.loadCreatorBlockRelationship ?? loadCreatorBlockRelationship,
    getCreatorProfilePageData: dependencies?.getCreatorProfilePageData ?? getCreatorProfilePageData,
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function getViewerUserId(
  request: Request,
  hasAuthorizationHeader: boolean,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!hasAuthorizationHeader) return null;

  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
  } = await getVerifiedAuthUserResult(supabase);

  return user?.id ?? null;
}

async function getViewerState({
  creatorId,
  dependencies,
  viewerUserId,
}: {
  creatorId: string;
  dependencies: ReturnType<typeof resolveDependencies>;
  viewerUserId: string | null;
}) {
  if (!viewerUserId) {
    return { isOwner: false, isFollowing: false, blockedByViewer: false };
  }

  if (viewerUserId === creatorId) {
    return { isOwner: true, isFollowing: false, blockedByViewer: false };
  }

  const result = await dependencies.getCreatorFollowStateForRoute({
    adminSupabase: dependencies.createServiceClient,
    followerId: viewerUserId,
    followingId: creatorId,
  });

  return {
    isOwner: false,
    isFollowing: result.ok ? result.body.following : false,
    blockedByViewer: false,
  };
}

/**
 * Saved state and bought-recipe remix access, read the way the feed reads
 * them, for whichever page this is: the clients take both from each item, so
 * a page without them showed saved posts as unsaved.
 */
async function attachCreatorPageViewerState(
  data: CreatorProfilePage,
  viewerUserId: string | null,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!viewerUserId) return data.items;

  const feed = await attachViewerStateToFeed(
    { items: data.items, pageInfo: data.pageInfo },
    viewerUserId,
    dependencies.createServiceClient(),
  );
  return feed.items;
}

async function handleCreatorProfileGET(
  request: Request,
  context: CreatorProfileRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const { username } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    const requestedLimit = parsePositiveInt(searchParams.get('limit'), 24);
    const requestedOffset = parsePositiveInt(searchParams.get('offset'), 0);
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const viewerUserId = await getViewerUserId(request, hasAuthorizationHeader, dependencies);

    // This read joins a profile to a paged slice of its posts, so an anonymous
    // walk of every creator is not cheap. Keyed like the other public reads.
    try {
      await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
        ...CREATOR_PROFILE_READ_RATE_LIMIT,
        key: viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      throw error;
    }

    const data = await dependencies.getCreatorProfilePageData(username, {
      limit: requestedLimit,
      offset: requestedOffset,
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    const cacheHeaders = createApiResponseHeaders(
      request,
      getViewerAwareApiCacheControl(hasAuthorizationHeader),
      { vary: ['Authorization', 'x-vercel-ip-country'] },
    );

    if (!data) {
      return NextResponse.json(
        { error: 'Creator not found.' },
        { status: 404, headers: cacheHeaders },
      );
    }

    const blockRelationship = viewerUserId
      ? await dependencies.loadCreatorBlockRelationship({
          adminSupabase: dependencies.createServiceClient(),
          creatorId: data.profile.id,
          viewerUserId,
        })
      : null;

    // Someone the creator blocked gets the answer an unknown handle gets, even
    // when they blocked the creator too.
    if (blockRelationship?.creatorBlockedViewer) {
      return NextResponse.json(
        { error: 'Creator not found.' },
        { status: 404, headers: cacheHeaders },
      );
    }

    // The viewer blocked this creator: the header comes back so the page can
    // say so and offer Unblock, and none of the creator's posts do.
    if (blockRelationship?.viewerBlockedCreator) {
      return NextResponse.json({
        profile: data.profile,
        ...(data.stats ? { stats: data.stats } : {}),
        items: [],
        pageInfo: { ...data.pageInfo, hasMore: false, nextOffset: null, nextLimit: null },
        viewer: { isOwner: false, isFollowing: false, blockedByViewer: true },
      }, { headers: cacheHeaders });
    }

    const [items, viewer] = await Promise.all([
      attachCreatorPageViewerState(data, viewerUserId, dependencies),
      getViewerState({
        creatorId: data.profile.id,
        dependencies,
        viewerUserId,
      }),
    ]);

    return NextResponse.json({ ...data, items, viewer }, { headers: cacheHeaders });
  } catch (error) {
    dependencies.logError('Creator profile route error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch creator profile.' },
      { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
    );
  }
}

export async function getCreatorProfileRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: CreatorProfileRouteContext;
  dependencies?: CreatorProfileRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    handleCreatorProfileGET(request, context, resolvedDependencies)
  ));
}
