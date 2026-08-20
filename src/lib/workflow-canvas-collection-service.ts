import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

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
import type { WorkflowCanvasLibrarySummary } from '@/lib/workflow-canvas-preview';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLibrarySummaryColumnError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_LIST_SELECT,
  WORKFLOW_CANVAS_LIST_SELECT_WITH_GRAPH,
  WORKFLOW_CANVAS_LIST_SELECT_LEGACY,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '@/lib/workflow-canvas-route-compat';
import {
  abortPreparedWorkflowUploads,
  consumePersistedWorkflowUploads,
  prepareWorkflowUploadsForPersistence,
} from '@/lib/workflow-upload-consumption';
import { isDefinitiveSupabaseMutationRejection } from '@/lib/upload-byte-admission';

type WorkflowCanvasListRow = {
  id: string;
  title: string;
  graph?: Partial<WorkflowCanvasGraph> | null;
  library_summary?: WorkflowCanvasLibrarySummary | null;
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
      status: 400 | 409 | 429 | 500;
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

  if (error && isMissingWorkflowLibrarySummaryColumnError(error)) {
    const graphResult = await supabase
      .from('workflow_canvases')
      .select(WORKFLOW_CANVAS_LIST_SELECT_WITH_GRAPH)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    data = (graphResult.data as WorkflowCanvasListRow[] | null) ?? null;
    error = graphResult.error;
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
    logBackendError('failed_to_fetch_workflow_canvases', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to fetch workflow canvases.' } };
  }

  return {
    ok: true,
    body: {
      canvases: (data || []).map((canvas) => {
        const { graph, library_summary: librarySummary, ...metadata } = canvas;
        return {
          ...withWorkflowCanvasLifecycleDefaults(metadata),
          ...(librarySummary ?? createWorkflowCanvasLibrarySummary(graph)),
        };
      }),
    },
  };
}

export async function createWorkflowCanvasForRoute({
  supabase,
  uploadClient = supabase,
  rateLimitClient,
  userId,
  readBody,
}: {
  supabase: SupabaseClient;
  uploadClient?: SupabaseClient;
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

    logBackendError('failed_to_enforce_workflow_canvas_mutation_rate_limit', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to create workflow canvas.' } };
  }

  const body = await readBody();
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New workflow canvas';
  const graph = normalizeWorkflowGraph(body.graph || createStarterGraph());
  const preparedUploads = await prepareWorkflowUploadsForPersistence(uploadClient, graph, userId);
  if (!preparedUploads.ok) {
    return {
      ok: false,
      status: preparedUploads.status,
      body: { error: preparedUploads.error },
    };
  }

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
    const { data, error, status } = await selectedQuery.single();

    return {
      data: (data as WorkflowCanvasRouteRow | null) ?? null,
      error,
      status,
    };
  };

  let data: WorkflowCanvasRouteRow | null = null;
  let error: unknown = null;
  let mutationStatus: number | undefined;
  try {
    ({ data, error, status: mutationStatus } = await insertCanvas(true));

    if (error && isMissingWorkflowLifecycleColumnsError(error)) {
      const legacyInsert = await insertCanvas(false);
      data = legacyInsert.data;
      error = legacyInsert.error;
      mutationStatus = legacyInsert.status;
    }
  } catch (insertError) {
    logBackendError('failed_to_create_workflow_canvas', { error: insertError });
    return { ok: false, status: 500, body: { error: 'Failed to create workflow canvas.' } };
  }

  if (error || !data) {
    if (isDefinitiveSupabaseMutationRejection({ error, status: mutationStatus })) {
      await abortPreparedWorkflowUploads(uploadClient, preparedUploads.locations);
    }
    logBackendError('failed_to_create_workflow_canvas', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to create workflow canvas.' } };
  }

  const completedUploads = await consumePersistedWorkflowUploads(
    uploadClient,
    preparedUploads.locations,
    userId,
  );
  if (!completedUploads.ok) {
    return { ok: false, status: 500, body: { error: completedUploads.error } };
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
      logBackendError('failed_to_create_initial_workflow_canvas_history_snapshot', { error: historyError });
    }
  } catch (historyError) {
    if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      logBackendError('failed_to_create_initial_workflow_canvas_history_snapshot', { error: historyError });
    }
  }

  return {
    ok: true,
    body: {
      canvas,
    },
  };
}
