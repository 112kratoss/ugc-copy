import 'server-only';

import { after, NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { authenticateRequest, createServiceClient } from '@/lib/server-helpers';
import {
  startWorkflowRunForRoute,
  type WorkflowRunRouteResult,
  type WorkflowRunRouteSupabaseClient,
} from '@/lib/workflow-run-route-service';
import { getWorkflowRunDetails } from '@/lib/workflow-runner';

type WorkflowRunScheduleMonitor = (callback: () => Promise<void>) => void;
type WorkflowRunDetailsSupabaseClient = Parameters<typeof getWorkflowRunDetails>[0]['supabase'];

type WorkflowRunDetailsRouteContext = {
  params: Promise<{ id: string; runId: string }>;
};

type WorkflowRunRouteDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  createServiceClient?: typeof createServiceClient;
  getWorkflowRunDetails?: typeof getWorkflowRunDetails;
  scheduleMonitor?: WorkflowRunScheduleMonitor;
  startWorkflowRunForRoute?: typeof startWorkflowRunForRoute;
};

function resolveDependencies(dependencies: WorkflowRunRouteDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    getWorkflowRunDetails: dependencies?.getWorkflowRunDetails ?? getWorkflowRunDetails,
    scheduleMonitor: dependencies?.scheduleMonitor ?? ((callback) => after(callback)),
    startWorkflowRunForRoute:
      dependencies?.startWorkflowRunForRoute ?? startWorkflowRunForRoute,
  };
}

function createWorkflowRunResponse(result: WorkflowRunRouteResult) {
  if (result.ok) {
    return NextResponse.json(result.body);
  }

  if (result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.status });
}

async function handleWorkflowRunPOST(
  request: Request,
  canvasId: string,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => ({}));
  const workflowRunSupabase = auth.supabase as unknown as WorkflowRunRouteSupabaseClient;

  return createWorkflowRunResponse(await dependencies.startWorkflowRunForRoute({
    supabase: workflowRunSupabase,
    adminSupabase: dependencies.createServiceClient,
    userId: auth.userId,
    canvasId,
    body,
    scheduleMonitor: dependencies.scheduleMonitor,
  }));
}

export async function postWorkflowRunRouteResponse({
  canvasId,
  dependencies,
  request,
}: {
  canvasId: string;
  dependencies?: WorkflowRunRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowRunPOST(request, canvasId, resolveDependencies(dependencies)),
    request,
  );
}

async function handleWorkflowRunDetailsGET(
  request: Request,
  context: WorkflowRunDetailsRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof Response) return auth;

  const { id, runId } = await context.params;
  const workflowRunSupabase = auth.supabase as unknown as WorkflowRunDetailsSupabaseClient;

  try {
    const run = await dependencies.getWorkflowRunDetails({
      supabase: workflowRunSupabase,
      canvasId: id,
      runId,
    });

    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch workflow run.';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

export async function getWorkflowRunDetailsRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: WorkflowRunDetailsRouteContext;
  dependencies?: WorkflowRunRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowRunDetailsGET(request, context, resolveDependencies(dependencies)),
    request,
  );
}
