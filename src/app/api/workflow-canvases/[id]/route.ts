import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import {
  createWorkflowGraphHash,
  mergeWorkflowCanvasGraph,
  normalizeWorkflowGraph,
} from '@/lib/workflow-canvas';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '../workflowCanvasRouteCompat';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
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

  let { data, error } = await loadCanvas(true);

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyResult = await loadCanvas(false);
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error || !data) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  return NextResponse.json({
    canvas: withWorkflowCanvasLifecycleDefaults({
      ...data,
      graph: normalizeWorkflowGraph(data.graph),
    }),
  });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { supabase, userId } = auth;
  const body = await request.json().catch(() => ({}));
  const loadCurrentCanvas = () =>
    supabase
      .from('workflow_canvases')
      .select(WORKFLOW_CANVAS_SELECT)
      .eq('id', id)
      .eq('user_id', userId)
      .single();

  let { data: currentCanvas, error: currentCanvasError } = await loadCurrentCanvas();

  if (currentCanvasError && isMissingWorkflowLifecycleColumnsError(currentCanvasError)) {
    const legacyCurrentCanvas = await supabase
      .from('workflow_canvases')
      .select(WORKFLOW_CANVAS_SELECT_LEGACY)
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    currentCanvas = legacyCurrentCanvas.data;
    currentCanvasError = legacyCurrentCanvas.error;
  }

  if (currentCanvasError || !currentCanvas) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  const normalizedCurrentCanvas = withWorkflowCanvasLifecycleDefaults(currentCanvas);
  const nextTitle = typeof body.title === 'string'
    ? body.title.trim() || 'Untitled workflow'
    : normalizedCurrentCanvas.title;
  const nextGraph = body.graph
    ? normalizeWorkflowGraph(body.graph)
    : normalizeWorkflowGraph(normalizedCurrentCanvas.graph);
  const currentGraph = normalizeWorkflowGraph(normalizedCurrentCanvas.graph);
  const currentGraphHash = createWorkflowGraphHash(currentGraph, { mode: 'client-save' });
  const nextGraphHash = createWorkflowGraphHash(nextGraph, { mode: 'client-save' });
  const baseRevision = typeof body.baseRevision === 'number' ? body.baseRevision : null;
  const requestGraphHash = typeof body.graphHash === 'string' ? body.graphHash : null;

  if (baseRevision !== null && normalizedCurrentCanvas.revision > baseRevision) {
    return NextResponse.json(
      {
        error: 'Workflow canvas has newer changes.',
        canvas: withWorkflowCanvasLifecycleDefaults({
          ...normalizedCurrentCanvas,
          graph: currentGraph,
        }),
      },
      { status: 409 }
    );
  }

  if (
    nextTitle === normalizedCurrentCanvas.title &&
    nextGraphHash === currentGraphHash &&
    (!requestGraphHash || requestGraphHash === currentGraphHash)
  ) {
    return NextResponse.json({
      canvas: withWorkflowCanvasLifecycleDefaults({
        ...normalizedCurrentCanvas,
        graph: currentGraph,
      }),
    });
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
      .eq('id', id)
      .eq('user_id', userId);

    if (baseRevision !== null) {
      updateQuery = updateQuery.eq('revision', baseRevision);
    }

    return updateQuery
      .select(useLifecycleColumns ? WORKFLOW_CANVAS_SELECT : WORKFLOW_CANVAS_SELECT_LEGACY)
      .maybeSingle();
  };

  let { data, error } = await buildUpdateQuery(true);

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyUpdate = await buildUpdateQuery(false);
    data = legacyUpdate.data;
    error = legacyUpdate.error;
  }

  if (!data && !error && baseRevision !== null) {
    let { data: latestCanvas, error: latestCanvasError } = await loadCurrentCanvas();

    if (latestCanvasError && isMissingWorkflowLifecycleColumnsError(latestCanvasError)) {
      const legacyLatestCanvas = await supabase
        .from('workflow_canvases')
        .select(WORKFLOW_CANVAS_SELECT_LEGACY)
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      latestCanvas = legacyLatestCanvas.data;
      latestCanvasError = legacyLatestCanvas.error;
    }

    if (latestCanvasError || !latestCanvas) {
      console.error('Failed to reload workflow canvas after revision conflict:', latestCanvasError);
      return NextResponse.json({ error: 'Failed to update workflow canvas.' }, { status: 500 });
    }

    return NextResponse.json(
      {
        error: 'Workflow canvas has newer changes.',
        canvas: withWorkflowCanvasLifecycleDefaults({
          ...latestCanvas,
          graph: normalizeWorkflowGraph(latestCanvas.graph),
        }),
      },
      { status: 409 }
    );
  }

  if (error || !data) {
    console.error('Failed to update workflow canvas:', error);
    return NextResponse.json({ error: 'Failed to update workflow canvas.' }, { status: 500 });
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
        graph: mergedGraph,
        revision: data.revision,
        kind: 'draft',
      });

    if (historyError && !isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      console.error('Failed to save workflow canvas history snapshot:', historyError);
    }
  } catch (historyError) {
    if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      console.error('Failed to save workflow canvas history snapshot:', historyError);
    }
  }

  return NextResponse.json({
    canvas,
  });
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { supabase, userId } = auth;

  const { error } = await supabase
    .from('workflow_canvases')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) {
    console.error('Failed to delete workflow canvas:', error);
    return NextResponse.json({ error: 'Failed to delete workflow canvas.' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
