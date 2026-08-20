import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  WORKFLOW_RUN_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { normalizeWorkflowGraph, type WorkflowCanvasGraph } from '@/lib/workflow-canvas';
import {
  executeWorkflowRun,
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
  supabase: SupabaseClient;
  userId: string;
  canvasId: string;
  graph: WorkflowCanvasGraph;
  startNodeId: string;
  mode: WorkflowCanvasRunMode;
  catalogRevision?: string | null;
  idempotencyKey?: string | null;
}) => Promise<WorkflowRunExecutionResult>;

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
  /**
   * Value of the `Idempotency-Key` request header, if the client sent one. It
   * wins over the body field: a proxy or SDK that retries a request replays the
   * header, which is exactly the case the key has to catch.
   */
  idempotencyKeyHeader?: string | null;
  executeRun?: ExecuteWorkflowRunForRoute;
};

const defaultExecuteWorkflowRunForRoute: ExecuteWorkflowRunForRoute = async (params) =>
  executeWorkflowRun(params);

function resolveAdminClient(adminSupabase: WorkflowRunRateLimitInput) {
  return typeof adminSupabase === 'function' ? adminSupabase() : adminSupabase;
}

// An idempotency key longer than this is far more likely to be a bug or an
// abuse attempt than a real key; the column is unbounded text and the index
// entry is per (canvas, key).
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function readIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null;
  return trimmed;
}

function readRunRequest(body: unknown): {
  startNodeId: string | null;
  mode: WorkflowCanvasRunMode;
  catalogRevision: string | null;
  idempotencyKey: string | null;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { startNodeId: null, mode: 'branch', catalogRevision: null, idempotencyKey: null };
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
    idempotencyKey: readIdempotencyKey(record.idempotencyKey),
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
  idempotencyKeyHeader = null,
  executeRun = defaultExecuteWorkflowRunForRoute,
}: StartWorkflowRunForRouteInput): Promise<WorkflowRunRouteResult> {
  const request = readRunRequest(body);
  const idempotencyKey = readIdempotencyKey(idempotencyKeyHeader) ?? request.idempotencyKey;
  if (!request.startNodeId) {
    return {
      ok: false,
      status: 400,
      body: { error: 'A start node is required.' },
    };
  }
  if (!idempotencyKey) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'An Idempotency-Key is required for workflow runs.',
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      },
    };
  }

  let mutationSupabase: WorkflowRunRateLimitClient;
  try {
    mutationSupabase = resolveAdminClient(adminSupabase);
    await enforceBackendRateLimit(mutationSupabase, {
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
      // All run/step writes cross the service-only initializer. The request
      // client above remains the ownership authority and is never reused for
      // privileged mutation.
      supabase: mutationSupabase as unknown as SupabaseClient,
      userId,
      canvasId: canvas.id,
      graph: normalizeWorkflowGraph(canvas.graph),
      startNodeId: request.startNodeId,
      mode: request.mode,
      catalogRevision: request.catalogRevision,
      idempotencyKey,
    });

    return { ok: true, body: result };
  } catch (error) {
    // Unexpected runner failures keep their detail in the backend logs only;
    // node-level validation problems surface through per-step error states.
    logBackendError('workflow_canvas_run_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Workflow run failed.' } };
  }
}
