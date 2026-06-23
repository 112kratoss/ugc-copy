import 'server-only';

import {
  BackendRateLimitError,
  WORKFLOW_CANVAS_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  createWorkflowShareSnapshotGraph,
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import {
  isMissingWorkflowLifecycleColumnsError,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '@/lib/workflow-canvas-route-compat';
import {
  toWorkflowShareSummary,
  WORKFLOW_SHARE_SUMMARY_SELECT,
  type WorkflowShareRow,
} from '@/lib/workflow-share';

type SupabaseErrorLike = { code?: string | null; message?: string | null } | Error | null;
type SupabaseResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike }>;
type WorkflowShareRateLimitClient = Parameters<typeof enforceBackendRateLimit>[0];

type WorkflowCanvasShareSourceRow = {
  id: string;
  title: string;
  graph: Partial<WorkflowCanvasGraph>;
  revision: number | null;
};

type WorkflowShareCreateUserClient = {
  from: (table: string) => unknown;
};

type WorkflowCanvasLookupTable = {
  select: (columns: string) => {
    eq: (column: string, value: unknown) => {
      eq: (column: string, value: unknown) => {
        single: () => SupabaseResult<unknown>;
      };
    };
  };
};

type WorkflowShareInsertTable = {
  insert: (payload: Record<string, unknown>) => {
    select: (columns: string) => {
      single: () => SupabaseResult<unknown>;
    };
  };
};

export type WorkflowShareCreateRouteResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 404 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type CreateWorkflowShareForRouteParams = {
  canvasId: string;
  origin: string;
  serviceSupabase: WorkflowShareRateLimitClient;
  userId: string;
  userSupabase: WorkflowShareCreateUserClient;
};

function createRateLimitResult(error: BackendRateLimitError): WorkflowShareCreateRouteResult {
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

function workflowCanvasTable(userSupabase: WorkflowShareCreateUserClient) {
  return userSupabase.from('workflow_canvases') as WorkflowCanvasLookupTable;
}

function workflowShareTable(userSupabase: WorkflowShareCreateUserClient) {
  return userSupabase.from('workflow_shares') as WorkflowShareInsertTable;
}

async function loadOwnedCanvas({
  canvasId,
  userId,
  userSupabase,
  useLifecycleColumns,
}: {
  canvasId: string;
  userId: string;
  userSupabase: WorkflowShareCreateUserClient;
  useLifecycleColumns: boolean;
}) {
  return workflowCanvasTable(userSupabase)
    .select(useLifecycleColumns ? WORKFLOW_CANVAS_SELECT : WORKFLOW_CANVAS_SELECT_LEGACY)
    .eq('id', canvasId)
    .eq('user_id', userId)
    .single();
}

export async function createWorkflowShareForRoute({
  canvasId,
  origin,
  serviceSupabase,
  userId,
  userSupabase,
}: CreateWorkflowShareForRouteParams): Promise<WorkflowShareCreateRouteResult> {
  try {
    await enforceBackendRateLimit(serviceSupabase, {
      ...WORKFLOW_CANVAS_MUTATION_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    console.error('Failed to enforce workflow canvas mutation rate limit:', error);
    return { ok: false, status: 500, body: { error: 'Failed to create workflow share link.' } };
  }

  let { data: canvas, error } = await loadOwnedCanvas({
    canvasId,
    userId,
    userSupabase,
    useLifecycleColumns: true,
  });

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyResult = await loadOwnedCanvas({
      canvasId,
      userId,
      userSupabase,
      useLifecycleColumns: false,
    });
    canvas = legacyResult.data;
    error = legacyResult.error;
  }

  if (error || !canvas) {
    return { ok: false, status: 404, body: { error: 'Workflow canvas not found.' } };
  }

  const canvasRecord = canvas as WorkflowCanvasShareSourceRow;
  const graph = normalizeWorkflowGraph(canvasRecord.graph);
  const shareGraph = createWorkflowShareSnapshotGraph(graph);
  const shareInsert = {
    owner_user_id: userId,
    source_canvas_id: canvasRecord.id,
    source_revision: typeof canvasRecord.revision === 'number' ? canvasRecord.revision : 0,
    title: canvasRecord.title,
    graph: shareGraph,
    node_count: shareGraph.nodes.length,
    edge_count: shareGraph.edges.length,
  };

  const { data: share, error: shareError } = await workflowShareTable(userSupabase)
    .insert(shareInsert)
    .select(WORKFLOW_SHARE_SUMMARY_SELECT)
    .single();

  if (shareError || !share) {
    console.error('Failed to create workflow share snapshot:', shareError);
    return { ok: false, status: 500, body: { error: 'Failed to create workflow share link.' } };
  }

  return {
    ok: true,
    body: {
      share: toWorkflowShareSummary(
        share as Pick<WorkflowShareRow, 'id' | 'title' | 'node_count' | 'edge_count' | 'import_count' | 'created_at'>,
        origin,
      ),
    },
  };
}
