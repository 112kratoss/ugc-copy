import 'server-only';

import { NextResponse } from 'next/server';

import { enforceWorkflowCanvasMutationRateLimit } from '@/app/api/workflow-canvases/workflowCanvasRateLimit';
import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { authenticateRequest } from '@/lib/server-helpers';
import {
  discardWorkflowAssistantProposalForRoute,
  type WorkflowAssistantProposalDiscardRouteResult,
} from '@/lib/workflow-assistant-proposal-discard-service';

type WorkflowAssistantProposalDiscardRouteContext = {
  params: Promise<{ id: string; proposalId: string }>;
};

type WorkflowAssistantProposalDiscardRouteDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  discardWorkflowAssistantProposalForRoute?: typeof discardWorkflowAssistantProposalForRoute;
  enforceWorkflowCanvasMutationRateLimit?: typeof enforceWorkflowCanvasMutationRateLimit;
};

function resolveDependencies(dependencies: WorkflowAssistantProposalDiscardRouteDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    discardWorkflowAssistantProposalForRoute:
      dependencies?.discardWorkflowAssistantProposalForRoute ?? discardWorkflowAssistantProposalForRoute,
    enforceWorkflowCanvasMutationRateLimit:
      dependencies?.enforceWorkflowCanvasMutationRateLimit ?? enforceWorkflowCanvasMutationRateLimit,
  };
}

function toJsonResponse(result: WorkflowAssistantProposalDiscardRouteResult) {
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleWorkflowAssistantProposalDiscardPOST(
  request: Request,
  context: WorkflowAssistantProposalDiscardRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id, proposalId } = await context.params;
  const { supabase, userId } = auth;
  const rateLimitResponse = await dependencies.enforceWorkflowCanvasMutationRateLimit(
    userId,
    'Failed to discard assistant proposal.',
  );
  if (rateLimitResponse) return rateLimitResponse;

  return toJsonResponse(await dependencies.discardWorkflowAssistantProposalForRoute({
    canvasId: id,
    proposalId,
    userId,
    supabase,
  }));
}

export async function postWorkflowAssistantProposalDiscardRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: WorkflowAssistantProposalDiscardRouteContext;
  dependencies?: WorkflowAssistantProposalDiscardRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowAssistantProposalDiscardPOST(request, context, resolveDependencies(dependencies)),
    request,
  );
}
