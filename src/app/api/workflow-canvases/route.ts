import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import { createStarterGraph, normalizeWorkflowGraph, serializeWorkflowGraph } from '@/lib/workflow-canvas';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_LIST_SELECT,
  WORKFLOW_CANVAS_LIST_SELECT_LEGACY,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from './workflowCanvasRouteCompat';

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { supabase, userId } = auth;
  let { data, error } = await supabase
    .from('workflow_canvases')
    .select(WORKFLOW_CANVAS_LIST_SELECT)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyResult = await supabase
      .from('workflow_canvases')
      .select(WORKFLOW_CANVAS_LIST_SELECT_LEGACY)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) {
    console.error('Failed to fetch workflow canvases:', error);
    return NextResponse.json({ error: 'Failed to fetch workflow canvases.' }, { status: 500 });
  }

  return NextResponse.json({
    canvases: (data || []).map((canvas) => withWorkflowCanvasLifecycleDefaults(canvas)),
  });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { supabase, userId } = auth;
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New workflow canvas';
  const graph = normalizeWorkflowGraph(body.graph || createStarterGraph());

  const insertCanvas = async (useLifecycleColumns: boolean) => supabase
    .from('workflow_canvases')
    .insert({
      user_id: userId,
      title,
      graph: serializeWorkflowGraph(graph),
      viewport: graph.viewport,
      ...(useLifecycleColumns ? { status: 'draft' } : {}),
    })
    .select(useLifecycleColumns ? WORKFLOW_CANVAS_SELECT : WORKFLOW_CANVAS_SELECT_LEGACY)
    .single();

  let { data, error } = await insertCanvas(true);

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyInsert = await insertCanvas(false);
    data = legacyInsert.data;
    error = legacyInsert.error;
  }

  if (error || !data) {
    console.error('Failed to create workflow canvas:', error);
    return NextResponse.json({ error: 'Failed to create workflow canvas.' }, { status: 500 });
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

  return NextResponse.json({
    canvas,
  });
}
