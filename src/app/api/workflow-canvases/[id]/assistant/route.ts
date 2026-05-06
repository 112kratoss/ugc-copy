import { NextRequest, NextResponse } from 'next/server';

import { authenticateRequest } from '@/lib/server-helpers';
import {
  isMissingWorkflowCanvasAssistantSchemaError,
} from '../../workflowCanvasRouteCompat';
import {
  createWorkflowAssistantSetupRequiredResponse,
  createWorkflowAssistantStateResponse,
  loadOwnedWorkflowCanvas,
  normalizeAssistantMessages,
  normalizeAssistantProposalRecord,
} from './assistantRouteShared';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const { supabase, userId } = auth;

  const canvas = await loadOwnedWorkflowCanvas(supabase, id, userId);
  if (!canvas) {
    return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
  }

  let messagesData: Parameters<typeof normalizeAssistantMessages>[0] = [];
  let proposalData: Parameters<typeof normalizeAssistantProposalRecord>[0] = null;

  try {
    const messagesResult = await supabase
      .from('workflow_canvas_assistant_messages')
      .select('id, canvas_id, role, content, proposal_id, created_at')
      .eq('canvas_id', id)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (messagesResult.error) {
      if (isMissingWorkflowCanvasAssistantSchemaError(messagesResult.error)) {
        return createWorkflowAssistantSetupRequiredResponse({ status: 200 });
      }

      throw messagesResult.error;
    }

    messagesData = messagesResult.data ?? [];

    const proposalResult = await supabase
      .from('workflow_canvas_assistant_proposals')
      .select('id, canvas_id, base_revision, status, summary, diff, proposed_graph, created_at, applied_at, discarded_at')
      .eq('canvas_id', id)
      .eq('user_id', userId)
      .neq('status', 'discarded')
      .order('created_at', { ascending: false })
      .limit(1);

    if (proposalResult.error) {
      if (isMissingWorkflowCanvasAssistantSchemaError(proposalResult.error)) {
        return createWorkflowAssistantSetupRequiredResponse({
          messages: normalizeAssistantMessages(messagesData),
          status: 200,
        });
      }

      throw proposalResult.error;
    }

    proposalData = Array.isArray(proposalResult.data) ? proposalResult.data[0] ?? null : null;
  } catch (error) {
    console.error('Failed to load workflow canvas assistant state:', error);
    return NextResponse.json({ error: 'Failed to load workflow assistant state.' }, { status: 500 });
  }

  return NextResponse.json(createWorkflowAssistantStateResponse({
    messages: normalizeAssistantMessages(messagesData),
    proposal: normalizeAssistantProposalRecord(proposalData),
    availability: 'ready',
    setupMessage: null,
  }));
}
