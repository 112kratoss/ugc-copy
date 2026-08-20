import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
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
  SHOWCASE_FEED_READ_RATE_LIMIT,
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
    } = await getVerifiedAuthUserResult(supabase);
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
    const timingEnabled = process.env.SCALING_CERTIFICATION_TIMINGS === '1';
    const phaseTimings = new Map<string, number>();
    const recordPhase = (phase: string, durationMs: number) => {
      if (!timingEnabled) return;
      phaseTimings.set(phase, (phaseTimings.get(phase) ?? 0) + Math.max(0, durationMs));
    };
    const searchParams = new URL(request.url).searchParams;
    const limit = Math.min(parsePositiveInt(searchParams.get('limit'), SHOWCASE_PAGE_SIZE), 24);
    const tool = searchParams.get('tool');
    const cursor = searchParams.get('cursor');
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const authStartedAt = performance.now();
    const actor = await getViewerUserId(request, hasAuthorizationHeader, dependencies);
    recordPhase('auth', performance.now() - authStartedAt);
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

    // Every sort is limited, not just for-you. The others were left open on the
    // reasoning that they are cheap cached reads, but `top-sales` scans every
    // public post per call, and an unthrottled expensive read is exactly what
    // an abusive client will find. The non-personalized ceiling is deliberately
    // four times the for-you one: it is there to stop a script, not to shape
    // browsing.
    {
      const limiterStartedAt = performance.now();
      const serviceClient = dependencies.createServiceClient();
      const readRateLimit = sort === 'for-you'
        ? SHOWCASE_FOR_YOU_FEED_READ_RATE_LIMIT
        : SHOWCASE_FEED_READ_RATE_LIMIT;
      try {
        await dependencies.enforceBackendRateLimit(serviceClient, {
          ...readRateLimit,
          key: viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
        });
        recordPhase('rate_limit', performance.now() - limiterStartedAt);
      } catch (error) {
        if (error instanceof BackendRateLimitError) {
          return applyPrivateNoStoreApiResponseHeaders(createBackendRateLimitResponse(error), request);
        }
        dependencies.logError('Showcase feed rate limit failed:', error);
        return NextResponse.json(
          { error: 'Failed to check feed request limits.' },
          { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
        );
      }
    }

    const feedStartedAt = performance.now();
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
      ...(timingEnabled ? { onPhaseTiming: recordPhase } : {}),
    });
    recordPhase('feed_total', performance.now() - feedStartedAt);
    const cacheControl = getViewerAwareApiCacheControl(hasAuthorizationHeader || sort === 'for-you');

    const serializationStartedAt = performance.now();
    const response = NextResponse.json(sanitizeShowcaseFeedPage(feed), {
      headers: createApiResponseHeaders(request, cacheControl, {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
    recordPhase('serialization', performance.now() - serializationStartedAt);
    if (timingEnabled) {
      const renderedTimings = [...phaseTimings]
        .map(([phase, durationMs]) => `${phase.replace(/_/g, '-')};dur=${durationMs.toFixed(2)}`)
        .join(', ');
      response.headers.set('Server-Timing', renderedTimings);
      // Vercel preview protection may consume or strip Server-Timing. Keep a
      // certification-only mirror so the external driver can still enforce
      // phase coverage; the entire block remains disabled outside the isolated
      // scaling environment.
      response.headers.set('x-scaling-certification-timing', renderedTimings);
    }
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
