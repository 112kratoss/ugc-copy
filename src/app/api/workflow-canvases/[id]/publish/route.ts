import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import { normalizeWorkflowGraph } from '@/lib/workflow-canvas';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { supabase, userId } = auth;

  const { data: currentCanvas, error: currentCanvasError } = await supabase
    .from('workflow_canvases')
    .select('id, title, graph, created_at, updated_at, revision, status, published_at')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (currentCanvasError || !currentCanvas) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  const publishedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('workflow_canvases')
    .update({
      status: 'published',
      published_at: publishedAt,
      revision: currentCanvas.revision + 1,
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, title, graph, created_at, updated_at, revision, status, published_at')
    .single();

  if (error || !data) {
    console.error('Failed to publish workflow canvas:', error);
    return NextResponse.json({ error: 'Failed to publish workflow canvas.' }, { status: 500 });
  }

  const normalizedGraph = normalizeWorkflowGraph(data.graph);
  const { error: historyError } = await supabase
    .from('workflow_canvas_history')
    .insert({
      canvas_id: data.id,
      user_id: userId,
      title: data.title,
      graph: data.graph,
      revision: data.revision,
      kind: 'published',
    });

  if (historyError) {
    console.error('Failed to store published workflow snapshot:', historyError);
  }

  return NextResponse.json({
    canvas: {
      ...data,
      graph: normalizedGraph,
    },
  });
}
