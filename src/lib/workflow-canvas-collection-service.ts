import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  WORKFLOW_CANVAS_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  createStarterGraph,
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import { createWorkflowCanvasLibrarySummary } from '@/lib/workflow-canvas-preview';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_LIST_SELECT,
  WORKFLOW_CANVAS_LIST_SELECT_LEGACY,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '@/lib/workflow-canvas-route-compat';

type WorkflowCanvasListRow = {
  id: string;
  title: string;
  graph: Partial<WorkflowCanvasGraph> | null;
  updated_at: string;
  revision: number;
  status?: string | null;
  published_at?: string | null;
};

type WorkflowCanvasRouteRow = WorkflowCanvasListRow & {
  created_at: string;
};

export type WorkflowCanvasCollectionServiceClient = Parameters<typeof enforceBackendRateLimit>[0];

export type WorkflowCanvasCollectionRouteResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

function createRateLimitResult(error: BackendRateLimitError): WorkflowCanvasCollectionRouteResult {
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

export async function listWorkflowCanvasesForRoute({
  supabase,
  userId,
}: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowCanvasCollectionRouteResult> {
  let data: WorkflowCanvasListRow[] | null = null;
  let error: unknown = null;
  {
    const result = await supabase
      .from('workflow_canvases')
      .select(WORKFLOW_CANVAS_LIST_SELECT)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    data = (result.data as WorkflowCanvasListRow[] | null) ?? null;
    error = result.error;
  }

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyResult = await supabase
      .from('workflow_canvases')
      .select(WORKFLOW_CANVAS_LIST_SELECT_LEGACY)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    data = (legacyResult.data as WorkflowCanvasListRow[] | null) ?? null;
    error = legacyResult.error;
  }

  if (error) {
    console.error('Failed to fetch workflow canvases:', error);
    return { ok: false, status: 500, body: { error: 'Failed to fetch workflow canvases.' } };
  }

  return {
    ok: true,
    body: {
      canvases: (data || []).map((canvas) => {
        const { graph, ...metadata } = canvas;
        return {
          ...withWorkflowCanvasLifecycleDefaults(metadata),
          ...createWorkflowCanvasLibrarySummary(graph),
        };
      }),
    },
  };
}

export async function createWorkflowCanvasForRoute({
  supabase,
  rateLimitClient,
  userId,
  readBody,
}: {
  supabase: SupabaseClient;
  rateLimitClient: WorkflowCanvasCollectionServiceClient;
  userId: string;
  readBody: () => Promise<Record<string, unknown>>;
}): Promise<WorkflowCanvasCollectionRouteResult> {
  try {
    await enforceBackendRateLimit(rateLimitClient, {
      ...WORKFLOW_CANVAS_MUTATION_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    console.error('Failed to enforce workflow canvas mutation rate limit:', error);
    return { ok: false, status: 500, body: { error: 'Failed to create workflow canvas.' } };
  }

  const body = await readBody();
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New workflow canvas';
  const graph = normalizeWorkflowGraph(body.graph || createStarterGraph());

  const insertCanvas = async (useLifecycleColumns: boolean) => {
    const insertQuery = supabase
      .from('workflow_canvases')
      .insert({
        user_id: userId,
        title,
        graph: serializeWorkflowGraph(graph),
        viewport: graph.viewport,
        ...(useLifecycleColumns ? { status: 'draft' } : {}),
      });
    const selectedQuery = useLifecycleColumns
      ? insertQuery.select(WORKFLOW_CANVAS_SELECT)
      : insertQuery.select(WORKFLOW_CANVAS_SELECT_LEGACY);
    const { data, error } = await selectedQuery.single();

    return {
      data: (data as WorkflowCanvasRouteRow | null) ?? null,
      error,
    };
  };

  let data: WorkflowCanvasRouteRow | null = null;
  let error: unknown = null;
  ({ data, error } = await insertCanvas(true));

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyInsert = await insertCanvas(false);
    data = legacyInsert.data;
    error = legacyInsert.error;
  }

  if (error || !data) {
    console.error('Failed to create workflow canvas:', error);
    return { ok: false, status: 500, body: { error: 'Failed to create workflow canvas.' } };
  }

  const normalizedGraph = normalizeWorkflowGraph(data.graph);
  const canvas = withWorkflowCanvasLifecycleDefaults({
    ...data,
    graph: normalizedGraph,
  });

  try {
    const { error: historyError } = await supabase
      .from('workflow_canvas_history')
      .insert({
        canvas_id: data.id,
        user_id: userId,
        title: data.title,
        graph: serializeWorkflowGraph(normalizedGraph),
        revision: data.revision,
        kind: 'draft',
      });

    if (historyError && !isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      console.error('Failed to create initial workflow canvas history snapshot:', historyError);
    }
  } catch (historyError) {
    if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      console.error('Failed to create initial workflow canvas history snapshot:', historyError);
    }
  }

  return {
    ok: true,
    body: {
      canvas,
    },
  };
}
