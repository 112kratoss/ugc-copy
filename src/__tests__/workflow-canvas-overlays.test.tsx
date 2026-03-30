import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowCanvasOverlays } from '@/app/create-workflow/WorkflowCanvasOverlays';
import { createStarterGraph } from '@/lib/workflow-canvas';

describe('WorkflowCanvasOverlays', () => {
  it('shows blocked run affordances inside the node context menu', () => {
    const graph = createStarterGraph();
    const blockedNode = graph.nodes.find((node) => node.data.title === 'Video generator');

    expect(blockedNode).toBeTruthy();
    if (!blockedNode) {
      return;
    }

    render(
      <WorkflowCanvasOverlays
        contextMenu={{
          x: 120,
          y: 120,
          target: 'node',
          nodeId: blockedNode.id,
        }}
        edges={graph.edges}
        nodeRunAffordance={{
          tone: 'blocked',
          message: 'Image input has no image output yet.',
          creditLabel: '25 credits available • Cost varies by model',
          runNodeDisabled: true,
          runBranchDisabled: true,
          node: blockedNode,
        }}
        nodes={graph.nodes}
        onAddNote={vi.fn()}
        onClearSelection={vi.fn()}
        onCloseContextMenu={vi.fn()}
        onClosePreview={vi.fn()}
        onDeleteSelection={vi.fn()}
        onDuplicateSelection={vi.fn()}
        onFitView={vi.fn()}
        onOpenPlanner={vi.fn()}
        onRunBranch={vi.fn()}
        onRunNode={vi.fn()}
        onSelectAll={vi.fn()}
        preview={null}
        selection={{ nodeIds: [blockedNode.id], edgeIds: [] }}
        showSelectionHud={false}
      />
    );

    const contextMenu = screen.getByTestId('canvas-context-menu');
    expect(contextMenu).toHaveTextContent('Image input has no image output yet.');
    expect(contextMenu).toHaveTextContent('25 credits available');

    expect(within(contextMenu).getByRole('button', { name: /^run node$/i })).toBeDisabled();
    expect(within(contextMenu).getByRole('button', { name: /run from here/i })).toBeDisabled();
    expect(within(contextMenu).getByRole('button', { name: /duplicate/i })).toBeInTheDocument();
  });
});
