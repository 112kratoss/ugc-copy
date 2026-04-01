'use client';

import { startTransition, useCallback, useMemo, useState } from 'react';

import {
  createNodeRunState,
  normalizeNodeData,
  type WorkflowCanvasNode,
  type WorkflowCanvasRunRecord,
  type WorkflowNodeKind,
  type WorkflowNodeRunState,
} from '@/lib/workflow-canvas';

export type WorkflowRunStateOverlayByNodeId = Record<string, WorkflowNodeRunState>;

function areRunStatesEqual(left: WorkflowNodeRunState, right: WorkflowNodeRunState): boolean {
  return (
    left.status === right.status &&
    left.generationId === right.generationId &&
    left.outputUrl === right.outputUrl &&
    left.error === right.error &&
    left.cost === right.cost &&
    left.updatedAt === right.updatedAt
  );
}

function createRunStateFromStep(
  node: WorkflowCanvasNode,
  step: NonNullable<WorkflowCanvasRunRecord['steps']>[number]
): WorkflowNodeRunState {
  const outputSnapshot = (step.output_snapshot as { outputUrl?: string | null; cost?: number | null } | null) ?? null;

  return createNodeRunState({
    ...node.data.runState,
    status: step.status as WorkflowNodeRunState['status'],
    generationId: step.generation_id,
    outputUrl: outputSnapshot?.outputUrl || node.data.runState.outputUrl,
    cost: outputSnapshot?.cost ?? node.data.runState.cost,
    error: step.error_message,
    updatedAt: step.finished_at || step.started_at,
  });
}

export function mergePersistedRunStateIntoNodes(
  currentNodes: WorkflowCanvasNode[],
  persistedNodes: WorkflowCanvasNode[]
): WorkflowCanvasNode[] {
  const persistedNodeMap = new Map(persistedNodes.map((node) => [node.id, node]));
  let changed = false;

  const nextNodes = currentNodes.map((node) => {
    const persistedNode = persistedNodeMap.get(node.id);
    const nextRunState = persistedNode && persistedNode.type === node.type
      ? createNodeRunState(persistedNode.data.runState)
      : createNodeRunState();

    if (areRunStatesEqual(node.data.runState, nextRunState)) {
      return node;
    }

    changed = true;
    return {
      ...node,
      data: normalizeNodeData(node.type as WorkflowNodeKind, {
        ...node.data,
        runState: nextRunState,
      }),
    };
  });

  return changed ? nextNodes : currentNodes;
}

export function mergeWorkflowRunIntoNodes(
  currentNodes: WorkflowCanvasNode[],
  run: WorkflowCanvasRunRecord
): WorkflowCanvasNode[] {
  if (!Array.isArray(run.steps) || run.steps.length === 0) {
    return currentNodes;
  }

  let changed = false;

  const nextNodes = currentNodes.map((node) => {
    const step = run.steps?.find((candidate) => candidate.node_id === node.id);
    if (!step) {
      return node;
    }

    const nextRunState = createRunStateFromStep(node, step);
    if (areRunStatesEqual(node.data.runState, nextRunState)) {
      return node;
    }

    changed = true;
    return {
      ...node,
      data: normalizeNodeData(node.type as WorkflowNodeKind, {
        ...node.data,
        runState: nextRunState,
      }),
    };
  });

  if (changed) {
    return nextNodes;
  }

  return currentNodes;
}

export function useWorkflowCanvasRunState(nodes: WorkflowCanvasNode[]) {
  const [runStateOverlayByNodeId, setRunStateOverlayByNodeId] = useState<WorkflowRunStateOverlayByNodeId>({});

  const clearRunStateOverlay = useCallback(() => {
    startTransition(() => {
      setRunStateOverlayByNodeId({});
    });
  }, []);

  const applyRunUpdate = useCallback((run: WorkflowCanvasRunRecord) => {
    if (!Array.isArray(run.steps) || run.steps.length === 0) {
      return;
    }

    const nodeMap = new Map(nodes.map((node) => [node.id, node]));

    startTransition(() => {
      setRunStateOverlayByNodeId((current) => {
        let changed = false;
        const next = { ...current };

        run.steps?.forEach((step) => {
          const node = nodeMap.get(step.node_id);
          if (!node) {
            return;
          }

          const nextRunState = createRunStateFromStep(node, step);
          const currentRunState = current[step.node_id];

          if (currentRunState && areRunStatesEqual(currentRunState, nextRunState)) {
            return;
          }

          next[step.node_id] = nextRunState;
          changed = true;
        });

        return changed ? next : current;
      });
    });
  }, [nodes]);

  const renderNodes = useMemo(() => {
    return nodes.map((node) => {
      const overlayRunState = runStateOverlayByNodeId[node.id];
      if (!overlayRunState || areRunStatesEqual(node.data.runState, overlayRunState)) {
        return node;
      }

      return {
        ...node,
        data: normalizeNodeData(node.type as WorkflowNodeKind, {
          ...node.data,
          runState: overlayRunState,
        }),
      };
    });
  }, [nodes, runStateOverlayByNodeId]);

  return {
    applyRunUpdate,
    clearRunStateOverlay,
    renderNodes,
    runStateOverlayByNodeId,
  };
}
