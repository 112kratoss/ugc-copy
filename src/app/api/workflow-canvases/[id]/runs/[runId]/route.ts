import { after, NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import { getWorkflowRunDetails, monitorWorkflowRun } from '@/lib/workflow-runner';

interface RouteParams {
  params: Promise<{ id: string; runId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id, runId } = await params;
  const { supabase } = auth;

  try {
    const run = await getWorkflowRunDetails({
      supabase,
      canvasId: id,
      runId,
    });

    if (run.status === 'processing') {
      after(async () => {
        try {
          await monitorWorkflowRun({
            canvasId: id,
            runId,
          });
        } catch (monitorError) {
          console.error('Workflow run monitor failed:', monitorError);
        }
      });
    }

    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch workflow run.';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
