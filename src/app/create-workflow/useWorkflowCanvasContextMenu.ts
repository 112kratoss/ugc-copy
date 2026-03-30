'use client';

import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import type { WorkflowCanvasEdge, WorkflowCanvasNode, WorkflowNodeKind } from '@/lib/workflow-canvas';
import type {
  CanvasContextMenuState,
  CanvasFloatingPosition,
  CanvasSelectionState,
} from './workflowCanvasUiTypes';
import { getCanvasFloatingPosition } from './workflowCanvasUiUtils';

interface UseWorkflowCanvasContextMenuOptions {
  canvasSectionRef: RefObject<HTMLElement | null>;
  reactFlowInstance: ReactFlowInstance | null;
  nodes: WorkflowCanvasNode[];
  selection: CanvasSelectionState;
  selectedEdge: WorkflowCanvasEdge | null;
  selectedKind: WorkflowNodeKind | undefined;
  selectedNode: WorkflowCanvasNode | null;
  setManualSelection: (selection: CanvasSelectionState) => void;
}

export function useWorkflowCanvasContextMenu({
  canvasSectionRef,
  reactFlowInstance,
  nodes,
  selection,
  selectedEdge,
  selectedKind,
  selectedNode,
  setManualSelection,
}: UseWorkflowCanvasContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [edgeFloatingPosition, setEdgeFloatingPosition] = useState<CanvasFloatingPosition | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const clearEdgeFloatingEditor = useCallback(() => {
    setEdgeFloatingPosition(null);
  }, []);

  const resetCanvasTransientUi = useCallback(() => {
    setContextMenu(null);
    setEdgeFloatingPosition(null);
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
    setEdgeFloatingPosition(null);

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

    const canvasBounds = canvasSectionRef.current?.getBoundingClientRect();
    if (!canvasBounds) {
      setEdgeFloatingPosition(null);
      return;
    }

    setEdgeFloatingPosition(getCanvasFloatingPosition({
      canvasBounds,
      clientX: event.clientX,
      clientY: event.clientY,
      panelWidth: 320,
      panelHeight: 180,
    }));
  }, [canvasSectionRef, setManualSelection]);

  const handleEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: WorkflowCanvasEdge) => {
    event.preventDefault();
    event.stopPropagation();

    if (!selection.edgeIds.includes(edge.id)) {
      setManualSelection({ nodeIds: [], edgeIds: [edge.id] });
    }

    const canvasBounds = canvasSectionRef.current?.getBoundingClientRect();
    if (canvasBounds) {
      setEdgeFloatingPosition(getCanvasFloatingPosition({
        canvasBounds,
        clientX: event.clientX,
        clientY: event.clientY,
        panelWidth: 320,
        panelHeight: 180,
      }));
    }

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'edge',
      edgeId: edge.id,
    });
  }, [canvasSectionRef, selection.edgeIds, setManualSelection]);

  const editorPosition = useMemo(() => {
    if (!selectedNode || !canvasSectionRef.current) {
      return null;
    }

    const canvasBounds = canvasSectionRef.current.getBoundingClientRect();
    const node = reactFlowInstance?.getNode(selectedNode.id);
    const screenPosition = reactFlowInstance
      ? reactFlowInstance.flowToScreenPosition(selectedNode.position)
      : {
          x: canvasBounds.left + selectedNode.position.x,
          y: canvasBounds.top + selectedNode.position.y,
        };
    const nodeWidth = node?.width ?? selectedNode.width ?? 260;
    const panelWidth = selectedKind === 'voiceover-generate' ? 430 : 390;
    const panelHeight = selectedKind === 'voiceover-generate' ? 680 : 620;

    let left = screenPosition.x - canvasBounds.left + nodeWidth + 18;
    let top = screenPosition.y - canvasBounds.top - 12;

    if (left + panelWidth > canvasBounds.width - 16) {
      left = Math.max(16, screenPosition.x - canvasBounds.left - panelWidth - 18);
    }

    if (top + panelHeight > canvasBounds.height - 16) {
      top = Math.max(16, canvasBounds.height - panelHeight - 16);
    }

    return {
      left: Math.max(16, left),
      top: Math.max(16, top),
      width: panelWidth,
    };
  }, [canvasSectionRef, reactFlowInstance, selectedKind, selectedNode]);

  const edgeEditorPosition = useMemo<CanvasFloatingPosition | null>(() => {
    if (!selectedEdge || !canvasSectionRef.current) {
      return null;
    }

    if (edgeFloatingPosition) {
      return edgeFloatingPosition;
    }

    const sourceNode = nodes.find((node) => node.id === selectedEdge.source);
    const targetNode = nodes.find((node) => node.id === selectedEdge.target);
    const canvasBounds = canvasSectionRef.current.getBoundingClientRect();

    if (!sourceNode || !targetNode) {
      return {
        left: 16,
        top: 96,
        width: 320,
      };
    }

    const sourceWidth = sourceNode.width ?? 240;
    const sourceHeight = sourceNode.height ?? 140;
    const targetHeight = targetNode.height ?? 140;
    const sourcePoint = reactFlowInstance
      ? reactFlowInstance.flowToScreenPosition({
          x: sourceNode.position.x + sourceWidth,
          y: sourceNode.position.y + sourceHeight / 2,
        })
      : {
          x: canvasBounds.left + sourceNode.position.x + sourceWidth,
          y: canvasBounds.top + sourceNode.position.y + sourceHeight / 2,
        };
    const targetPoint = reactFlowInstance
      ? reactFlowInstance.flowToScreenPosition({
          x: targetNode.position.x,
          y: targetNode.position.y + targetHeight / 2,
        })
      : {
          x: canvasBounds.left + targetNode.position.x,
          y: canvasBounds.top + targetNode.position.y + targetHeight / 2,
        };

    return getCanvasFloatingPosition({
      canvasBounds,
      clientX: (sourcePoint.x + targetPoint.x) / 2,
      clientY: (sourcePoint.y + targetPoint.y) / 2,
      panelWidth: 320,
      panelHeight: 180,
    });
  }, [canvasSectionRef, edgeFloatingPosition, nodes, reactFlowInstance, selectedEdge]);

  return {
    clearEdgeFloatingEditor,
    closeContextMenu,
    contextMenu,
    edgeEditorPosition,
    editorPosition,
    handleEdgeClick,
    handleEdgeContextMenu,
    handleNodeContextMenu,
    handlePaneContextMenu,
    resetCanvasTransientUi,
  };
}
