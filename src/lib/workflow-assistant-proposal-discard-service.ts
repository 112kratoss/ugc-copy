import 'server-only';

import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { WorkflowCanvasGraph } from '@/lib/workflow-canvas';
import type { WorkflowAssistantProposalDiff } from '@/lib/workflow-assistant';
import {
  isMissingWorkflowCanvasAssistantSchemaError,
} from '@/lib/workflow-canvas-route-compat';
import {
  createWorkflowAssistantSetupRequiredBody,
  normalizeAssistantProposalRecord,
} from '@/lib/workflow-assistant-route-shared';

type WorkflowAssistantProposalDiscardBody = Record<string, unknown>;

export type WorkflowAssistantProposalDiscardRouteResult =
  | {
      ok: true;
      body: WorkflowAssistantProposalDiscardBody;
    }
  | {
      ok: false;
      status: number;
      body: WorkflowAssistantProposalDiscardBody;
    };

type AssistantProposalRow = {
  id: string;
  canvas_id: string;
  base_revision: number;
  status: 'ready' | 'applied' | 'discarded';
  summary: string;
  diff: WorkflowAssistantProposalDiff | null;
  proposed_graph: Partial<WorkflowCanvasGraph>;
  created_at: string;
  applied_at: string | null;
  discarded_at: string | null;
};

function setupRequiredResult(): WorkflowAssistantProposalDiscardRouteResult {
  return {
    ok: false,
    status: 503,
    body: createWorkflowAssistantSetupRequiredBody(),
  };
}

function proposalNotFoundResult(): WorkflowAssistantProposalDiscardRouteResult {
  return {
    ok: false,
    status: 404,
    body: { error: 'Workflow assistant proposal not found.' },
  };
}

export async function discardWorkflowAssistantProposalForRoute({
  canvasId,
  proposalId,
  userId,
  supabase,
  now = () => new Date().toISOString(),
}: {
  canvasId: string;
  proposalId: string;
  userId: string;
  supabase: SupabaseClient;
  now?: () => string;
}): Promise<WorkflowAssistantProposalDiscardRouteResult> {
  const proposalResult = await supabase
    .from('workflow_canvas_assistant_proposals')
    .select('id, canvas_id, base_revision, status, summary, diff, proposed_graph, created_at, applied_at, discarded_at')
    .eq('id', proposalId)
    .eq('canvas_id', canvasId)
    .eq('user_id', userId)
    .maybeSingle();

  if (proposalResult.error && isMissingWorkflowCanvasAssistantSchemaError(proposalResult.error)) {
    return setupRequiredResult();
  }

  if (proposalResult.error || !proposalResult.data) {
    return proposalNotFoundResult();
  }

  const proposal = normalizeAssistantProposalRecord(proposalResult.data as AssistantProposalRow);
  if (!proposal) {
    return proposalNotFoundResult();
  }

  if (proposal.status !== 'ready') {
    return { ok: false, status: 409, body: { error: 'Only ready proposals can be discarded.' } };
  }

  const discardedAt = now();
  const discardResult = await supabase
    .from('workflow_canvas_assistant_proposals')
    .update({
      status: 'discarded',
      discarded_at: discardedAt,
    })
    .eq('id', proposalId)
    .eq('canvas_id', canvasId)
    .eq('user_id', userId)
    .eq('status', 'ready')
    .select('id, canvas_id, base_revision, status, summary, diff, proposed_graph, created_at, applied_at, discarded_at')
    .maybeSingle();

  if (discardResult.error && isMissingWorkflowCanvasAssistantSchemaError(discardResult.error)) {
    return setupRequiredResult();
  }

  if (discardResult.error) {
    logBackendError('failed_to_discard_workflow_assistant_proposal', { error: discardResult.error });
    return { ok: false, status: 500, body: { error: 'Failed to discard assistant proposal.' } };
  }
  if (!discardResult.data) {
    return { ok: false, status: 409, body: { error: 'This proposal is no longer available to discard.' } };
  }

  return {
    ok: true,
    body: { proposal: normalizeAssistantProposalRecord(discardResult.data as AssistantProposalRow) },
  };
}
