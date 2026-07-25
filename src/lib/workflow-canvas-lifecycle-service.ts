import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

type WorkflowHistoryRow = {
  id: string;
  canvas_id: string;
  title: string;
  graph: Partial<WorkflowCanvasGraph> | null;
  revision: number;
  kind: string;
  created_at: string;
};

type WorkflowCanvasRow = {
  id: string;
  title: string;
  graph: Partial<WorkflowCanvasGraph> | null;
  created_at: string;
  updated_at: string;
  revision: number;
  status: string;
  published_at: string | null;
};

type WorkflowCanvasLifecycleResult =
  | {
    ok: true;
    body: Record<string, unknown>;
  }
  | {
    ok: false;
    status: 404 | 500;
    body: { error: string };
  };

function normalizeCanvas(row: WorkflowCanvasRow) {
  return {
    ...row,
    graph: normalizeWorkflowGraph(row.graph),
  };
}

async function saveWorkflowLifecycleSnapshot({
  kind,
  row,
  supabase,
  userId,
}: {
  kind: 'draft' | 'published';
  row: WorkflowCanvasRow;
  supabase: SupabaseClient;
  userId: string;
}) {
  const { error } = await supabase
    .from('workflow_canvas_history')
    .insert({
      canvas_id: row.id,
      user_id: userId,
      title: row.title,
      graph: row.graph,
      revision: row.revision,
      kind,
    });

  if (error) {
    logBackendError(
      kind === 'published'
        ? 'workflow_published_snapshot_store_failed'
        : 'workflow_restored_snapshot_save_failed',
      { error },
    );
  }
}

export async function listWorkflowCanvasHistoryForRoute({
  canvasId,
  supabase,
  userId,
}: {
  canvasId: string;
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowCanvasLifecycleResult> {
  const { data, error } = await supabase
    .from('workflow_canvas_history')
    .select('id, canvas_id, title, graph, revision, kind, created_at')
    .eq('canvas_id', canvasId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    logBackendError('failed_to_fetch_workflow_canvas_history', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to fetch workflow history.' },
    };
  }

  return {
    ok: true,
    body: {
      history: ((data ?? []) as WorkflowHistoryRow[]).map((entry) => ({
        ...entry,
        graph: normalizeWorkflowGraph(entry.graph),
      })),
    },
  };
}

export async function publishWorkflowCanvasForRoute({
  canvasId,
  now = () => new Date(),
  supabase,
  userId,
}: {
  canvasId: string;
  now?: () => Date;
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowCanvasLifecycleResult> {
  const { data: currentData, error: currentCanvasError } = await supabase
    .from('workflow_canvases')
    .select('id, title, graph, created_at, updated_at, revision, status, published_at')
    .eq('id', canvasId)
    .eq('user_id', userId)
    .single();
  const currentCanvas = currentData as WorkflowCanvasRow | null;

  if (currentCanvasError || !currentCanvas) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Workflow canvas not found.' },
    };
  }

  const { data: publishedData, error } = await supabase
    .from('workflow_canvases')
    .update({
      status: 'published',
      published_at: now().toISOString(),
      revision: currentCanvas.revision + 1,
    })
    .eq('id', canvasId)
    .eq('user_id', userId)
    .select('id, title, graph, created_at, updated_at, revision, status, published_at')
    .single();
  const publishedCanvas = publishedData as WorkflowCanvasRow | null;

  if (error || !publishedCanvas) {
    logBackendError('failed_to_publish_workflow_canvas', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to publish workflow canvas.' },
    };
  }

  await saveWorkflowLifecycleSnapshot({
    kind: 'published',
    row: publishedCanvas,
    supabase,
    userId,
  });

  return {
    ok: true,
    body: { canvas: normalizeCanvas(publishedCanvas) },
  };
}

export async function restoreWorkflowCanvasHistoryForRoute({
  canvasId,
  entryId,
  supabase,
  userId,
}: {
  canvasId: string;
  entryId: string;
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowCanvasLifecycleResult> {
  const { data: historyData, error: historyError } = await supabase
    .from('workflow_canvas_history')
    .select('id, canvas_id, title, graph, revision, kind, created_at')
    .eq('id', entryId)
    .eq('canvas_id', canvasId)
    .eq('user_id', userId)
    .single();
  const historyEntry = historyData as WorkflowHistoryRow | null;

  if (historyError || !historyEntry) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Workflow history entry not found.' },
    };
  }

  const { data: currentData, error: canvasError } = await supabase
    .from('workflow_canvases')
    .select('id, revision, published_at')
    .eq('id', canvasId)
    .eq('user_id', userId)
    .single();
  const currentCanvas = currentData as Pick<WorkflowCanvasRow, 'id' | 'revision' | 'published_at'> | null;

  if (canvasError || !currentCanvas) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Workflow canvas not found.' },
    };
  }

  const restoredGraph = normalizeWorkflowGraph(historyEntry.graph);
  const { data: restoredData, error } = await supabase
    .from('workflow_canvases')
    .update({
      title: historyEntry.title,
      graph: historyEntry.graph,
      viewport: restoredGraph.viewport,
      revision: currentCanvas.revision + 1,
      status: 'draft',
    })
    .eq('id', canvasId)
    .eq('user_id', userId)
    .select('id, title, graph, created_at, updated_at, revision, status, published_at')
    .single();
  const restoredCanvas = restoredData as WorkflowCanvasRow | null;

  if (error || !restoredCanvas) {
    logBackendError('failed_to_restore_workflow_canvas_history', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore workflow history.' },
    };
  }

  await saveWorkflowLifecycleSnapshot({
    kind: 'draft',
    row: restoredCanvas,
    supabase,
    userId,
  });

  return {
    ok: true,
    body: { canvas: normalizeCanvas(restoredCanvas) },
  };
}
