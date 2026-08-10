import 'server-only';
import { logBackendError } from '@/lib/backend-logger';
import { randomUUID } from 'node:crypto';

import { after, NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  WORKFLOW_RUN_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { authenticateRequest, createServiceClient } from '@/lib/server-helpers';
import {
  startWorkflowRunForRoute,
  type WorkflowRunRouteResult,
  type WorkflowRunRouteSupabaseClient,
} from '@/lib/workflow-run-route-service';
import {
  approveWorkflowRunStep,
  getWorkflowRunDetails,
  WorkflowRunApprovalError,
} from '@/lib/workflow-runner';
import { processWorkflowRunStepJobs } from '@/lib/workflow-run-jobs-processor';

type WorkflowRunScheduleWorker = (callback: () => Promise<void>) => void;
type WorkflowRunDetailsSupabaseClient = Parameters<typeof getWorkflowRunDetails>[0]['supabase'];

type WorkflowRunDetailsRouteContext = {
  params: Promise<{ id: string; runId: string }>;
};

type WorkflowRunApprovalRouteContext = {
  params: Promise<{ id: string; runId: string; stepId: string }>;
};

type WorkflowRunRouteDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  approveWorkflowRunStep?: typeof approveWorkflowRunStep;
  createServiceClient?: typeof createServiceClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getWorkflowRunDetails?: typeof getWorkflowRunDetails;
  processWorkflowRunStepJobs?: typeof processWorkflowRunStepJobs;
  scheduleWorker?: WorkflowRunScheduleWorker;
  startWorkflowRunForRoute?: typeof startWorkflowRunForRoute;
};

function resolveDependencies(dependencies: WorkflowRunRouteDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    approveWorkflowRunStep: dependencies?.approveWorkflowRunStep ?? approveWorkflowRunStep,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getWorkflowRunDetails: dependencies?.getWorkflowRunDetails ?? getWorkflowRunDetails,
    processWorkflowRunStepJobs:
      dependencies?.processWorkflowRunStepJobs ?? processWorkflowRunStepJobs,
    scheduleWorker: dependencies?.scheduleWorker ?? ((callback) => after(callback)),
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

function scheduleWorkflowFastPathWorker(dependencies: ReturnType<typeof resolveDependencies>) {
  dependencies.scheduleWorker(async () => {
    try {
      await dependencies.processWorkflowRunStepJobs({
        supabase: dependencies.createServiceClient(),
        lockedBy: `workflow-route-${randomUUID()}`,
        limit: 1,
        concurrency: 1,
      });
    } catch (error) {
      // The job is already durable. A failed fast-path drain is safe: the
      // dedicated cron will reclaim it using the same database lease.
      logBackendError('workflow_run_fast_path_worker_failed', { error });
    }
  });
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

  const result = await dependencies.startWorkflowRunForRoute({
    supabase: workflowRunSupabase,
    adminSupabase: dependencies.createServiceClient,
    userId: auth.userId,
    canvasId,
    body,
    idempotencyKeyHeader: request.headers.get('idempotency-key'),
  });

  if (result.ok && result.body.status === 'processing' && !result.body.reused) {
    scheduleWorkflowFastPathWorker(dependencies);
  }

  return createWorkflowRunResponse(result);
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
    // Load failures collapse to a fixed not-found response; the underlying
    // detail (which may include database messages) stays in the logs.
    logBackendError('workflow_run_details_load_failed', { error: error });
    return NextResponse.json({ error: 'Workflow run not found.' }, { status: 404 });
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

async function handleWorkflowRunApprovalPOST(
  request: Request,
  context: WorkflowRunApprovalRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof Response) return auth;

  try {
    await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
      ...WORKFLOW_RUN_RATE_LIMIT,
      key: auth.userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }
    return NextResponse.json({ error: 'Failed to check workflow run limits.' }, { status: 500 });
  }

  const { id, runId, stepId } = await context.params;
  try {
    const run = await dependencies.approveWorkflowRunStep({
      supabase: auth.supabase as unknown as WorkflowRunDetailsSupabaseClient,
      canvasId: id,
      runId,
      stepId,
    });
    if (run.status === 'processing') scheduleWorkflowFastPathWorker(dependencies);
    return NextResponse.json({ run });
  } catch (error) {
    if (error instanceof WorkflowRunApprovalError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logBackendError('workflow_approval_failed', { error: error });
    return NextResponse.json({ error: 'Failed to approve workflow checkpoint.' }, { status: 500 });
  }
}

export async function postWorkflowRunApprovalRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: WorkflowRunApprovalRouteContext;
  dependencies?: WorkflowRunRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowRunApprovalPOST(request, context, resolveDependencies(dependencies)),
    request,
  );
}
