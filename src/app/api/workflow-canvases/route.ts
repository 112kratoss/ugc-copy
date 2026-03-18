import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import { createStarterGraph, normalizeWorkflowGraph } from '@/lib/workflow-canvas';

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { supabase, userId } = auth;
  const { data, error } = await supabase
    .from('workflow_canvases')
    .select('id, title, graph, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch workflow canvases:', error);
    return NextResponse.json({ error: 'Failed to fetch workflow canvases.' }, { status: 500 });
  }

  return NextResponse.json({
    canvases: (data || []).map((canvas) => ({
      ...canvas,
      graph: normalizeWorkflowGraph(canvas.graph),
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { supabase, userId } = auth;
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New workflow canvas';
  const graph = normalizeWorkflowGraph(body.graph || createStarterGraph());

  const { data, error } = await supabase
    .from('workflow_canvases')
    .insert({
      user_id: userId,
      title,
      graph,
      viewport: graph.viewport,
    })
    .select('id, title, graph, created_at, updated_at')
    .single();

  if (error || !data) {
    console.error('Failed to create workflow canvas:', error);
    return NextResponse.json({ error: 'Failed to create workflow canvas.' }, { status: 500 });
  }

  return NextResponse.json({
    canvas: {
      ...data,
      graph: normalizeWorkflowGraph(data.graph),
    },
  });
}
