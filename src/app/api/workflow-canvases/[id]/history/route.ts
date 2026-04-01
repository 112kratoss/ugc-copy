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
    .from('workflow_canvas_history')
    .select('id, canvas_id, title, graph, revision, kind, created_at')
    .eq('canvas_id', id)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error('Failed to fetch workflow canvas history:', error);
    return NextResponse.json({ error: 'Failed to fetch workflow history.' }, { status: 500 });
  }

  return NextResponse.json({
    history: (data || []).map((entry) => ({
      ...entry,
      graph: normalizeWorkflowGraph(entry.graph),
    })),
  });
}
