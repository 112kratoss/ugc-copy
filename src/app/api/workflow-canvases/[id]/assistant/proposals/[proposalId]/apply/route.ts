import { NextRequest, NextResponse } from 'next/server';

import { PATCH as patchWorkflowCanvas } from '@/app/api/workflow-canvases/[id]/route';
import { authenticateRequest } from '@/lib/server-helpers';
import {
  isMissingWorkflowCanvasAssistantSchemaError,
} from '@/app/api/workflow-canvases/workflowCanvasRouteCompat';
import {
  createWorkflowAssistantSetupRequiredResponse,
  normalizeAssistantProposalRecord,
} from '../../../assistantRouteShared';

interface RouteParams {
  params: Promise<{ id: string; proposalId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id, proposalId } = await params;
  const { supabase, userId } = auth;

  const proposalResult = await supabase
    .from('workflow_canvas_assistant_proposals')
    .select('id, canvas_id, base_revision, status, summary, diff, proposed_graph, created_at, applied_at, discarded_at')
    .eq('id', proposalId)
    .eq('canvas_id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (proposalResult.error && isMissingWorkflowCanvasAssistantSchemaError(proposalResult.error)) {
    return createWorkflowAssistantSetupRequiredResponse();
  }

  if (proposalResult.error || !proposalResult.data) {
    return NextResponse.json({ error: 'Workflow assistant proposal not found.' }, { status: 404 });
  }

  const proposal = normalizeAssistantProposalRecord(proposalResult.data);
  if (!proposal) {
    return NextResponse.json({ error: 'Workflow assistant proposal not found.' }, { status: 404 });
  }

  if (proposal.status !== 'ready') {
    return NextResponse.json({ error: 'Only ready proposals can be applied.' }, { status: 409 });
  }

  const patchResponse = await patchWorkflowCanvas(
    new Request(`http://localhost/api/workflow-canvases/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: request.headers.get('Authorization') || '',
      },
      body: JSON.stringify({
        graph: proposal.proposed_graph,
        baseRevision: proposal.base_revision,
      }),
    }) as never,
    { params: Promise.resolve({ id }) }
  );

  const patchData = await patchResponse.json();

  if (patchResponse.status === 409) {
    const discardResult = await supabase
      .from('workflow_canvas_assistant_proposals')
      .update({
        status: 'discarded',
        discarded_at: new Date().toISOString(),
      })
      .eq('id', proposalId)
      .eq('user_id', userId);

    if (discardResult.error && isMissingWorkflowCanvasAssistantSchemaError(discardResult.error)) {
      return createWorkflowAssistantSetupRequiredResponse();
    }

    return NextResponse.json({
      error: patchData.error || 'Workflow canvas has newer changes.',
      canvas: patchData.canvas ?? null,
      proposal: {
        ...proposal,
        status: 'discarded',
        discarded_at: new Date().toISOString(),
      },
    }, { status: 409 });
  }

  if (!patchResponse.ok) {
    return NextResponse.json({ error: patchData.error || 'Failed to apply assistant proposal.' }, { status: patchResponse.status });
  }

  const appliedAt = new Date().toISOString();
  const applyResult = await supabase
    .from('workflow_canvas_assistant_proposals')
    .update({
      status: 'applied',
      applied_at: appliedAt,
    })
    .eq('id', proposalId)
    .eq('user_id', userId);

  if (applyResult.error && isMissingWorkflowCanvasAssistantSchemaError(applyResult.error)) {
    return createWorkflowAssistantSetupRequiredResponse();
  }

  return NextResponse.json({
    canvas: patchData.canvas,
    proposal: {
      ...proposal,
      status: 'applied',
      applied_at: appliedAt,
    },
  });
}
