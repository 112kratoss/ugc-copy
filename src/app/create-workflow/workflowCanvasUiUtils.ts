import {
  inspectWorkflowNodeDependencies,
  isRunnableNode,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowNodeDependencyState,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import type { CanvasFloatingPosition, PreviewMediaKind, WorkflowRunAffordance } from './workflowCanvasUiTypes';

export function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
}

export function getCanvasFloatingPosition({
  canvasBounds,
  clientX,
  clientY,
  panelWidth,
  panelHeight,
}: {
  canvasBounds: DOMRect;
  clientX: number;
  clientY: number;
  panelWidth: number;
  panelHeight: number;
}): CanvasFloatingPosition {
  let left = clientX - canvasBounds.left + 18;
  let top = clientY - canvasBounds.top - 18;

  if (left + panelWidth > canvasBounds.width - 16) {
    left = Math.max(16, clientX - canvasBounds.left - panelWidth - 18);
  }

  if (top + panelHeight > canvasBounds.height - 16) {
    top = Math.max(16, canvasBounds.height - panelHeight - 16);
  }

  return {
    left: Math.max(16, left),
    top: Math.max(16, top),
    width: panelWidth,
  };
}

export function getNodeLabel(nodes: WorkflowCanvasGraph['nodes'], nodeId: string): string {
  return nodes.find((node) => node.id === nodeId)?.data.title || 'Unknown node';
}

export function getNodeLabelFromMap(
  nodeById: ReadonlyMap<string, WorkflowCanvasNode>,
  nodeId: string
): string {
  return nodeById.get(nodeId)?.data.title || 'Unknown node';
}

export function getNodePreviewKind(nodeType: WorkflowNodeKind): PreviewMediaKind {
  if (nodeType === 'image-input' || nodeType === 'image-generate') {
    return 'image';
  }

  if (nodeType === 'video-input' || nodeType === 'video-generate' || nodeType === 'motion-generate') {
    return 'video';
  }

  return 'audio';
}

export function formatHandleLabel(handle: string | null | undefined): string {
  if (!handle) {
    return 'default';
  }

  return handle.replace(/-/g, ' ');
}

export function getNodeRunAffordance({
  credits,
  graph,
  node,
}: {
  credits: number | null | undefined;
  graph: WorkflowCanvasGraph;
  node: WorkflowCanvasNode | null;
}): WorkflowRunAffordance | null {
  if (!node) {
    return null;
  }

  const creditParts = [
    typeof credits === 'number' ? `${credits} credits available` : null,
    typeof node.data.runState.cost === 'number'
      ? `Last run ${node.data.runState.cost} credits`
      : 'Cost varies by model',
  ].filter(Boolean);
  const creditLabel = creditParts.length > 0 ? creditParts.join(' • ') : null;

  if (!isRunnableNode(node)) {
    return {
      tone: 'static',
      message: 'Static input selected. Run from here to continue into downstream generators.',
      creditLabel,
      runNodeDisabled: false,
      runBranchDisabled: false,
      node,
    };
  }

  const dependencyState: WorkflowNodeDependencyState = inspectWorkflowNodeDependencies(graph, node);
  if (dependencyState.kind === 'blocked') {
    return {
      tone: 'blocked',
      message: dependencyState.message || 'Missing a dependency before this node can run.',
      creditLabel,
      runNodeDisabled: true,
      runBranchDisabled: true,
      node,
    };
  }

  if (dependencyState.kind === 'queued') {
    return {
      tone: 'queued',
      message: dependencyState.message || 'An upstream node is still processing.',
      creditLabel,
      runNodeDisabled: true,
      runBranchDisabled: true,
      node,
    };
  }

  return {
    tone: 'ready',
    message: 'Ready to run with the current inputs.',
    creditLabel,
    runNodeDisabled: false,
    runBranchDisabled: false,
    node,
  };
}
