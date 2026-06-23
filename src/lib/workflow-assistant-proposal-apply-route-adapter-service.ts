import 'server-only';

import { NextResponse } from 'next/server';

import { PATCH as patchWorkflowCanvas } from '@/app/api/workflow-canvases/[id]/route';
import { enforceWorkflowCanvasMutationRateLimit } from '@/app/api/workflow-canvases/workflowCanvasRateLimit';
import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { authenticateRequest } from '@/lib/server-helpers';
import {
  applyWorkflowAssistantProposalForRoute,
  type WorkflowAssistantProposalApplyRouteResult,
} from '@/lib/workflow-assistant-proposal-apply-service';

type WorkflowAssistantProposalApplyRouteContext = {
  params: Promise<{ id: string; proposalId: string }>;
};

type WorkflowAssistantProposalApplyRouteDependencies = {
  applyWorkflowAssistantProposalForRoute?: typeof applyWorkflowAssistantProposalForRoute;
  authenticateRequest?: typeof authenticateRequest;
  enforceWorkflowCanvasMutationRateLimit?: typeof enforceWorkflowCanvasMutationRateLimit;
  patchWorkflowCanvas?: typeof patchWorkflowCanvas;
};

function resolveDependencies(dependencies: WorkflowAssistantProposalApplyRouteDependencies | undefined) {
  return {
    applyWorkflowAssistantProposalForRoute:
      dependencies?.applyWorkflowAssistantProposalForRoute ?? applyWorkflowAssistantProposalForRoute,
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    enforceWorkflowCanvasMutationRateLimit:
      dependencies?.enforceWorkflowCanvasMutationRateLimit ?? enforceWorkflowCanvasMutationRateLimit,
    patchWorkflowCanvas: dependencies?.patchWorkflowCanvas ?? patchWorkflowCanvas,
  };
}

function toJsonResponse(result: WorkflowAssistantProposalApplyRouteResult) {
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleWorkflowAssistantProposalApplyPOST(
  request: Request,
  context: WorkflowAssistantProposalApplyRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id, proposalId } = await context.params;
  const { supabase, userId } = auth;
  const rateLimitResponse = await dependencies.enforceWorkflowCanvasMutationRateLimit(
    userId,
    'Failed to apply assistant proposal.',
  );
  if (rateLimitResponse) return rateLimitResponse;

  return toJsonResponse(await dependencies.applyWorkflowAssistantProposalForRoute({
    canvasId: id,
    proposalId,
    userId,
    supabase,
    applyCanvasPatch: async ({ graph, baseRevision }) => {
      const patchResponse = await dependencies.patchWorkflowCanvas(
        new Request(`http://localhost/api/workflow-canvases/${id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: request.headers.get('Authorization') || '',
          },
          body: JSON.stringify({
            graph,
            baseRevision,
          }),
        }) as never,
        { params: Promise.resolve({ id }) },
        { skipRateLimit: true },
      );

      return {
        ok: patchResponse.ok,
        status: patchResponse.status,
        body: await patchResponse.json().catch(() => ({})),
      };
    },
  }));
}

export async function postWorkflowAssistantProposalApplyRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: WorkflowAssistantProposalApplyRouteContext;
  dependencies?: WorkflowAssistantProposalApplyRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowAssistantProposalApplyPOST(request, context, resolveDependencies(dependencies)),
    request,
  );
}
