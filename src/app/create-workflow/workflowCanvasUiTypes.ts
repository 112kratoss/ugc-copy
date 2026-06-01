import type {
  WorkflowCanvasNode,
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

interface CanvasFloatingPosition {
  left: number;
  top: number;
  width: number;
}

export interface CanvasAnchoredPopupPosition extends CanvasFloatingPosition {
  caretLeft: number;
}

export type WorkflowInspectorTab = 'parameters' | 'data' | 'runs' | 'notes';
export type WorkflowInspectorPanel = WorkflowInspectorTab | 'connection' | 'selection';

export interface WorkflowRunAffordance {
  tone: 'ready' | 'queued' | 'blocked' | 'static';
  message: string;
  creditLabel: string | null;
  runNodeDisabled: boolean;
  runBranchDisabled: boolean;
  node: WorkflowCanvasNode;
}
