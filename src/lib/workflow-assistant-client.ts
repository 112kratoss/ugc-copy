import { WORKFLOW_ASSISTANT_COST as SHARED_WORKFLOW_ASSISTANT_COST } from '@/lib/workflow-costs';
import type {
  WorkflowCanvasGraph,
  WorkflowNodeKind,
} from '@/lib/workflow-canvas';

type WorkflowAssistantMessageRole = 'user' | 'assistant';
type WorkflowAssistantProposalStatus = 'ready' | 'applied' | 'discarded';

export type WorkflowAssistantPreviewState = 'added' | 'changed' | 'removed';
export type WorkflowAssistantAvailability = 'ready' | 'setup_required';

export const WORKFLOW_ASSISTANT_SETUP_ERROR_CODE = 'assistant_schema_missing';
const WORKFLOW_ASSISTANT_SETUP_MIGRATION = '20260416120000_workflow_canvas_assistant.sql';
export const WORKFLOW_ASSISTANT_SETUP_MESSAGE = `Workflow assistant database tables are missing. Run migration ${WORKFLOW_ASSISTANT_SETUP_MIGRATION}.`;
export const WORKFLOW_ASSISTANT_COST = SHARED_WORKFLOW_ASSISTANT_COST;

interface WorkflowAssistantDiffNode {
  id: string;
  title: string;
  type: WorkflowNodeKind;
  roleKey: string | null;
  slotKey: string | null;
}

export interface WorkflowAssistantProposalDiff {
  regionId: string;
  nodes: {
    added: WorkflowAssistantDiffNode[];
    changed: WorkflowAssistantDiffNode[];
    removed: WorkflowAssistantDiffNode[];
  };
  edges: {
    added: number;
    removed: number;
  };
}

export interface WorkflowCanvasAssistantMessageRecord {
  id: string;
  canvas_id: string;
  role: WorkflowAssistantMessageRole;
  content: string;
  proposal_id: string | null;
  created_at: string;
}

export interface WorkflowCanvasAssistantProposalRecord {
  id: string;
  canvas_id: string;
  base_revision: number;
  status: WorkflowAssistantProposalStatus;
  summary: string;
  diff: WorkflowAssistantProposalDiff;
  proposed_graph: WorkflowCanvasGraph;
  created_at: string;
  applied_at: string | null;
  discarded_at: string | null;
}

export interface WorkflowCanvasAssistantState {
  messages: WorkflowCanvasAssistantMessageRecord[];
  proposal: WorkflowCanvasAssistantProposalRecord | null;
  availability: WorkflowAssistantAvailability;
  setupMessage: string | null;
}

export function getWorkflowAssistantPreviewNodeStates(
  diff: WorkflowAssistantProposalDiff | null | undefined
) {
  const previewStateByNodeId: Record<string, WorkflowAssistantPreviewState> = {};

  if (!diff) {
    return previewStateByNodeId;
  }

  diff.nodes.added.forEach((node) => {
    previewStateByNodeId[node.id] = 'added';
  });
  diff.nodes.changed.forEach((node) => {
    if (!previewStateByNodeId[node.id]) {
      previewStateByNodeId[node.id] = 'changed';
    }
  });

  return previewStateByNodeId;
}
