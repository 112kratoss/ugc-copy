import 'server-only';

import { NextResponse } from 'next/server';

import {
  createApiResponseHeaders,
  createPrivateNoStoreApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createUserClient } from '@/lib/server-helpers';
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
  createUserClient?: typeof createUserClient;
  getShowcaseFeedPage?: typeof getShowcaseFeedPage;
  logError?: typeof console.error;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: ShowcaseFeedRouteDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getShowcaseFeedPage: dependencies?.getShowcaseFeedPage ?? getShowcaseFeedPage,
    logError: dependencies?.logError ?? console.error,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function getViewerUserId(
  request: Request,
  hasAuthorizationHeader: boolean,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!hasAuthorizationHeader) {
    return null;
  }

  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user?.id ?? null;
}

async function handleShowcaseFeedGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const limit = Math.min(parsePositiveInt(searchParams.get('limit'), SHOWCASE_PAGE_SIZE), 24);
    const tool = searchParams.get('tool');
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const viewerUserId = await getViewerUserId(request, hasAuthorizationHeader, dependencies);

    const feed = await dependencies.getShowcaseFeedPage({
      category: normalizeShowcaseCategory(searchParams.get('category')),
      sort: normalizeShowcaseSort(searchParams.get('sort')),
      offset: normalizeShowcaseOffset(searchParams.get('offset'), searchParams.get('page'), limit),
      limit,
      viewerUserId,
      tool: tool && tool !== 'all' ? tool : null,
      unlock: normalizeShowcaseUnlockFilter(searchParams.get('unlock')),
      resource: normalizeShowcaseResourceFilter(searchParams.get('resource')),
      countryCode: request.headers.get('x-vercel-ip-country'),
      bypassCache: hasAuthorizationHeader,
    });
    const cacheControl = getViewerAwareApiCacheControl(hasAuthorizationHeader);

    return NextResponse.json(sanitizeShowcaseFeedPage(feed), {
      headers: createApiResponseHeaders(request, cacheControl, {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
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
