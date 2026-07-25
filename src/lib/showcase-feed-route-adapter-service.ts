import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import {
  applyPrivateNoStoreApiResponseHeaders,
  createApiResponseHeaders,
  createPrivateNoStoreApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_FOR_YOU_FEED_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  FEED_ANONYMOUS_COOKIE_MAX_AGE_SECONDS,
  FEED_ANONYMOUS_COOKIE_NAME,
  getFeedNetworkKeyHash,
  resolveFeedAnonymousIdentity,
} from '@/lib/showcase-feed-identity';
import {
  SHOWCASE_PAGE_SIZE,
  normalizeShowcaseCategory,
  normalizeShowcaseOffset,
  normalizeShowcaseResourceFilter,
  normalizeShowcaseSort,
  normalizeShowcaseUnlockFilter,
  parsePositiveInt,
  sanitizeShowcaseFeedPage,
} from '@/lib/showcase';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';

type ShowcaseFeedRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  resolveFeedAnonymousIdentity?: typeof resolveFeedAnonymousIdentity;
  getShowcaseFeedPage?: typeof getShowcaseFeedPage;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: ShowcaseFeedRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    resolveFeedAnonymousIdentity: dependencies?.resolveFeedAnonymousIdentity ?? resolveFeedAnonymousIdentity,
    getShowcaseFeedPage: dependencies?.getShowcaseFeedPage ?? getShowcaseFeedPage,
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function getViewerUserId(
  request: Request,
  hasAuthorizationHeader: boolean,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!hasAuthorizationHeader) {
    return { ok: true as const, viewerUserId: null };
  }

  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user?.id) return { ok: false as const };
    return { ok: true as const, viewerUserId: user.id };
  } catch {
    return { ok: false as const };
  }
}

async function handleShowcaseFeedGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const limit = Math.min(parsePositiveInt(searchParams.get('limit'), SHOWCASE_PAGE_SIZE), 24);
    const tool = searchParams.get('tool');
    const cursor = searchParams.get('cursor');
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const actor = await getViewerUserId(request, hasAuthorizationHeader, dependencies);
    if (!actor.ok) {
      return NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }
    const viewerUserId = actor.viewerUserId;
    const sort = normalizeShowcaseSort(searchParams.get('sort'));
    const anonymousIdentity = viewerUserId || sort !== 'for-you'
      ? null
      : dependencies.resolveFeedAnonymousIdentity(request);
    const anonymousKeyHash = anonymousIdentity?.anonymousKeyHash ?? null;

    if (sort === 'for-you') {
      const serviceClient = dependencies.createServiceClient();
      try {
        await dependencies.enforceBackendRateLimit(serviceClient, {
          ...SHOWCASE_FOR_YOU_FEED_READ_RATE_LIMIT,
          key: viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
        });
      } catch (error) {
        if (error instanceof BackendRateLimitError) {
          return applyPrivateNoStoreApiResponseHeaders(createBackendRateLimitResponse(error), request);
        }
        dependencies.logError('Showcase For You feed rate limit failed:', error);
        return NextResponse.json(
          { error: 'Failed to check feed request limits.' },
          { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
        );
      }
    }

    const feed = await dependencies.getShowcaseFeedPage({
      category: normalizeShowcaseCategory(searchParams.get('category')),
      sort,
      offset: cursor ? 0 : normalizeShowcaseOffset(searchParams.get('offset'), searchParams.get('page'), limit),
      limit,
      viewerUserId,
      anonymousKeyHash,
      cursor,
      requestId: getApiRequestId(request),
      tool: tool && tool !== 'all' ? tool : null,
      unlock: normalizeShowcaseUnlockFilter(searchParams.get('unlock')),
      resource: normalizeShowcaseResourceFilter(searchParams.get('resource')),
      countryCode: request.headers.get('x-vercel-ip-country'),
      // The cached feed contains viewer-neutral data. Saved/purchased state is
      // attached after the cache read, so authenticated readers can safely
      // share the same base page instead of rebuilding it per request.
      bypassCache: sort === 'for-you' || Boolean(cursor),
    });
    const cacheControl = getViewerAwareApiCacheControl(hasAuthorizationHeader || sort === 'for-you');

    const response = NextResponse.json(sanitizeShowcaseFeedPage(feed), {
      headers: createApiResponseHeaders(request, cacheControl, {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
    if (anonymousIdentity?.cookieValueToSet) {
      response.cookies.set({
        name: FEED_ANONYMOUS_COOKIE_NAME,
        value: anonymousIdentity.cookieValueToSet,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: FEED_ANONYMOUS_COOKIE_MAX_AGE_SECONDS,
      });
    }
    return response;
  } catch (error) {
    dependencies.logError('Showcase feed error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch showcase feed' },
      { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
    );
  }
}

export async function getShowcaseFeedRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseFeedRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    handleShowcaseFeedGET(request, resolvedDependencies)
  ));
}
