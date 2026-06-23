import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import type {
  WorkflowAssistantAvailability,
  WorkflowCanvasAssistantMessageRecord,
  WorkflowAssistantProposalDiff,
  WorkflowCanvasAssistantProposalRecord,
  WorkflowCanvasAssistantState,
} from '@/lib/workflow-assistant';
import {
  WORKFLOW_ASSISTANT_SETUP_ERROR_CODE,
  WORKFLOW_ASSISTANT_SETUP_MESSAGE,
} from '@/lib/workflow-assistant';
import {
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '@/lib/workflow-canvas-route-compat';

type AssistantProposalRow = {
  id: string;
  canvas_id: string;
  base_revision: number;
  status: WorkflowCanvasAssistantProposalRecord['status'];
  summary: string;
  diff: WorkflowAssistantProposalDiff | null;
  proposed_graph: Partial<WorkflowCanvasGraph>;
  created_at: string;
  applied_at: string | null;
  discarded_at: string | null;
};

type AssistantMessageRow = {
  id: string;
  canvas_id: string;
  role: WorkflowCanvasAssistantMessageRecord['role'];
  content: string;
  proposal_id: string | null;
  created_at: string;
};

export async function loadOwnedWorkflowCanvas(
  supabase: SupabaseClient,
  canvasId: string,
  userId: string
) {
  const modern = await supabase
    .from('workflow_canvases')
    .select(WORKFLOW_CANVAS_SELECT)
    .eq('id', canvasId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!modern.error || modern.data) {
    return modern.data
      ? withWorkflowCanvasLifecycleDefaults({
          ...modern.data,
          graph: normalizeWorkflowGraph(modern.data.graph),
        })
      : null;
  }

  const legacy = await supabase
    .from('workflow_canvases')
    .select(WORKFLOW_CANVAS_SELECT_LEGACY)
    .eq('id', canvasId)
    .eq('user_id', userId)
    .maybeSingle();

  return legacy.data
    ? withWorkflowCanvasLifecycleDefaults({
        ...legacy.data,
        graph: normalizeWorkflowGraph(legacy.data.graph),
      })
    : null;
}

export function normalizeAssistantProposalRecord(
  row: AssistantProposalRow | null | undefined
): WorkflowCanvasAssistantProposalRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    canvas_id: row.canvas_id,
    base_revision: typeof row.base_revision === 'number' ? row.base_revision : 0,
    status: row.status === 'applied' || row.status === 'discarded' ? row.status : 'ready',
    summary: typeof row.summary === 'string' ? row.summary : '',
    diff: {
      regionId: row.diff?.regionId ?? '',
      nodes: {
        added: Array.isArray(row.diff?.nodes?.added) ? row.diff!.nodes.added : [],
        changed: Array.isArray(row.diff?.nodes?.changed) ? row.diff!.nodes.changed : [],
        removed: Array.isArray(row.diff?.nodes?.removed) ? row.diff!.nodes.removed : [],
      },
      edges: {
        added: typeof row.diff?.edges?.added === 'number' ? row.diff.edges.added : 0,
        removed: typeof row.diff?.edges?.removed === 'number' ? row.diff.edges.removed : 0,
      },
    },
    proposed_graph: normalizeWorkflowGraph(row.proposed_graph),
    created_at: row.created_at,
    applied_at: row.applied_at,
    discarded_at: row.discarded_at,
  };
}

export function normalizeAssistantMessages(
  rows: AssistantMessageRow[] | null | undefined
): WorkflowCanvasAssistantMessageRecord[] {
  return (rows ?? []).map((row) => ({
    id: row.id,
    canvas_id: row.canvas_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    proposal_id: row.proposal_id,
    created_at: row.created_at,
  }));
}

export function createWorkflowAssistantStateResponse({
  messages = [],
  proposal = null,
  availability = 'ready',
  setupMessage = null,
}: Partial<WorkflowCanvasAssistantState> & {
  availability?: WorkflowAssistantAvailability;
}) {
  return {
    messages,
    proposal,
    availability,
    setupMessage,
  } satisfies WorkflowCanvasAssistantState;
}

export function createWorkflowAssistantSetupRequiredBody({
  messages = [],
  proposal = null,
}: {
  messages?: WorkflowCanvasAssistantMessageRecord[];
  proposal?: WorkflowCanvasAssistantProposalRecord | null;
} = {}) {
  return {
    ...createWorkflowAssistantStateResponse({
      messages,
      proposal,
      availability: 'setup_required',
      setupMessage: WORKFLOW_ASSISTANT_SETUP_MESSAGE,
    }),
    code: WORKFLOW_ASSISTANT_SETUP_ERROR_CODE,
    error: WORKFLOW_ASSISTANT_SETUP_MESSAGE,
  };
}

export function createWorkflowAssistantSetupRequiredResponse({
  messages = [],
  proposal = null,
  status = 503,
}: {
  messages?: WorkflowCanvasAssistantMessageRecord[];
  proposal?: WorkflowCanvasAssistantProposalRecord | null;
  status?: number;
} = {}) {
  return NextResponse.json(
    createWorkflowAssistantSetupRequiredBody({ messages, proposal }),
    { status }
  );
}
