import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
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
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { slugifySourceTool } from '@/lib/source-tools';

type MarketplaceResourceListRouteDependencies = {
  getMarketplaceResourceList?: typeof getMarketplaceResourceList;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

export const MAX_MARKETPLACE_RESOURCE_OFFSET = 960;

function resolveDependencies(dependencies: MarketplaceResourceListRouteDependencies | undefined) {
  return {
    getMarketplaceResourceList: dependencies?.getMarketplaceResourceList ?? getMarketplaceResourceList,
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

function normalizeNumber(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
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

    const page = await dependencies.getMarketplaceResourceList({
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
    });

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

    return NextResponse.json(boundedPage, {
      headers: createApiResponseHeaders(request, API_CACHE_CONTROL.publicShortEdge, {
        vary: ['x-vercel-ip-country'],
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
