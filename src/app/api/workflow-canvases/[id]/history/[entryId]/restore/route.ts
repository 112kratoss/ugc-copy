import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import { normalizeWorkflowGraph } from '@/lib/workflow-canvas';

interface RouteParams {
  params: Promise<{ id: string; entryId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id, entryId } = await params;
  const { supabase, userId } = auth;

  const { data: historyEntry, error: historyError } = await supabase
    .from('workflow_canvas_history')
    .select('id, canvas_id, title, graph, revision, kind, created_at')
    .eq('id', entryId)
    .eq('canvas_id', id)
    .eq('user_id', userId)
    .single();

  if (historyError || !historyEntry) {
    return NextResponse.json({ error: 'Workflow history entry not found.' }, { status: 404 });
  }

  const { data: currentCanvas, error: canvasError } = await supabase
    .from('workflow_canvases')
    .select('id, revision, published_at')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (canvasError || !currentCanvas) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('workflow_canvases')
    .update({
      title: historyEntry.title,
      graph: historyEntry.graph,
      viewport: normalizeWorkflowGraph(historyEntry.graph).viewport,
      revision: currentCanvas.revision + 1,
      status: 'draft',
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, title, graph, created_at, updated_at, revision, status, published_at')
    .single();

  if (error || !data) {
    console.error('Failed to restore workflow canvas history:', error);
    return NextResponse.json({ error: 'Failed to restore workflow history.' }, { status: 500 });
  }

  const normalizedGraph = normalizeWorkflowGraph(data.graph);
  const { error: snapshotError } = await supabase
    .from('workflow_canvas_history')
    .insert({
      canvas_id: data.id,
      user_id: userId,
      title: data.title,
      graph: data.graph,
      revision: data.revision,
      kind: 'draft',
    });

  if (snapshotError) {
    console.error('Failed to save restored workflow snapshot:', snapshotError);
  }

  return NextResponse.json({
    canvas: {
      ...data,
      graph: normalizedGraph,
    },
  });
}
