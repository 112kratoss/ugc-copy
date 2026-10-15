import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import {
  API_CACHE_CONTROL,
  createApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  normalizeMarketplaceResourceFilter,
  normalizeMarketplaceResourceKindFilter,
  normalizeMarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import { getMarketplaceResourceList } from '@/lib/post-resource-bundles-server';
import { MARKETPLACE_DEFAULT_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';
import {
  isValidMarketplaceSearchQuery,
  MARKETPLACE_SEARCH_MIN_LENGTH,
  normalizeMarketplaceSearchQuery,
} from '@/lib/marketplace-search-policy';
import { filterMarketplaceItemsForViewer } from '@/lib/marketplace-viewer-filter';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createUserClient } from '@/lib/server-helpers';
import { slugifySourceTool } from '@/lib/source-tools';

type MarketplaceResourceListRouteDependencies = {
  createUserClient?: typeof createUserClient;
  filterMarketplaceItemsForViewer?: typeof filterMarketplaceItemsForViewer;
  getMarketplaceResourceList?: typeof getMarketplaceResourceList;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

export const MAX_MARKETPLACE_RESOURCE_OFFSET = 960;

function resolveDependencies(dependencies: MarketplaceResourceListRouteDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    filterMarketplaceItemsForViewer:
      dependencies?.filterMarketplaceItemsForViewer ?? filterMarketplaceItemsForViewer,
    getMarketplaceResourceList: dependencies?.getMarketplaceResourceList ?? getMarketplaceResourceList,
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

function normalizeNumber(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
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

async function handleMarketplaceResourceListGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const offset = normalizeNumber(searchParams.get('offset'), 0);
    if (offset > MAX_MARKETPLACE_RESOURCE_OFFSET) {
      return NextResponse.json(
        { error: `offset must be at most ${MAX_MARKETPLACE_RESOURCE_OFFSET}.` },
        {
          status: 400,
          headers: createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore),
        },
      );
    }

    const query = normalizeMarketplaceSearchQuery(searchParams.get('q'));
    if (!isValidMarketplaceSearchQuery(query)) {
      return NextResponse.json(
        { error: `q must be empty or at least ${MARKETPLACE_SEARCH_MIN_LENGTH} characters.` },
        {
          status: 400,
          headers: createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore),
        },
      );
    }

    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const [cachedPage, viewerUserId] = await Promise.all([
      dependencies.getMarketplaceResourceList({
        filter: normalizeMarketplaceResourceFilter(searchParams.get('access')),
        resource: normalizeMarketplaceResourceKindFilter(searchParams.get('resource')),
        tool: slugifySourceTool(searchParams.get('tool') ?? undefined),
        q: query,
        sort: normalizeMarketplaceResourceSort(searchParams.get('sort')),
        offset,
        limit: Math.min(48, Math.max(1, normalizeNumber(
          searchParams.get('limit'),
          MARKETPLACE_DEFAULT_PAGE_SIZE,
        ))),
        countryCode: request.headers.get('x-vercel-ip-country'),
      }),
      getViewerUserId(request, hasAuthorizationHeader, dependencies),
    ]);
    // pageInfo still counts the unfiltered list, so the next page starts where
    // this one ended even when blocked creators' recipes were taken out of it.
    const page = {
      ...cachedPage,
      items: await dependencies.filterMarketplaceItemsForViewer(cachedPage.items, viewerUserId),
    };

    const boundedPage = page.pageInfo.nextOffset !== null
      && page.pageInfo.nextOffset > MAX_MARKETPLACE_RESOURCE_OFFSET
      ? {
          ...page,
          pageInfo: {
            ...page.pageInfo,
            hasMore: false,
            nextOffset: null,
          },
        }
      : page;

    // A signed-in page is filtered for its viewer, so it must never be served
    // from the shared edge copy, nor stored there.
    return NextResponse.json(boundedPage, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
  } catch (error) {
    dependencies.logError('Failed to load marketplace resources:', error);
    return NextResponse.json({ error: 'Failed to load marketplace unlocks.' }, { status: 500 });
  }
}

export async function getMarketplaceResourceListRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MarketplaceResourceListRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    handleMarketplaceResourceListGET(request, resolvedDependencies)
  ));
}
