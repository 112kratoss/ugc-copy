import { NextRequest, NextResponse } from 'next/server';

import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import { authenticateRequest, createServiceClient } from '@/lib/server-helpers';
import {
  isWorkflowShareId,
  toWorkflowShareSummary,
  WORKFLOW_SHARE_SELECT,
  type WorkflowShareRow,
} from '@/lib/workflow-share';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '../../../workflow-canvases/workflowCanvasRouteCompat';

interface RouteParams {
  params: Promise<{ shareId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { shareId } = await params;
  if (!isWorkflowShareId(shareId)) {
    return NextResponse.json({ error: 'Workflow share not found.' }, { status: 404 });
  }

  const { supabase, userId } = auth;
  const { data: share, error: shareError } = await supabase
    .from('workflow_shares')
    .select(WORKFLOW_SHARE_SELECT)
    .eq('id', shareId)
    .maybeSingle();

  if (shareError || !share) {
    if (shareError) {
      console.error('Failed to load workflow share before import:', shareError);
    }
    return NextResponse.json({ error: 'Workflow share not found.' }, { status: 404 });
  }

  const typedShare = share as unknown as WorkflowShareRow;
  const importedGraph = normalizeWorkflowGraph(typedShare.graph as unknown as Partial<WorkflowCanvasGraph>);
  const importedGraphSnapshot = serializeWorkflowGraph(importedGraph);
  const nextTitle = `Copy of ${typedShare.title.trim() || 'Untitled workflow'}`;

  const insertCanvas = async (useLifecycleColumns: boolean) => supabase
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
    console.error('Failed to import shared workflow:', canvasError);
    return NextResponse.json({ error: 'Failed to import workflow share.' }, { status: 500 });
  }

  const canvasRecord = canvas as unknown as {
    id: string;
    title: string;
    graph: Partial<WorkflowCanvasGraph>;
    revision: number;
    created_at: string;
    updated_at: string;
    status?: 'draft' | 'published';
    published_at?: string | null;
  };
  const normalizedCanvas = withWorkflowCanvasLifecycleDefaults({
    ...canvasRecord,
    graph: normalizeWorkflowGraph(canvasRecord.graph),
  });

  try {
    const { error: historyError } = await supabase
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
      console.error('Failed to write imported workflow history snapshot:', historyError);
    }
  } catch (historyError) {
    if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      console.error('Failed to write imported workflow history snapshot:', historyError);
    }
  }

  try {
    const adminSupabase = createServiceClient();
    const { error: updateShareError } = await adminSupabase
      .from('workflow_shares')
      .update({
        import_count: (typedShare.import_count ?? 0) + 1,
      })
      .eq('id', shareId);

    if (updateShareError) {
      console.error('Failed to increment workflow share import count:', updateShareError);
    }
  } catch (updateShareError) {
    console.error('Failed to increment workflow share import count:', updateShareError);
  }

  return NextResponse.json({
    canvas: normalizedCanvas,
    share: toWorkflowShareSummary(
      {
        ...typedShare,
        import_count: (typedShare.import_count ?? 0) + 1,
      },
      new URL(request.url).origin
    ),
  });
}
