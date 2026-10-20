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

  it('prices Run this step and Run from here beside each choice', () => {
    const graph = createStarterGraph();
    const node = graph.nodes.find((candidate) => candidate.type === 'video-generate')!;

    render(
      <WorkflowCanvasOverlays
        contextMenu={{ x: 120, y: 120, target: 'node', nodeId: node.id }}
        edges={graph.edges}
        nodes={graph.nodes}
        nodeRunStateById={{
          [node.id]: {
            canRunBranch: true,
            canRunNode: true,
            runBranchDisabled: false,
            runNodeDisabled: false,
            runNodePriceLabel: '30 credits',
            runBranchPriceLabel: 'about 54 credits',
            runPriceNote: 'A motion step is charged for its clip’s measured length.',
          },
        }}
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
        selection={{ nodeIds: [node.id], edgeIds: [] }}
        showSelectionHud={false}
      />
    );

    const contextMenu = screen.getByTestId('canvas-context-menu');
    expect(within(contextMenu).getByRole('button', { name: 'Run this step · 30 credits' })).toBeInTheDocument();
    expect(within(contextMenu).getByRole('button', { name: 'Run from here · about 54 credits' })).toBeInTheDocument();
    expect(within(contextMenu).getByText('A motion step is charged for its clip’s measured length.')).toBeInTheDocument();
  });

  // With node A's menu open, a right-click on node B or the pane lands on the menu's
  // full-window overlay. It closed on a click only, so the browser drew its own menu
  // over ours, which kept showing node A.
  it('closes on a right-click outside the menu and keeps the browser\'s menu away', () => {
    const graph = createStarterGraph();
    const node = graph.nodes[0];
    const onCloseContextMenu = vi.fn();

    render(
      <WorkflowCanvasOverlays
        contextMenu={{ x: 120, y: 120, target: 'node', nodeId: node.id }}
        edges={graph.edges}
        nodes={graph.nodes}
        nodeRunStateById={{}}
        onAddNote={vi.fn()}
        onClearSelection={vi.fn()}
        onCloseContextMenu={onCloseContextMenu}
        onClosePreview={vi.fn()}
        onDeleteSelection={vi.fn()}
        onEditNode={vi.fn()}
        onFitView={vi.fn()}
        onRunBranch={vi.fn()}
        onRunNode={vi.fn()}
        onSelectAll={vi.fn()}
        preview={null}
        selection={{ nodeIds: [node.id], edgeIds: [] }}
        showSelectionHud={false}
      />
    );

    const contextMenu = screen.getByTestId('canvas-context-menu');
    const overlay = contextMenu.parentElement!;

    // fireEvent returns false when the event's default was prevented: no browser menu.
    expect(fireEvent.contextMenu(within(contextMenu).getByRole('button', { name: /edit node/i }))).toBe(false);
    expect(onCloseContextMenu).not.toHaveBeenCalled();

    expect(fireEvent.contextMenu(overlay)).toBe(false);
    expect(onCloseContextMenu).toHaveBeenCalledTimes(1);
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
