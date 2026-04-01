'use client';

import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import type { WorkflowCanvasEdge, WorkflowCanvasNode } from '@/lib/workflow-canvas';
import type { CanvasContextMenuState, CanvasSelectionState } from './workflowCanvasUiTypes';

interface UseWorkflowCanvasContextMenuOptions {
  reactFlowInstance: ReactFlowInstance | null;
  selection: CanvasSelectionState;
  setManualSelection: (selection: CanvasSelectionState) => void;
}

export function useWorkflowCanvasContextMenu({
  reactFlowInstance,
  selection,
  setManualSelection,
}: UseWorkflowCanvasContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const resetCanvasTransientUi = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handlePaneContextMenu = useCallback((event: MouseEvent | ReactMouseEvent) => {
    event.preventDefault();
    const flowPosition = reactFlowInstance?.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'pane',
      flowPosition: flowPosition ?? undefined,
    });
  }, [reactFlowInstance]);

  const handleNodeContextMenu = useCallback((event: ReactMouseEvent, node: WorkflowCanvasNode) => {
    event.preventDefault();
    event.stopPropagation();

    if (!selection.nodeIds.includes(node.id)) {
      setManualSelection({ nodeIds: [node.id], edgeIds: [] });
    }

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'node',
      nodeId: node.id,
    });
  }, [selection.nodeIds, setManualSelection]);

  const handleEdgeClick = useCallback((event: ReactMouseEvent, edge: WorkflowCanvasEdge) => {
    event.preventDefault();
    event.stopPropagation();

    setManualSelection({ nodeIds: [], edgeIds: [edge.id] });
    setContextMenu(null);
  }, [setManualSelection]);

  const handleEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: WorkflowCanvasEdge) => {
    event.preventDefault();
    event.stopPropagation();

    if (!selection.edgeIds.includes(edge.id)) {
      setManualSelection({ nodeIds: [], edgeIds: [edge.id] });
    }

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'edge',
      edgeId: edge.id,
    });
  }, [selection.edgeIds, setManualSelection]);

  return {
    closeContextMenu,
    contextMenu,
    handleEdgeClick,
    handleEdgeContextMenu,
    handleNodeContextMenu,
    handlePaneContextMenu,
    resetCanvasTransientUi,
  };
}
