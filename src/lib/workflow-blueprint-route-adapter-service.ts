import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  planWorkflowBlueprintForRoute,
  type WorkflowBlueprintRouteResult,
} from '@/lib/workflow-blueprint-service';

type WorkflowBlueprintRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  kieApiKey?: string;
  planWorkflowBlueprintForRoute?: typeof planWorkflowBlueprintForRoute;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: WorkflowBlueprintRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    kieApiKey: dependencies?.kieApiKey ?? process.env.KIE_AI_API_KEY,
    planWorkflowBlueprintForRoute: dependencies?.planWorkflowBlueprintForRoute ?? planWorkflowBlueprintForRoute,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

function toJsonResponse(result: WorkflowBlueprintRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleWorkflowBlueprintPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  return toJsonResponse(await dependencies.planWorkflowBlueprintForRoute({
    request,
    createAdminSupabase: dependencies.createServiceClient,
    createUserSupabase: () => dependencies.createUserClient(request),
    kieApiKey: dependencies.kieApiKey,
    readRequestBody: () => request.json(),
  }));
}

export async function postWorkflowBlueprintRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: WorkflowBlueprintRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);

  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleWorkflowBlueprintPOST(request, resolvedDependencies),
      request,
    )
  ));
}
