import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { WorkflowCanvasAssistantState } from '@/lib/workflow-assistant';
import {
  isMissingWorkflowCanvasAssistantSchemaError,
} from '@/lib/workflow-canvas-route-compat';
import {
  createWorkflowAssistantSetupRequiredBody,
  createWorkflowAssistantStateResponse,
  loadOwnedWorkflowCanvas,
  normalizeAssistantMessages,
  normalizeAssistantProposalRecord,
} from '@/lib/workflow-assistant-route-shared';

export type WorkflowAssistantStateRouteResult =
  | {
      ok: true;
      body: WorkflowCanvasAssistantState;
    }
  | {
      ok: false;
      status: 200 | 404 | 500;
      body: Record<string, unknown>;
    };

type LogError = typeof console.error;

export async function getWorkflowAssistantStateForRoute({
  canvasId,
  logError = console.error,
  supabase,
  userId,
}: {
  canvasId: string;
  logError?: LogError;
  supabase: SupabaseClient;
  userId: string;
}): Promise<WorkflowAssistantStateRouteResult> {
  const canvas = await loadOwnedWorkflowCanvas(supabase, canvasId, userId);
  if (!canvas) {
    return { ok: false, status: 404, body: { error: 'Workflow canvas not found.' } };
  }

  let messagesData: Parameters<typeof normalizeAssistantMessages>[0] = [];
  let proposalData: Parameters<typeof normalizeAssistantProposalRecord>[0] = null;

  try {
    const messagesResult = await supabase
      .from('workflow_canvas_assistant_messages')
      .select('id, canvas_id, role, content, proposal_id, created_at')
      .eq('canvas_id', canvasId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (messagesResult.error) {
      if (isMissingWorkflowCanvasAssistantSchemaError(messagesResult.error)) {
        return {
          ok: false,
          status: 200,
          body: createWorkflowAssistantSetupRequiredBody(),
        };
      }

      throw messagesResult.error;
    }

    messagesData = messagesResult.data ?? [];

    const proposalResult = await supabase
      .from('workflow_canvas_assistant_proposals')
      .select('id, canvas_id, base_revision, status, summary, diff, proposed_graph, created_at, applied_at, discarded_at')
      .eq('canvas_id', canvasId)
      .eq('user_id', userId)
      .neq('status', 'discarded')
      .order('created_at', { ascending: false })
      .limit(1);

    if (proposalResult.error) {
      if (isMissingWorkflowCanvasAssistantSchemaError(proposalResult.error)) {
        return {
          ok: false,
          status: 200,
          body: createWorkflowAssistantSetupRequiredBody({
            messages: normalizeAssistantMessages(messagesData),
          }),
        };
      }

      throw proposalResult.error;
    }

    proposalData = Array.isArray(proposalResult.data)
      ? proposalResult.data[0] ?? null
      : null;
  } catch (error) {
    logError('Failed to load workflow canvas assistant state:', error);
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to load workflow assistant state.' },
    };
  }

  return {
    ok: true,
    body: createWorkflowAssistantStateResponse({
      messages: normalizeAssistantMessages(messagesData),
      proposal: normalizeAssistantProposalRecord(proposalData),
      availability: 'ready',
      setupMessage: null,
    }),
  };
}
