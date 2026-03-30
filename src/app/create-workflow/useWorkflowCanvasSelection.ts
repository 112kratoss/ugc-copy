'use client';

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { WorkflowCanvasEdge, WorkflowCanvasNode } from '@/lib/workflow-canvas';
import type { CanvasSelectionState } from './workflowCanvasUiTypes';
import { areStringArraysEqual } from './workflowCanvasUiUtils';

interface UseWorkflowCanvasSelectionOptions {
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  setNodes: Dispatch<SetStateAction<WorkflowCanvasNode[]>>;
  setEdges: Dispatch<SetStateAction<WorkflowCanvasEdge[]>>;
}

function updateNodeSelectionState(
  current: WorkflowCanvasNode[],
  nodeIdSet: Set<string>
) {
  let changed = false;
  const next = current.map((node) => {
    const nextSelected = nodeIdSet.has(node.id);
    if (node.selected === nextSelected) {
      return node;
    }

    changed = true;
    return {
      ...node,
      selected: nextSelected,
    };
  });

  return changed ? next : current;
}

function updateEdgeSelectionState(
  current: WorkflowCanvasEdge[],
  edgeIdSet: Set<string>
) {
  let changed = false;
  const next = current.map((edge) => {
    const nextSelected = edgeIdSet.has(edge.id);
    if (edge.selected === nextSelected) {
      return edge;
    }

    changed = true;
    return {
      ...edge,
      selected: nextSelected,
    };
  });

  return changed ? next : current;
}

export function useWorkflowCanvasSelection({
  nodes,
  edges,
  setNodes,
  setEdges,
}: UseWorkflowCanvasSelectionOptions) {
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);

  const setManualSelection = useCallback((nextSelection: CanvasSelectionState) => {
    const nodeIdSet = new Set(nextSelection.nodeIds);
    const edgeIdSet = new Set(nextSelection.edgeIds);

    setNodes((current) => updateNodeSelectionState(current, nodeIdSet));
    setEdges((current) => updateEdgeSelectionState(current, edgeIdSet));
    setSelectedNodeIds((current) => (
      areStringArraysEqual(current, nextSelection.nodeIds) ? current : nextSelection.nodeIds
    ));
    setSelectedEdgeIds((current) => (
      areStringArraysEqual(current, nextSelection.edgeIds) ? current : nextSelection.edgeIds
    ));
  }, [setEdges, setNodes]);

  const syncSelectionFromCanvas = useCallback((nextSelection: CanvasSelectionState) => {
    setSelectedNodeIds((current) => (
      areStringArraysEqual(current, nextSelection.nodeIds) ? current : nextSelection.nodeIds
    ));
    setSelectedEdgeIds((current) => (
      areStringArraysEqual(current, nextSelection.edgeIds) ? current : nextSelection.edgeIds
    ));
  }, []);

  const clearSelection = useCallback(() => {
    setManualSelection({ nodeIds: [], edgeIds: [] });
  }, [setManualSelection]);

  const resetSelection = useCallback(() => {
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
  }, []);

  const selection = useMemo<CanvasSelectionState>(() => ({
    nodeIds: selectedNodeIds,
    edgeIds: selectedEdgeIds,
  }), [selectedEdgeIds, selectedNodeIds]);

  const selectionCount = selectedNodeIds.length + selectedEdgeIds.length;

  const selectAllElements = useCallback(() => {
    setManualSelection({
      nodeIds: nodes.map((node) => node.id),
      edgeIds: edges.map((edge) => edge.id),
    });
  }, [edges, nodes, setManualSelection]);

  return {
    clearSelection,
    resetSelection,
    selectAllElements,
    selectedEdgeIds,
    selectedNodeIds,
    selection,
    selectionCount,
    setManualSelection,
    syncSelectionFromCanvas,
  };
}
