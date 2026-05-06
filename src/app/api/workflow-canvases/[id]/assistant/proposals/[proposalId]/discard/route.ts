import { NextRequest, NextResponse } from 'next/server';

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

  const discardedAt = new Date().toISOString();
  const discardResult = await supabase
    .from('workflow_canvas_assistant_proposals')
    .update({
      status: 'discarded',
      discarded_at: discardedAt,
    })
    .eq('id', proposalId)
    .eq('user_id', userId);

  if (discardResult.error && isMissingWorkflowCanvasAssistantSchemaError(discardResult.error)) {
    return createWorkflowAssistantSetupRequiredResponse();
  }

  return NextResponse.json({
    proposal: {
      ...proposal,
      status: 'discarded',
      discarded_at: discardedAt,
    },
  });
}
