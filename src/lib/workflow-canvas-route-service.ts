import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createWorkflowGraphHash,
  mergeWorkflowCanvasGraph,
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
  type WorkflowCanvasStatus,
} from '@/lib/workflow-canvas';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '@/lib/workflow-canvas-route-compat';
import {
  abortPreparedWorkflowUploads,
  consumePersistedWorkflowUploads,
  prepareWorkflowUploadsForPersistence,
  type PreparedWorkflowUploadLocation,
} from '@/lib/workflow-upload-consumption';
import { isDefinitiveSupabaseMutationRejection } from '@/lib/upload-byte-admission';

type WorkflowCanvasRouteRow = {
  id: string;
  title: string;
  graph: Partial<WorkflowCanvasGraph> | null;
  created_at: string;
  updated_at: string;
  revision: number;
  status?: string | null;
  published_at?: string | null;
};

type WorkflowCanvasPatchBody = {
  title?: unknown;
  graph?: unknown;
  baseRevision?: unknown;
  graphHash?: unknown;
};

type WorkflowCanvasRouteCanvas = Omit<WorkflowCanvasRouteRow, 'graph' | 'status' | 'published_at'> & {
  graph: WorkflowCanvasGraph;
  status: WorkflowCanvasStatus;
  published_at: string | null;
};

export type WorkflowCanvasGetRouteResult =
  | {
      ok: true;
      body: {
        canvas: WorkflowCanvasRouteCanvas;
      };
    }
  | {
      ok: false;
      status: 404;
      body: {
        error: string;
      };
    };

export type WorkflowCanvasPatchRouteResult =
  | {
      ok: true;
      body: {
        canvas: WorkflowCanvasRouteCanvas;
      };
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      body: {
        error: string;
        canvas?: WorkflowCanvasRouteCanvas;
      };
    };

export type WorkflowCanvasDeleteRouteResult =
  | {
      ok: true;
      body: {
        success: true;
      };
    }
  | {
      ok: false;
      status: 500;
      body: {
        error: string;
      };
    };

function normalizeCanvasResponse(row: WorkflowCanvasRouteRow): WorkflowCanvasRouteCanvas {
  const normalizedGraph = normalizeWorkflowGraph(row.graph);
  return withWorkflowCanvasLifecycleDefaults({
    ...row,
    graph: normalizedGraph,
  });
}

async function loadWorkflowCanvasForRoute(
  supabase: SupabaseClient,
  canvasId: string,
  userId: string,
): Promise<{ data: WorkflowCanvasRouteRow | null; error: unknown }> {
  const loadCanvas = async (useLifecycleColumns: boolean) => {
    const query = supabase
      .from('workflow_canvases')
      .select(useLifecycleColumns ? WORKFLOW_CANVAS_SELECT : WORKFLOW_CANVAS_SELECT_LEGACY)
      .eq('id', canvasId)
      .eq('user_id', userId)
      .single();
    const { data, error } = await query;

    return {
      data: (data as WorkflowCanvasRouteRow | null) ?? null,
      error,
    };
  };

  let data: WorkflowCanvasRouteRow | null = null;
  let error: unknown = null;
  ({ data, error } = await loadCanvas(true));

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyResult = await loadCanvas(false);
    data = legacyResult.data;
    error = legacyResult.error;
  }

  return { data, error };
}

export async function getWorkflowCanvasForRoute({
  canvasId,
  supabase,
  userId,
}: {
  canvasId: string;
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowCanvasGetRouteResult> {
  const { data, error } = await loadWorkflowCanvasForRoute(supabase, canvasId, userId);

  if (error || !data) {
    return { ok: false, status: 404, body: { error: 'Workflow canvas not found.' } };
  }

  return {
    ok: true,
    body: {
      canvas: normalizeCanvasResponse(data),
    },
  };
}

export async function deleteWorkflowCanvasForRoute({
  canvasId,
  supabase,
  userId,
}: {
  canvasId: string;
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowCanvasDeleteRouteResult> {
  const { error } = await supabase
    .from('workflow_canvases')
    .delete()
    .eq('id', canvasId)
    .eq('user_id', userId);

  if (error) {
    logBackendError('failed_to_delete_workflow_canvas', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to delete workflow canvas.' } };
  }

  return { ok: true, body: { success: true } };
}

export async function patchWorkflowCanvasForRoute({
  body,
  canvasId,
  supabase,
  uploadClient = supabase,
  userId,
}: {
  body: WorkflowCanvasPatchBody;
  canvasId: string;
  supabase: SupabaseClient;
  uploadClient?: SupabaseClient;
  userId: string;
}): Promise<WorkflowCanvasPatchRouteResult> {
  const { data: currentCanvas, error: currentCanvasError } = await loadWorkflowCanvasForRoute(
    supabase,
    canvasId,
    userId,
  );

  if (currentCanvasError || !currentCanvas) {
    return { ok: false, status: 404, body: { error: 'Workflow canvas not found.' } };
  }

  const normalizedCurrentCanvas = withWorkflowCanvasLifecycleDefaults(currentCanvas);
  const nextTitle = typeof body.title === 'string'
    ? body.title.trim() || 'Untitled workflow'
    : normalizedCurrentCanvas.title;
  const nextGraph = body.graph
    ? normalizeWorkflowGraph(body.graph as Partial<WorkflowCanvasGraph>)
    : normalizeWorkflowGraph(normalizedCurrentCanvas.graph);
  const currentGraph = normalizeWorkflowGraph(normalizedCurrentCanvas.graph);
  const currentGraphHash = createWorkflowGraphHash(currentGraph, { mode: 'client-save' });
  const nextGraphHash = createWorkflowGraphHash(nextGraph, { mode: 'client-save' });
  const baseRevision = typeof body.baseRevision === 'number' ? body.baseRevision : null;
  const requestGraphHash = typeof body.graphHash === 'string' ? body.graphHash : null;
  let submittedUploadLocations: PreparedWorkflowUploadLocation[] = [];

  if (body.graph) {
    const preparedUploads = await prepareWorkflowUploadsForPersistence(uploadClient, nextGraph, userId);
    if (!preparedUploads.ok) {
      return {
        ok: false,
        status: preparedUploads.status,
        body: { error: preparedUploads.error },
      };
    }
    submittedUploadLocations = preparedUploads.locations;
  }

  if (baseRevision !== null && normalizedCurrentCanvas.revision > baseRevision) {
    await abortPreparedWorkflowUploads(uploadClient, submittedUploadLocations);
    return {
      ok: false,
      status: 409,
      body: {
        error: 'Workflow canvas has newer changes.',
        canvas: {
          ...normalizeCanvasResponse(normalizedCurrentCanvas),
          graph: currentGraph,
        },
      },
    };
  }

  if (
    nextTitle === normalizedCurrentCanvas.title &&
    nextGraphHash === currentGraphHash &&
    (!requestGraphHash || requestGraphHash === currentGraphHash)
  ) {
    const completed = await consumePersistedWorkflowUploads(
      uploadClient,
      submittedUploadLocations,
      userId,
    );
    if (!completed.ok) {
      return { ok: false, status: 500, body: { error: completed.error } };
    }
    return {
      ok: true,
      body: {
        canvas: {
          ...normalizeCanvasResponse(normalizedCurrentCanvas),
          graph: currentGraph,
        },
      },
    };
  }

  const mergedGraph = mergeWorkflowCanvasGraph(currentGraph, nextGraph);
  const nextStatus = normalizedCurrentCanvas.status === 'published' ? 'draft' : normalizedCurrentCanvas.status;
  const buildUpdateQuery = (useLifecycleColumns: boolean) => {
    let updateQuery = supabase
      .from('workflow_canvases')
      .update({
        title: nextTitle,
        graph: mergedGraph,
        viewport: mergedGraph.viewport,
        revision: normalizedCurrentCanvas.revision + 1,
        ...(useLifecycleColumns ? { status: nextStatus } : {}),
      })
      .eq('id', canvasId)
      .eq('user_id', userId);

    if (baseRevision !== null) {
      updateQuery = updateQuery.eq('revision', baseRevision);
    }

    const selectedQuery = useLifecycleColumns
      ? updateQuery.select(WORKFLOW_CANVAS_SELECT)
      : updateQuery.select(WORKFLOW_CANVAS_SELECT_LEGACY);

    return selectedQuery.maybeSingle();
  };

  let data: WorkflowCanvasRouteRow | null = null;
  let error: unknown = null;
  let mutationStatus: number | undefined;
  try {
    const result = await buildUpdateQuery(true);
    data = (result.data as WorkflowCanvasRouteRow | null) ?? null;
    error = result.error;
    mutationStatus = result.status;

    if (error && isMissingWorkflowLifecycleColumnsError(error)) {
      const legacyUpdate = await buildUpdateQuery(false);
      data = (legacyUpdate.data as WorkflowCanvasRouteRow | null) ?? null;
      error = legacyUpdate.error;
      mutationStatus = legacyUpdate.status;
    }
  } catch (updateError) {
    logBackendError('failed_to_update_workflow_canvas', { error: updateError });
    return { ok: false, status: 500, body: { error: 'Failed to update workflow canvas.' } };
  }

  if (!data && !error && baseRevision !== null) {
    let latestCanvas: WorkflowCanvasRouteRow | null = null;
    let latestCanvasError: unknown = null;
    try {
      const latest = await loadWorkflowCanvasForRoute(supabase, canvasId, userId);
      latestCanvas = latest.data;
      latestCanvasError = latest.error;
    } catch (reloadError) {
      await abortPreparedWorkflowUploads(uploadClient, submittedUploadLocations);
      logBackendError('failed_to_reload_workflow_canvas_after_revision_conflict', { error: reloadError });
      return { ok: false, status: 500, body: { error: 'Failed to update workflow canvas.' } };
    }

    if (latestCanvasError || !latestCanvas) {
      await abortPreparedWorkflowUploads(uploadClient, submittedUploadLocations);
      logBackendError('failed_to_reload_workflow_canvas_after_revision_conflict', { error: latestCanvasError });
      return { ok: false, status: 500, body: { error: 'Failed to update workflow canvas.' } };
    }

    await abortPreparedWorkflowUploads(uploadClient, submittedUploadLocations);
    return {
      ok: false,
      status: 409,
      body: {
        error: 'Workflow canvas has newer changes.',
        canvas: normalizeCanvasResponse(latestCanvas),
      },
    };
  }

  if (error || !data) {
    if (
      !error
      || isDefinitiveSupabaseMutationRejection({ error, status: mutationStatus })
    ) {
      await abortPreparedWorkflowUploads(uploadClient, submittedUploadLocations);
    }
    logBackendError('failed_to_update_workflow_canvas', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to update workflow canvas.' } };
  }

  const completedUploads = await consumePersistedWorkflowUploads(
    uploadClient,
    submittedUploadLocations,
    userId,
  );
  if (!completedUploads.ok) {
    return { ok: false, status: 500, body: { error: completedUploads.error } };
  }

  const canvas = normalizeCanvasResponse(data);

  try {
    const { error: historyError } = await supabase
      .from('workflow_canvas_history')
      .insert({
        canvas_id: data.id,
        user_id: userId,
        title: data.title,
        graph: mergedGraph,
        revision: data.revision,
        kind: 'draft',
      });

    if (historyError && !isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      logBackendError('failed_to_save_workflow_canvas_history_snapshot', { error: historyError });
    }
  } catch (historyError) {
    if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      logBackendError('failed_to_save_workflow_canvas_history_snapshot', { error: historyError });
    }
  }

  return {
    ok: true,
    body: {
      canvas,
    },
  };
}
