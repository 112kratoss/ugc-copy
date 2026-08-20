import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import {
  createApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_POST_DETAIL_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getShowcaseFeedItemById } from '@/lib/showcase-feed';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';

type ShowcasePostDetailRouteContext = {
  params: Promise<{ postId: string }>;
};

type ShowcasePostDetailRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  getShowcaseFeedItemById?: typeof getShowcaseFeedItemById;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: ShowcasePostDetailRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    getShowcaseFeedItemById: dependencies?.getShowcaseFeedItemById ?? getShowcaseFeedItemById,
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

async function handleShowcasePostDetailGET(
  request: Request,
  context: ShowcasePostDetailRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const { postId } = await context.params;
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const viewerUserId = await getViewerUserId(request, hasAuthorizationHeader, dependencies);

    // Anonymous callers key on a salted network hash, the same identity the
    // feed already derives, so a signed-out scraper cannot walk every post id
    // for free.
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

    const item = await dependencies.getShowcaseFeedItemById({
      postId,
      viewerUserId,
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    if (!item) {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, item }, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
  } catch (error) {
    dependencies.logError('Showcase post detail error:', error);
    return NextResponse.json({ error: 'Failed to fetch showcase post.' }, { status: 500 });
  }
}

export async function getShowcasePostDetailRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: ShowcasePostDetailRouteContext;
  dependencies?: ShowcasePostDetailRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    handleShowcasePostDetailGET(request, context, resolvedDependencies)
  ));
}
