import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  mergePersistedRunStateIntoNodes,
  useWorkflowCanvasRunState,
} from '@/app/create-workflow/useWorkflowCanvasRunState';
import {
  createStarterGraph,
  createTemplateReadyStarterGraph,
  type WorkflowCanvasNode,
  type WorkflowCanvasRunRecord,
} from '@/lib/workflow-canvas';

function RunStateHarness({
  nodes,
  onRender,
}: {
  nodes: WorkflowCanvasNode[];
  onRender: (state: ReturnType<typeof useWorkflowCanvasRunState>) => void;
}) {
  const state = useWorkflowCanvasRunState(nodes);
  onRender(state);
  return null;
}

describe('useWorkflowCanvasRunState', () => {
  it('keeps untouched node identity while overlaying run updates onto changed nodes', async () => {
    const starter = createStarterGraph();
    const [firstNode, secondNode] = starter.nodes;
    let latestState: ReturnType<typeof useWorkflowCanvasRunState> | null = null;
    const getLatestState = () => {
      if (!latestState) {
        throw new Error('Run state hook did not render');
      }

      return latestState;
    };

    render(
      <RunStateHarness
        nodes={starter.nodes}
        onRender={(state) => {
          latestState = state;
        }}
      />
    );

    expect(getLatestState().renderNodes[0]).toBe(firstNode);
    expect(getLatestState().renderNodes[1]).toBe(secondNode);

    const run: WorkflowCanvasRunRecord = {
      id: 'run-1',
      canvas_id: 'canvas-1',
      start_node_id: firstNode.id,
      mode: 'node',
      status: 'processing',
      created_at: '2026-03-30T04:00:00.000Z',
      finished_at: null,
      steps: [{
        id: 'step-1',
        node_id: firstNode.id,
        status: 'processing',
        generation_id: 'gen-1',
        input_snapshot: null,
        output_snapshot: null,
        error_message: null,
        started_at: '2026-03-30T04:00:02.000Z',
        finished_at: null,
      }],
    };

    await act(async () => {
      getLatestState().applyRunUpdate(run);
      await Promise.resolve();
    });

    expect(getLatestState().renderNodes[0]).not.toBe(firstNode);
    expect(getLatestState().renderNodes[1]).toBe(secondNode);
    expect(getLatestState().renderNodes[0].data.runState.status).toBe('processing');
    expect(firstNode.data.runState.status).toBe('idle');

    await act(async () => {
      getLatestState().clearRunStateOverlay();
      await Promise.resolve();
    });

    expect(getLatestState().renderNodes[0]).toBe(firstNode);
  });

  it('merges persisted run state back into canonical nodes without changing untouched nodes', () => {
    const starter = createStarterGraph();
    const persistedNodes: WorkflowCanvasNode[] = starter.nodes.map((node, index) => (
      index === 0
        ? {
            ...node,
            data: {
              ...node.data,
              runState: {
                ...node.data.runState,
                status: 'succeeded' as const,
                outputUrl: 'generated_images/user-1/run-1.jpg',
              },
            },
          }
        : node
    ));

    const merged = mergePersistedRunStateIntoNodes(starter.nodes, persistedNodes);

    expect(merged[0]).not.toBe(starter.nodes[0]);
    expect(merged[1]).toBe(starter.nodes[1]);
    expect(merged[0].data.runState.status).toBe('succeeded');
    expect(starter.nodes[0].data.runState.status).toBe('idle');
  });

  it('uses a pending approval output for preview while the checkpoint is paused', async () => {
    const graph = createTemplateReadyStarterGraph();
    const approval = graph.nodes.find((node) => node.type === 'approval-gate');
    expect(approval).toBeTruthy();
    let latestState: ReturnType<typeof useWorkflowCanvasRunState> | null = null;

    render(
      <RunStateHarness
        nodes={graph.nodes}
        onRender={(state) => {
          latestState = state;
        }}
      />
    );

    const run: WorkflowCanvasRunRecord = {
      id: 'run-approval',
      canvas_id: 'canvas-1',
      start_node_id: approval!.id,
      mode: 'branch',
      status: 'awaiting_approval',
      created_at: '2026-07-11T12:00:00.000Z',
      finished_at: null,
      steps: [{
        id: 'step-approval',
        node_id: approval!.id,
        status: 'awaiting_approval',
        generation_id: null,
        input_snapshot: null,
        output_snapshot: { pendingOutputUrl: 'generated_images/user/review.jpg' },
        error_message: null,
        started_at: '2026-07-11T12:00:01.000Z',
        finished_at: null,
      }],
    };

    await act(async () => {
      latestState!.applyRunUpdate(run);
      await Promise.resolve();
    });

    const renderedApproval = latestState!.renderNodes.find((node) => node.id === approval!.id);
    expect(renderedApproval?.data.runState).toMatchObject({
      status: 'awaiting_approval',
      outputUrl: 'generated_images/user/review.jpg',
    });
  });
});
