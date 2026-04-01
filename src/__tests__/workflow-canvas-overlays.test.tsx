import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowCanvasOverlays } from '@/app/create-workflow/WorkflowCanvasOverlays';
import { createStarterGraph } from '@/lib/workflow-canvas';

describe('WorkflowCanvasOverlays', () => {
  it('shows edit and delete actions for a node context menu', () => {
    const graph = createStarterGraph();
    const node = graph.nodes[0];
    const onDeleteSelection = vi.fn();
    const onEditNode = vi.fn();
    const onRunBranch = vi.fn();

    render(
      <WorkflowCanvasOverlays
        contextMenu={{
          x: 120,
          y: 120,
          target: 'node',
          nodeId: node.id,
        }}
        edges={graph.edges}
        nodes={graph.nodes}
        nodeRunStateById={{
          [node.id]: {
            canRunBranch: true,
            canRunNode: false,
            runBranchDisabled: false,
            runNodeDisabled: false,
          },
        }}
        onAddNote={vi.fn()}
        onClearSelection={vi.fn()}
        onCloseContextMenu={vi.fn()}
        onClosePreview={vi.fn()}
        onDeleteSelection={onDeleteSelection}
        onEditNode={onEditNode}
        onFitView={vi.fn()}
        onRunBranch={onRunBranch}
        onRunNode={vi.fn()}
        onSelectAll={vi.fn()}
        preview={null}
        selection={{ nodeIds: [node.id], edgeIds: [] }}
        showSelectionHud={false}
      />
    );

    const contextMenu = screen.getByTestId('canvas-context-menu');
    expect(within(contextMenu).getByRole('button', { name: /edit node/i })).toBeInTheDocument();
    expect(within(contextMenu).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    expect(within(contextMenu).getByRole('button', { name: /run from here/i })).toBeInTheDocument();
    expect(within(contextMenu).queryByRole('button', { name: /run this step/i })).not.toBeInTheDocument();
    expect(within(contextMenu).queryByRole('button', { name: /duplicate/i })).not.toBeInTheDocument();

    fireEvent.click(within(contextMenu).getByRole('button', { name: /edit node/i }));
    expect(onEditNode).toHaveBeenCalledWith(node.id);

    fireEvent.click(within(contextMenu).getByRole('button', { name: /run from here/i }));
    expect(onRunBranch).toHaveBeenCalledWith(node.id);

    fireEvent.click(within(contextMenu).getByRole('button', { name: /^delete$/i }));
    expect(onDeleteSelection).toHaveBeenCalledTimes(1);
  });

  it('keeps the pane context menu focused on simple canvas actions', () => {
    const graph = createStarterGraph();

    render(
      <WorkflowCanvasOverlays
        contextMenu={{
          x: 120,
          y: 120,
          target: 'pane',
          flowPosition: { x: 200, y: 200 },
        }}
        edges={graph.edges}
        nodes={graph.nodes}
        nodeRunStateById={{}}
        onAddNote={vi.fn()}
        onClearSelection={vi.fn()}
        onCloseContextMenu={vi.fn()}
        onClosePreview={vi.fn()}
        onDeleteSelection={vi.fn()}
        onEditNode={vi.fn()}
        onFitView={vi.fn()}
        onRunBranch={vi.fn()}
        onRunNode={vi.fn()}
        onSelectAll={vi.fn()}
        preview={null}
        selection={{ nodeIds: [], edgeIds: [] }}
        showSelectionHud={false}
      />
    );

    const contextMenu = screen.getByTestId('canvas-context-menu');
    expect(within(contextMenu).getByRole('button', { name: /add note/i })).toBeInTheDocument();
    expect(within(contextMenu).getByRole('button', { name: /fit view/i })).toBeInTheDocument();
    expect(within(contextMenu).getByRole('button', { name: /select all/i })).toBeInTheDocument();
    expect(within(contextMenu).queryByRole('button', { name: /open ai builder/i })).not.toBeInTheDocument();
    expect(within(contextMenu).queryByRole('button', { name: /tidy layout/i })).not.toBeInTheDocument();
  });
});
