import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  WORKFLOW_RUN_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { normalizeWorkflowGraph, type WorkflowCanvasGraph } from '@/lib/workflow-canvas';
import {
  executeWorkflowRun,
  monitorWorkflowRun,
  type WorkflowRunExecutionResult,
} from '@/lib/workflow-runner';

type WorkflowCanvasRunMode = 'node' | 'branch';

export type WorkflowRunRouteSupabaseClient = {
  from: (table: 'workflow_canvases') => {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          single: () => PromiseLike<{
            data: { id: string; graph: Partial<WorkflowCanvasGraph> } | null;
            error: { message?: string } | Error | null;
          }>;
        };
      };
    };
  };
};

type WorkflowRunRateLimitClient = Parameters<typeof enforceBackendRateLimit>[0];
type WorkflowRunRateLimitInput = WorkflowRunRateLimitClient | (() => WorkflowRunRateLimitClient);

type ExecuteWorkflowRunForRoute = (params: {
  supabase: WorkflowRunRouteSupabaseClient;
  userId: string;
  canvasId: string;
  graph: WorkflowCanvasGraph;
  startNodeId: string;
  mode: WorkflowCanvasRunMode;
  catalogRevision?: string | null;
}) => Promise<WorkflowRunExecutionResult>;

type MonitorWorkflowRunForRoute = (params: {
  canvasId: string;
  runId: string;
}) => Promise<unknown>;

type ScheduleWorkflowMonitor = (callback: () => Promise<void>) => void;

export type WorkflowRunRouteResult =
  | {
      ok: true;
      body: WorkflowRunExecutionResult;
    }
  | {
      ok: false;
      status: 400 | 404 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type StartWorkflowRunForRouteInput = {
  supabase: WorkflowRunRouteSupabaseClient;
  adminSupabase: WorkflowRunRateLimitInput;
  userId: string;
  canvasId: string;
  body: unknown;
  executeRun?: ExecuteWorkflowRunForRoute;
  monitorRun?: MonitorWorkflowRunForRoute;
  scheduleMonitor?: ScheduleWorkflowMonitor;
};

const defaultExecuteWorkflowRunForRoute: ExecuteWorkflowRunForRoute = async (params) =>
  executeWorkflowRun(params as unknown as Parameters<typeof executeWorkflowRun>[0]);

const defaultMonitorWorkflowRunForRoute: MonitorWorkflowRunForRoute = async (params) =>
  monitorWorkflowRun(params);

function resolveAdminClient(adminSupabase: WorkflowRunRateLimitInput) {
  return typeof adminSupabase === 'function' ? adminSupabase() : adminSupabase;
}

function readRunRequest(body: unknown): {
  startNodeId: string | null;
  mode: WorkflowCanvasRunMode;
  catalogRevision: string | null;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { startNodeId: null, mode: 'branch', catalogRevision: null };
  }

  const record = body as Record<string, unknown>;
  return {
    startNodeId: typeof record.startNodeId === 'string' && record.startNodeId.trim()
      ? record.startNodeId.trim()
      : null,
    mode: record.mode === 'node' ? 'node' : 'branch',
    catalogRevision: typeof record.catalogRevision === 'string' && record.catalogRevision.trim()
      ? record.catalogRevision.trim()
      : null,
  };
}

function createRateLimitResult(error: BackendRateLimitError): WorkflowRunRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

async function loadOwnedCanvas({
  supabase,
  userId,
  canvasId,
}: {
  supabase: WorkflowRunRouteSupabaseClient;
  userId: string;
  canvasId: string;
}) {
  return supabase
    .from('workflow_canvases')
    .select('id, graph')
    .eq('id', canvasId)
    .eq('user_id', userId)
    .single();
}

export async function startWorkflowRunForRoute({
  supabase,
  adminSupabase,
  userId,
  canvasId,
  body,
  executeRun = defaultExecuteWorkflowRunForRoute,
  monitorRun = defaultMonitorWorkflowRunForRoute,
  scheduleMonitor,
}: StartWorkflowRunForRouteInput): Promise<WorkflowRunRouteResult> {
  const request = readRunRequest(body);
  if (!request.startNodeId) {
    return {
      ok: false,
      status: 400,
      body: { error: 'A start node is required.' },
    };
  }

  try {
    await enforceBackendRateLimit(resolveAdminClient(adminSupabase), {
      ...WORKFLOW_RUN_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('workflow_run_rate_limit_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check workflow run limits.' } };
  }

  const { data: canvas, error } = await loadOwnedCanvas({ supabase, userId, canvasId });
  if (error || !canvas) {
    return { ok: false, status: 404, body: { error: 'Workflow canvas not found.' } };
  }

  try {
    const result = await executeRun({
      supabase,
      userId,
      canvasId: canvas.id,
      graph: normalizeWorkflowGraph(canvas.graph),
      startNodeId: request.startNodeId,
      mode: request.mode,
      catalogRevision: request.catalogRevision,
    });

    if (result.status === 'processing' && scheduleMonitor) {
      scheduleMonitor(async () => {
        try {
          await monitorRun({
            canvasId: canvas.id,
            runId: result.runId,
          });
        } catch (monitorError) {
          logBackendError('workflow_run_monitor_failed', { error: monitorError });
        }
      });
    }

    return { ok: true, body: result };
  } catch (error) {
    // Unexpected runner failures keep their detail in the backend logs only;
    // node-level validation problems surface through per-step error states.
    logBackendError('workflow_canvas_run_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Workflow run failed.' } };
  }
}
