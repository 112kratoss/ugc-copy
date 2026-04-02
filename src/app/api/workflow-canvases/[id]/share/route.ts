import { NextRequest, NextResponse } from 'next/server';

import { authenticateRequest } from '@/lib/server-helpers';
import {
  createWorkflowShareSnapshotGraph,
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import {
  toWorkflowShareSummary,
  WORKFLOW_SHARE_SUMMARY_SELECT,
  type WorkflowShareRow,
} from '@/lib/workflow-share';
import {
  isMissingWorkflowLifecycleColumnsError,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '../../workflowCanvasRouteCompat';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { supabase, userId } = auth;

  const loadCanvas = async (useLifecycleColumns: boolean) => supabase
    .from('workflow_canvases')
    .select(useLifecycleColumns ? WORKFLOW_CANVAS_SELECT : WORKFLOW_CANVAS_SELECT_LEGACY)
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  let { data: canvas, error } = await loadCanvas(true);

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyResult = await loadCanvas(false);
    canvas = legacyResult.data;
    error = legacyResult.error;
  }

  if (error || !canvas) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  const canvasRecord = canvas as unknown as {
    id: string;
    title: string;
    graph: Partial<WorkflowCanvasGraph>;
    revision: number | null;
  };
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

  const { data: share, error: shareError } = await supabase
    .from('workflow_shares')
    .insert(shareInsert)
    .select(WORKFLOW_SHARE_SUMMARY_SELECT)
    .single();

  if (shareError || !share) {
    console.error('Failed to create workflow share snapshot:', shareError);
    return NextResponse.json({ error: 'Failed to create workflow share link.' }, { status: 500 });
  }

  return NextResponse.json({
    share: toWorkflowShareSummary(
      share as unknown as Pick<WorkflowShareRow, 'id' | 'title' | 'node_count' | 'edge_count' | 'import_count' | 'created_at'>,
      new URL(request.url).origin
    ),
  });
}
