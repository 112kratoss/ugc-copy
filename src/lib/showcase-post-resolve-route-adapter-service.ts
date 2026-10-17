import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { createApiResponseHeaders, getViewerAwareApiCacheControl } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_POST_DETAIL_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getPostReferenceForShowcaseId } from '@/lib/public-posts';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';

type ShowcasePostResolveRouteContext = {
  params: Promise<{ postId: string }>;
};

type ShowcasePostResolveRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  getPostReferenceForShowcaseId?: typeof getPostReferenceForShowcaseId;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: ShowcasePostResolveRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    getPostReferenceForShowcaseId: dependencies?.getPostReferenceForShowcaseId ?? getPostReferenceForShowcaseId,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

async function getViewerUserId(
  request: Request,
  hasAuthorizationHeader: boolean,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!hasAuthorizationHeader) return null;

  const {
    data: { user },
  } = await getVerifiedAuthUserResult(dependencies.createUserClient(request));
  return user?.id ?? null;
}

async function handleShowcasePostResolveGET(
  request: Request,
  context: ShowcasePostResolveRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const { postId } = await context.params;
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const viewerUserId = await getViewerUserId(request, hasAuthorizationHeader, dependencies);

    // The by-id read's own limit and key, so walking ids through this route
    // costs what walking them through the read does.
    try {
      await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
        ...SHOWCASE_POST_DETAIL_READ_RATE_LIMIT,
        key: viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      throw error;
    }

    const reference = await dependencies.getPostReferenceForShowcaseId(postId);
    if (!reference) {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, postId: reference.id }, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization'],
      }),
    });
  } catch (error) {
    dependencies.logError('Showcase post resolve error:', error);
    return NextResponse.json({ error: 'Failed to resolve showcase post.' }, { status: 500 });
  }
}

/**
 * Which live post an id names (product decision 15, 2026-10-17).
 *
 * Old share links name a generation, not a post. The web post page asks the
 * same resolver when no post has the id and redirects; the app reads posts by
 * id only, so it asks here when that read answers 404 and moves to the post it
 * is told. A post id answers with itself. Only a live post is found: public
 * (or an old unlisted one), not archived, and visible under moderation.
 */
export async function getShowcasePostResolveRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: ShowcasePostResolveRouteContext;
  dependencies?: ShowcasePostResolveRouteDependencies;
  request: Request;
}) {
  return handleShowcasePostResolveGET(request, context, resolveDependencies(dependencies));
}
