import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import {
  withProviderFetchRequestId,
} from '@/lib/provider-fetch';
import { authenticateRequest, createServiceClient } from '@/lib/server-helpers';
import {
  createWorkflowAssistantMessageForRoute,
  type WorkflowAssistantMessageRouteResult,
} from '@/lib/workflow-assistant-message-service';

type WorkflowAssistantMessageRouteContext = {
  params: Promise<{ id: string }>;
};

type WorkflowAssistantMessageRouteDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  createServiceClient?: typeof createServiceClient;
  createWorkflowAssistantMessageForRoute?: typeof createWorkflowAssistantMessageForRoute;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: WorkflowAssistantMessageRouteDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createWorkflowAssistantMessageForRoute:
      dependencies?.createWorkflowAssistantMessageForRoute ?? createWorkflowAssistantMessageForRoute,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function toJsonResponse(result: WorkflowAssistantMessageRouteResult) {
  if (!result.ok) {
    return NextResponse.json(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  return NextResponse.json(result.body);
}

async function handleWorkflowAssistantMessagePOST(
  request: Request,
  context: WorkflowAssistantMessageRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const { supabase, userId } = auth;

  return toJsonResponse(await dependencies.createWorkflowAssistantMessageForRoute({
    adminSupabase: dependencies.createServiceClient(),
    body: await readJsonBody(request),
    canvasId: id,
    request,
    supabase,
    userId,
  }));
}

export async function postWorkflowAssistantMessageRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: WorkflowAssistantMessageRouteContext;
  dependencies?: WorkflowAssistantMessageRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleWorkflowAssistantMessagePOST(request, context, resolvedDependencies),
      request,
    )
  ));
}
