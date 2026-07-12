import {
  inspectWorkflowNodeDependencies,
  isRunnableNode,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowNodeDependencyState,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import type {
  CanvasAnchoredPopupPosition,
  PreviewMediaKind,
  WorkflowRunAffordance,
} from './workflowCanvasUiTypes';

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

export function getNodeAnchoredPopupPosition({
  canvasBounds,
  nodeBounds,
  popupWidth,
  popupHeight,
  gap = 14,
  horizontalPadding = 16,
  topPadding = 16,
}: {
  canvasBounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
  nodeBounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
  popupWidth: number;
  popupHeight: number;
  gap?: number;
  horizontalPadding?: number;
  topPadding?: number;
}): CanvasAnchoredPopupPosition {
  const canvasWidth = canvasBounds.width > 0 ? canvasBounds.width : 1280;
  const nodeCenterX = (nodeBounds.left - canvasBounds.left) + (nodeBounds.width / 2);
  const desiredLeft = nodeCenterX - (popupWidth / 2);
  const maxLeft = Math.max(horizontalPadding, canvasWidth - popupWidth - horizontalPadding);
  const left = Math.min(Math.max(horizontalPadding, desiredLeft), maxLeft);
  const desiredTop = (nodeBounds.top - canvasBounds.top) - popupHeight - gap;
  const top = Math.max(topPadding, desiredTop);
  const caretLeft = Math.min(Math.max(24, nodeCenterX - left), popupWidth - 24);

  return {
    left,
    top,
    width: popupWidth,
    caretLeft,
  };
}

export function getNodeLabel(nodes: WorkflowCanvasGraph['nodes'], nodeId: string): string {
  return nodes.find((node) => node.id === nodeId)?.data.title || 'Unknown node';
}

export function getNodePreviewKind(nodeType: WorkflowNodeKind): PreviewMediaKind {
  if (nodeType === 'image-input' || nodeType === 'image-generate' || nodeType === 'approval-gate') {
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
