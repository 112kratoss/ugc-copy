import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  WORKFLOW_CANVAS_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '@/lib/workflow-canvas-route-compat';
import {
  isWorkflowShareId,
  toWorkflowShareSummary,
  WORKFLOW_SHARE_SELECT,
  type WorkflowShareRow,
} from '@/lib/workflow-share';

type WorkflowCanvasImportRow = {
  id: string;
  title: string;
  graph: Partial<WorkflowCanvasGraph>;
  revision: number;
  created_at: string;
  updated_at: string;
  status?: 'draft' | 'published';
  published_at?: string | null;
};

export type WorkflowShareImportRouteResult =
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

type ImportWorkflowShareParams = {
  origin: string;
  serviceSupabase: SupabaseClient;
  shareId: string;
  userId: string;
  userSupabase: SupabaseClient;
};

function createRateLimitResult(error: BackendRateLimitError): WorkflowShareImportRouteResult {
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

function safeWorkflowTitle(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : 'Untitled workflow';
}

export async function importWorkflowShareForRoute({
  origin,
  serviceSupabase,
  shareId,
  userId,
  userSupabase,
}: ImportWorkflowShareParams): Promise<WorkflowShareImportRouteResult> {
  if (!isWorkflowShareId(shareId)) {
    return { ok: false, status: 404, body: { error: 'Workflow share not found.' } };
  }

  try {
    await enforceBackendRateLimit(serviceSupabase, {
      ...WORKFLOW_CANVAS_MUTATION_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('failed_to_enforce_workflow_canvas_mutation_rate_limit', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to import workflow share.' } };
  }

  const { data: share, error: shareError } = await serviceSupabase
    .from('workflow_shares')
    .select(WORKFLOW_SHARE_SELECT)
    .eq('id', shareId)
    .maybeSingle();

  if (shareError || !share) {
    if (shareError) {
      logBackendError('failed_to_load_workflow_share_before_import', { error: shareError });
    }
    return { ok: false, status: 404, body: { error: 'Workflow share not found.' } };
  }

  const typedShare = share as unknown as WorkflowShareRow;
  const importedGraph = normalizeWorkflowGraph(typedShare.graph as unknown as Partial<WorkflowCanvasGraph>);
  const importedGraphSnapshot = serializeWorkflowGraph(importedGraph);
  const nextTitle = `Copy of ${safeWorkflowTitle(typedShare.title)}`;

  const insertCanvas = async (useLifecycleColumns: boolean) => userSupabase
    .from('workflow_canvases')
    .insert({
      user_id: userId,
      title: nextTitle,
      graph: importedGraphSnapshot,
      viewport: importedGraph.viewport,
      ...(useLifecycleColumns ? { status: 'draft' } : {}),
    })
    .select(useLifecycleColumns ? WORKFLOW_CANVAS_SELECT : WORKFLOW_CANVAS_SELECT_LEGACY)
    .single();

  let { data: canvas, error: canvasError } = await insertCanvas(true);

  if (canvasError && isMissingWorkflowLifecycleColumnsError(canvasError)) {
    const legacyInsert = await insertCanvas(false);
    canvas = legacyInsert.data;
    canvasError = legacyInsert.error;
  }

  if (canvasError || !canvas) {
    logBackendError('failed_to_import_shared_workflow', { error: canvasError });
    return { ok: false, status: 500, body: { error: 'Failed to import workflow share.' } };
  }

  const canvasRecord = canvas as unknown as WorkflowCanvasImportRow;
  const normalizedCanvas = withWorkflowCanvasLifecycleDefaults({
    ...canvasRecord,
    graph: normalizeWorkflowGraph(canvasRecord.graph),
  });

  try {
    const { error: historyError } = await userSupabase
      .from('workflow_canvas_history')
      .insert({
        canvas_id: canvasRecord.id,
        user_id: userId,
        title: canvasRecord.title,
        graph: importedGraphSnapshot,
        revision: canvasRecord.revision,
        kind: 'draft',
      });

    if (historyError && !isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      logBackendError('failed_to_write_imported_workflow_history_snapshot', { error: historyError });
    }
  } catch (historyError) {
    if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      logBackendError('failed_to_write_imported_workflow_history_snapshot', { error: historyError });
    }
  }

  const nextImportCount = (typedShare.import_count ?? 0) + 1;
  try {
    const { error: updateShareError } = await serviceSupabase
      .from('workflow_shares')
      .update({
        import_count: nextImportCount,
      })
      .eq('id', shareId);

    if (updateShareError) {
      logBackendError('failed_to_increment_workflow_share_import_count', { error: updateShareError });
    }
  } catch (updateShareError) {
    logBackendError('failed_to_increment_workflow_share_import_count', { error: updateShareError });
  }

  return {
    ok: true,
    body: {
      canvas: normalizedCanvas,
      share: toWorkflowShareSummary(
        {
          ...typedShare,
          import_count: nextImportCount,
        },
        origin,
      ),
    },
  };
}
