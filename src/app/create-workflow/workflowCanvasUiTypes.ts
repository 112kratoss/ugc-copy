import type {
  WorkflowCanvasHistoryEntry,
  WorkflowCanvasListItem,
  WorkflowCanvasNode,
  WorkflowCanvasRecord,
  WorkflowHandleType,
} from '@/lib/workflow-canvas';

export type PreviewMediaKind = 'image' | 'video' | 'audio';

export interface CanvasSelectionState {
  nodeIds: string[];
  edgeIds: string[];
}

export interface CanvasContextMenuState {
  x: number;
  y: number;
  target: 'pane' | 'node' | 'edge';
  flowPosition?: { x: number; y: number };
  nodeId?: string;
  edgeId?: string;
}

export interface PreviewMediaState {
  kind: PreviewMediaKind;
  url: string;
  title: string;
}

export interface CanvasFloatingPosition {
  left: number;
  top: number;
  width: number;
}

export interface CanvasAnchoredPopupPosition extends CanvasFloatingPosition {
  caretLeft: number;
}

export type WorkflowInspectorTab = 'parameters' | 'data' | 'runs' | 'notes';
export type WorkflowInspectorPanel = WorkflowInspectorTab | 'connection' | 'selection';

export type WorkflowCanvasSelectedEntity =
  | { kind: 'node'; nodeId: string }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'selection' }
  | null;

export interface WorkflowQuickInsertHandleState {
  kind: 'handle';
  clientX: number;
  clientY: number;
  sourceNodeId: string;
  sourceHandle: WorkflowHandleType;
}

export interface WorkflowQuickInsertEdgeState {
  kind: 'edge';
  clientX: number;
  clientY: number;
  edgeId: string;
  sourceNodeId: string;
  sourceHandle: WorkflowHandleType;
  targetNodeId: string;
  targetHandle: WorkflowHandleType;
}

export type WorkflowQuickInsertState =
  | WorkflowQuickInsertHandleState
  | WorkflowQuickInsertEdgeState;

export interface WorkflowCommandAction {
  id: string;
  label: string;
  description: string;
  keywords?: string[];
  group: string;
  perform: () => void;
}

export interface WorkflowSwitcherItem extends WorkflowCanvasListItem {
  isActive: boolean;
}

export interface WorkflowHistoryPanelState {
  activeCanvas: WorkflowCanvasRecord | null;
  entries: WorkflowCanvasHistoryEntry[];
  isLoading: boolean;
  error: string | null;
}

export interface WorkflowRunAffordance {
  tone: 'ready' | 'queued' | 'blocked' | 'static';
  message: string;
  creditLabel: string | null;
  runNodeDisabled: boolean;
  runBranchDisabled: boolean;
  node: WorkflowCanvasNode;
}
