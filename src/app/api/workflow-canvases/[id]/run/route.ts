import { after, NextRequest, NextResponse } from 'next/server';
import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
  WORKFLOW_RUN_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { authenticateRequest, createServiceClient } from '@/lib/server-helpers';
import { normalizeWorkflowGraph } from '@/lib/workflow-canvas';
import { executeWorkflowRun, monitorWorkflowRun } from '@/lib/workflow-runner';

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
    await enforceBackendRateLimit(createServiceClient(), {
      ...WORKFLOW_RUN_RATE_LIMIT,
      key: userId,
    });
  } catch (rateLimitError) {
    if (rateLimitError instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(rateLimitError);
    }

    console.error('Workflow run rate limit failed:', rateLimitError);
    return NextResponse.json({ error: 'Failed to check workflow run limits.' }, { status: 500 });
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

    if (result.status === 'processing') {
      after(async () => {
        try {
          await monitorWorkflowRun({
            canvasId: canvas.id,
            runId: result.runId,
          });
        } catch (monitorError) {
          console.error('Workflow run monitor failed:', monitorError);
        }
      });
    }

    return NextResponse.json(result);
  } catch (runError) {
    const message = runError instanceof Error ? runError.message : 'Workflow run failed.';
    console.error('Workflow canvas run failed:', runError);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
