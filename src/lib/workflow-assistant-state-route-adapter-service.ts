import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { authenticateRequest } from '@/lib/server-helpers';
import {
  getWorkflowAssistantStateForRoute,
  type WorkflowAssistantStateRouteResult,
} from '@/lib/workflow-assistant-state-service';

type WorkflowAssistantStateRouteContext = {
  params: Promise<{ id: string }>;
};

type WorkflowAssistantStateRouteDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  getWorkflowAssistantStateForRoute?: typeof getWorkflowAssistantStateForRoute;
};

function resolveDependencies(dependencies: WorkflowAssistantStateRouteDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    getWorkflowAssistantStateForRoute:
      dependencies?.getWorkflowAssistantStateForRoute ?? getWorkflowAssistantStateForRoute,
  };
}

function toJsonResponse(result: WorkflowAssistantStateRouteResult) {
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleWorkflowAssistantStateGET(
  request: Request,
  context: WorkflowAssistantStateRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const { supabase, userId } = auth;

  return toJsonResponse(await dependencies.getWorkflowAssistantStateForRoute({
    canvasId: id,
    supabase,
    userId,
  }));
}

export function createWorkflowAssistantStateRouteHandlers({
  dependencies,
}: {
  dependencies?: WorkflowAssistantStateRouteDependencies;
} = {}) {
  return {
    async GET(request: Request, context: WorkflowAssistantStateRouteContext) {
      return applyPrivateNoStoreApiResponseHeaders(
        await handleWorkflowAssistantStateGET(
          request,
          context,
          resolveDependencies(dependencies),
        ),
        request,
      );
    },
  };
}
