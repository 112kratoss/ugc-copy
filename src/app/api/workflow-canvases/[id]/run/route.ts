import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import { normalizeWorkflowGraph } from '@/lib/workflow-canvas';
import { executeWorkflowRun } from '@/lib/workflow-runner';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { supabase, userId } = auth;
  const body = await request.json().catch(() => ({}));
  const startNodeId = typeof body.startNodeId === 'string' ? body.startNodeId : null;
  const mode = body.mode === 'node' ? 'node' : 'branch';

  if (!startNodeId) {
    return NextResponse.json({ error: 'A start node is required.' }, { status: 400 });
  }

  const { data: canvas, error } = await supabase
    .from('workflow_canvases')
    .select('id, graph')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !canvas) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  try {
    const result = await executeWorkflowRun({
      supabase,
      userId,
      canvasId: canvas.id,
      graph: normalizeWorkflowGraph(canvas.graph),
      startNodeId,
      mode,
    });

    return NextResponse.json(result);
  } catch (runError) {
    const message = runError instanceof Error ? runError.message : 'Workflow run failed.';
    console.error('Workflow canvas run failed:', runError);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
