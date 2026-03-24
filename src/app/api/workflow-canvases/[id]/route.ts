import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import { createWorkflowGraphHash, normalizeWorkflowGraph } from '@/lib/workflow-canvas';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { supabase, userId } = auth;

  const { data, error } = await supabase
    .from('workflow_canvases')
    .select('id, title, graph, created_at, updated_at, revision')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  return NextResponse.json({
    canvas: {
      ...data,
      graph: normalizeWorkflowGraph(data.graph),
    },
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
      .select('id, title, graph, created_at, updated_at, revision')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

  const { data: currentCanvas, error: currentCanvasError } = await loadCurrentCanvas();

  if (currentCanvasError || !currentCanvas) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  const nextTitle = typeof body.title === 'string'
    ? body.title.trim() || 'Untitled workflow'
    : currentCanvas.title;
  const nextGraph = body.graph
    ? normalizeWorkflowGraph(body.graph)
    : normalizeWorkflowGraph(currentCanvas.graph);
  const currentGraph = normalizeWorkflowGraph(currentCanvas.graph);
  const currentGraphHash = createWorkflowGraphHash(currentGraph);
  const nextGraphHash = createWorkflowGraphHash(nextGraph);
  const baseRevision = typeof body.baseRevision === 'number' ? body.baseRevision : null;
  const requestGraphHash = typeof body.graphHash === 'string' ? body.graphHash : null;

  if (baseRevision !== null && currentCanvas.revision > baseRevision) {
    return NextResponse.json(
      {
        error: 'Workflow canvas has newer changes.',
        canvas: {
          ...currentCanvas,
          graph: currentGraph,
        },
      },
      { status: 409 }
    );
  }

  if (
    nextTitle === currentCanvas.title &&
    nextGraphHash === currentGraphHash &&
    (!requestGraphHash || requestGraphHash === currentGraphHash)
  ) {
    return NextResponse.json({
      canvas: {
        ...currentCanvas,
        graph: currentGraph,
      },
    });
  }

  let updateQuery = supabase
    .from('workflow_canvases')
    .update({
      title: nextTitle,
      graph: nextGraph,
      viewport: nextGraph.viewport,
      revision: currentCanvas.revision + 1,
    })
    .eq('id', id)
    .eq('user_id', userId);

  if (baseRevision !== null) {
    updateQuery = updateQuery.eq('revision', baseRevision);
  }

  const { data, error } = await updateQuery
    .select('id, title, graph, created_at, updated_at, revision')
    .maybeSingle();

  if (!data && !error && baseRevision !== null) {
    const { data: latestCanvas, error: latestCanvasError } = await loadCurrentCanvas();

    if (latestCanvasError || !latestCanvas) {
      console.error('Failed to reload workflow canvas after revision conflict:', latestCanvasError);
      return NextResponse.json({ error: 'Failed to update workflow canvas.' }, { status: 500 });
    }

    return NextResponse.json(
      {
        error: 'Workflow canvas has newer changes.',
        canvas: {
          ...latestCanvas,
          graph: normalizeWorkflowGraph(latestCanvas.graph),
        },
      },
      { status: 409 }
    );
  }

  if (error || !data) {
    console.error('Failed to update workflow canvas:', error);
    return NextResponse.json({ error: 'Failed to update workflow canvas.' }, { status: 500 });
  }

  return NextResponse.json({
    canvas: {
      ...data,
      graph: normalizeWorkflowGraph(data.graph),
    },
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
