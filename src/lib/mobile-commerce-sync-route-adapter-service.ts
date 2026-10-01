import 'server-only';

import { after, NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  syncMobileCommerceForRoute,
  type MobileCommerceSyncRouteResult,
} from '@/lib/mobile-commerce-sync-service';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RunAfterResponse = (task: () => Promise<unknown>) => void;

type MobileCommerceSyncRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  runAfterResponse?: RunAfterResponse;
  syncMobileCommerceForRoute?: typeof syncMobileCommerceForRoute;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: MobileCommerceSyncRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    runAfterResponse: dependencies?.runAfterResponse ?? ((task) => after(task)),
    syncMobileCommerceForRoute:
      dependencies?.syncMobileCommerceForRoute ?? syncMobileCommerceForRoute,
    withProviderFetchRequestId:
      dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

function toJsonResponse(result: MobileCommerceSyncRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleMobileCommerceSyncPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  return toJsonResponse(await dependencies.syncMobileCommerceForRoute({
    getAdminSupabase: dependencies.createServiceClient,
    readRequestBody: () => request.json(),
    // The app waits on this answer after every in-app purchase, so the pushes
    // go out behind it rather than in front.
    runAfterResponse: dependencies.runAfterResponse,
    userSupabase: dependencies.createUserClient(request),
  }));
}

export async function postMobileCommerceSyncRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobileCommerceSyncRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleMobileCommerceSyncPOST(request, resolvedDependencies),
      request,
    )
  ));
}
