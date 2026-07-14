import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  mergeWorkflowCanvasGraph,
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import type { WorkflowAssistantProposalDiff } from '@/lib/workflow-assistant';
import {
  isMissingWorkflowCanvasAssistantSchemaError,
  withWorkflowCanvasLifecycleDefaults,
} from '@/lib/workflow-canvas-route-compat';
import {
  createWorkflowAssistantSetupRequiredBody,
  loadOwnedWorkflowCanvas,
  normalizeAssistantProposalRecord,
} from '@/lib/workflow-assistant-route-shared';

type WorkflowAssistantProposalApplyBody = Record<string, unknown>;

export type WorkflowAssistantProposalApplyRouteResult =
  | {
      ok: true;
      body: WorkflowAssistantProposalApplyBody;
    }
  | {
      ok: false;
      status: number;
      body: WorkflowAssistantProposalApplyBody;
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

type AtomicProposalApplyResponse = {
  outcome?: unknown;
  canvas?: unknown;
  proposal?: unknown;
};

function setupRequiredResult(): WorkflowAssistantProposalApplyRouteResult {
  return {
    ok: false,
    status: 503,
    body: createWorkflowAssistantSetupRequiredBody(),
  };
}

function internalErrorResult(): WorkflowAssistantProposalApplyRouteResult {
  return {
    ok: false,
    status: 500,
    body: { error: 'Failed to apply assistant proposal.' },
  };
}

function normalizeCanvasRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.title !== 'string') return null;

  return withWorkflowCanvasLifecycleDefaults({
    ...row,
    graph: normalizeWorkflowGraph(row.graph as Partial<WorkflowCanvasGraph> | null),
  });
}

export async function applyWorkflowAssistantProposalForRoute({
  canvasId,
  proposalId,
  userId,
  supabase,
}: {
  canvasId: string;
  proposalId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<WorkflowAssistantProposalApplyRouteResult> {
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
    return { ok: false, status: 404, body: { error: 'Workflow assistant proposal not found.' } };
  }

  const proposal = normalizeAssistantProposalRecord(proposalResult.data as AssistantProposalRow);
  if (!proposal) {
    return { ok: false, status: 404, body: { error: 'Workflow assistant proposal not found.' } };
  }

  if (proposal.status !== 'ready') {
    return { ok: false, status: 409, body: { error: 'Only ready proposals can be applied.' } };
  }

  const canvas = await loadOwnedWorkflowCanvas(supabase, canvasId, userId);
  if (!canvas) {
    return { ok: false, status: 404, body: { error: 'Workflow canvas not found.' } };
  }

  const mergedGraph = mergeWorkflowCanvasGraph(canvas.graph, proposal.proposed_graph);
  const applyResult = await supabase.rpc('apply_workflow_canvas_assistant_proposal', {
    p_canvas_id: canvasId,
    p_proposal_id: proposalId,
    p_merged_graph: mergedGraph,
  });

  if (applyResult.error) {
    if (isMissingWorkflowCanvasAssistantSchemaError(applyResult.error)) {
      return setupRequiredResult();
    }
    console.error('Failed to atomically apply workflow assistant proposal:', applyResult.error);
    return internalErrorResult();
  }

  const atomicResult = applyResult.data as AtomicProposalApplyResponse | null;
  if (!atomicResult || typeof atomicResult !== 'object') {
    console.error('Workflow assistant proposal RPC returned an invalid response.');
    return internalErrorResult();
  }

  if (atomicResult.outcome === 'not_found') {
    return { ok: false, status: 404, body: { error: 'Workflow assistant proposal not found.' } };
  }

  if (atomicResult.outcome === 'proposal_not_ready') {
    return { ok: false, status: 409, body: { error: 'Only ready proposals can be applied.' } };
  }

  const resultCanvas = normalizeCanvasRecord(atomicResult.canvas);
  const resultProposal = normalizeAssistantProposalRecord(atomicResult.proposal as AssistantProposalRow | null);

  if (atomicResult.outcome === 'conflict') {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'Workflow canvas has newer changes.',
        canvas: resultCanvas,
        proposal: resultProposal,
      },
    };
  }

  if (atomicResult.outcome !== 'applied' || !resultCanvas || !resultProposal) {
    console.error('Workflow assistant proposal RPC returned an incomplete response:', atomicResult.outcome);
    return internalErrorResult();
  }

  return {
    ok: true,
    body: {
      canvas: resultCanvas,
      proposal: resultProposal,
    },
  };
}
