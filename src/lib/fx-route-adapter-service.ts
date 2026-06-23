import 'server-only';

import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { loadFxRatesForRoute } from '@/lib/fx-rates-service';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';

type FxRouteDependencies = {
  loadFxRatesForRoute?: typeof loadFxRatesForRoute;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: FxRouteDependencies | undefined) {
  return {
    loadFxRatesForRoute: dependencies?.loadFxRatesForRoute ?? loadFxRatesForRoute,
    withProviderFetchRequestId:
      dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function createFxRouteResponse({
  dependencies,
  request,
}: {
  dependencies: Required<FxRouteDependencies>;
  request: Request;
}) {
  const result = await dependencies.loadFxRatesForRoute();
  if (!result.ok) {
    return NextResponse.json(result.body, {
      status: result.status,
      headers: createApiResponseHeaders(request, API_CACHE_CONTROL.noStore),
    });
  }

  return NextResponse.json(result.body, {
    headers: createApiResponseHeaders(request, API_CACHE_CONTROL.publicHourlyEdge),
  });
}

export async function getFxRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: FxRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), () =>
    createFxRouteResponse({ dependencies: resolvedDependencies, request })
  );
}
