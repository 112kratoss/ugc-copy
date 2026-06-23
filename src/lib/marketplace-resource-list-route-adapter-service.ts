import 'server-only';

import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import {
  normalizeMarketplaceResourceFilter,
  normalizeMarketplaceResourceKindFilter,
  normalizeMarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import { getMarketplaceResourceList } from '@/lib/post-resource-bundles-server';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { slugifySourceTool } from '@/lib/source-tools';

type MarketplaceResourceListRouteDependencies = {
  getMarketplaceResourceList?: typeof getMarketplaceResourceList;
  logError?: typeof console.error;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: MarketplaceResourceListRouteDependencies | undefined) {
  return {
    getMarketplaceResourceList: dependencies?.getMarketplaceResourceList ?? getMarketplaceResourceList,
    logError: dependencies?.logError ?? console.error,
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
    const page = await dependencies.getMarketplaceResourceList({
      filter: normalizeMarketplaceResourceFilter(searchParams.get('access')),
      resource: normalizeMarketplaceResourceKindFilter(searchParams.get('resource')),
      tool: slugifySourceTool(searchParams.get('tool') ?? undefined),
      q: (searchParams.get('q') ?? '').trim().slice(0, 80),
      sort: normalizeMarketplaceResourceSort(searchParams.get('sort')),
      offset: normalizeNumber(searchParams.get('offset'), 0),
      limit: Math.min(48, Math.max(1, normalizeNumber(searchParams.get('limit'), 24))),
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    return NextResponse.json(page, {
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
