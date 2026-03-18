import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import { normalizeWorkflowGraph } from '@/lib/workflow-canvas';

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
    .select('id, title, graph, created_at, updated_at')
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
  const updates: Record<string, unknown> = {};

  if (typeof body.title === 'string') {
    updates.title = body.title.trim() || 'Untitled workflow';
  }

  if (body.graph) {
    const graph = normalizeWorkflowGraph(body.graph);
    updates.graph = graph;
    updates.viewport = graph.viewport;
  }

  const { data, error } = await supabase
    .from('workflow_canvases')
    .update(updates)
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, title, graph, created_at, updated_at')
    .single();

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
