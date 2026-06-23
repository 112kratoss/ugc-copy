import 'server-only';

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

type WorkflowAssistantProposalApplyBody = Record<string, unknown>;

export type WorkflowAssistantCanvasPatchInput = {
  canvasId: string;
  graph: WorkflowCanvasGraph;
  baseRevision: number;
};

export type WorkflowAssistantCanvasPatchResult = {
  ok: boolean;
  status: number;
  body: WorkflowAssistantProposalApplyBody;
};

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

function setupRequiredResult(): WorkflowAssistantProposalApplyRouteResult {
  return {
    ok: false,
    status: 503,
    body: createWorkflowAssistantSetupRequiredBody(),
  };
}

export async function applyWorkflowAssistantProposalForRoute({
  canvasId,
  proposalId,
  userId,
  supabase,
  applyCanvasPatch,
  now = () => new Date().toISOString(),
}: {
  canvasId: string;
  proposalId: string;
  userId: string;
  supabase: SupabaseClient;
  applyCanvasPatch: (input: WorkflowAssistantCanvasPatchInput) => Promise<WorkflowAssistantCanvasPatchResult>;
  now?: () => string;
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

  const patchResult = await applyCanvasPatch({
    canvasId,
    graph: proposal.proposed_graph,
    baseRevision: proposal.base_revision,
  });

  if (patchResult.status === 409) {
    const discardedAt = now();
    const discardResult = await supabase
      .from('workflow_canvas_assistant_proposals')
      .update({
        status: 'discarded',
        discarded_at: discardedAt,
      })
      .eq('id', proposalId)
      .eq('user_id', userId);

    if (discardResult.error && isMissingWorkflowCanvasAssistantSchemaError(discardResult.error)) {
      return setupRequiredResult();
    }

    return {
      ok: false,
      status: 409,
      body: {
        error: patchResult.body.error || 'Workflow canvas has newer changes.',
        canvas: patchResult.body.canvas ?? null,
        proposal: {
          ...proposal,
          status: 'discarded',
          discarded_at: discardedAt,
        },
      },
    };
  }

  if (!patchResult.ok) {
    return {
      ok: false,
      status: patchResult.status,
      body: {
        error: patchResult.body.error || 'Failed to apply assistant proposal.',
      },
    };
  }

  const appliedAt = now();
  const applyResult = await supabase
    .from('workflow_canvas_assistant_proposals')
    .update({
      status: 'applied',
      applied_at: appliedAt,
    })
    .eq('id', proposalId)
    .eq('user_id', userId);

  if (applyResult.error && isMissingWorkflowCanvasAssistantSchemaError(applyResult.error)) {
    return setupRequiredResult();
  }

  return {
    ok: true,
    body: {
      canvas: patchResult.body.canvas,
      proposal: {
        ...proposal,
        status: 'applied',
        applied_at: appliedAt,
      },
    },
  };
}
