import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  mergeGuestAccountForRoute,
  prepareAccountMergeTicketForRoute,
  type AccountMergeRouteResult,
} from '@/lib/account-merge-service';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type AccountMergeRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  mergeGuestAccountForRoute?: typeof mergeGuestAccountForRoute;
  prepareAccountMergeTicketForRoute?: typeof prepareAccountMergeTicketForRoute;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: AccountMergeRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    mergeGuestAccountForRoute:
      dependencies?.mergeGuestAccountForRoute ?? mergeGuestAccountForRoute,
    prepareAccountMergeTicketForRoute:
      dependencies?.prepareAccountMergeTicketForRoute ?? prepareAccountMergeTicketForRoute,
    withProviderFetchRequestId:
      dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

function toJsonResponse(result: AccountMergeRouteResult<unknown>) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

export async function postAccountMergePrepareRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: AccountMergeRouteDependencies;
  request: Request;
}) {
  const resolved = resolveDependencies(dependencies);
  return resolved.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      toJsonResponse(await resolved.prepareAccountMergeTicketForRoute({
        getAdminSupabase: resolved.createServiceClient,
        userSupabase: resolved.createUserClient(request),
      })),
      request,
    )
  ));
}

export async function postAccountMergeRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: AccountMergeRouteDependencies;
  request: Request;
}) {
  const resolved = resolveDependencies(dependencies);
  return resolved.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      toJsonResponse(await resolved.mergeGuestAccountForRoute({
        getAdminSupabase: resolved.createServiceClient,
        readRequestBody: () => request.json().catch(() => ({})),
        userSupabase: resolved.createUserClient(request),
      })),
      request,
    )
  ));
}
