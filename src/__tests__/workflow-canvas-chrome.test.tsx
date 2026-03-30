import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowCanvasChrome } from '@/app/create-workflow/WorkflowCanvasChrome';
import { createStarterGraph } from '@/lib/workflow-canvas';

describe('WorkflowCanvasChrome', () => {
  it('shows blocked run affordances and disables run actions for the selected node', () => {
    const graph = createStarterGraph();
    const blockedNode = graph.nodes.find((node) => node.data.title === 'Video generator');

    expect(blockedNode).toBeTruthy();
    if (!blockedNode) {
      return;
    }

    const onRunNode = vi.fn();
    const onRunBranch = vi.fn();

    render(
      <WorkflowCanvasChrome
        activeCanvasId="canvas-1"
        canvasTitle="Workflow canvas"
        canvases={[{
          id: 'canvas-1',
          title: 'Workflow canvas',
          updated_at: '2026-03-22T00:00:00.000Z',
          revision: 0,
        }]}
        hasSelectedNode
        hasNodeSelection
        isCanvasTransitionPending={false}
        nodeLibrary={[]}
        onAddNode={vi.fn()}
        onCanvasTitleBlur={vi.fn()}
        onCanvasTitleChange={vi.fn()}
        onCreateCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onDeleteSelection={vi.fn()}
        onDuplicateSelection={vi.fn()}
        onOpenPlanner={vi.fn()}
        onRunBranch={onRunBranch}
        onRunNode={onRunNode}
        onSave={vi.fn()}
        onSelectCanvas={vi.fn()}
        runAffordance={{
          tone: 'blocked',
          message: 'Image input has no image output yet.',
          creditLabel: '25 credits available • Cost varies by model',
          runNodeDisabled: true,
          runBranchDisabled: true,
          node: blockedNode,
        }}
        saveState="saved"
        selectionCount={1}
      >
        <div>Canvas</div>
      </WorkflowCanvasChrome>
    );

    expect(screen.getByText(/image input has no image output yet/i)).toBeInTheDocument();
    expect(screen.getByText(/25 credits available/i)).toBeInTheDocument();

    const runNodeButton = screen.getByRole('button', { name: /^run node$/i });
    const runBranchButton = screen.getByRole('button', { name: /run from here/i });

    expect(runNodeButton).toBeDisabled();
    expect(runBranchButton).toBeDisabled();

    fireEvent.click(runNodeButton);
    fireEvent.click(runBranchButton);

    expect(onRunNode).not.toHaveBeenCalled();
    expect(onRunBranch).not.toHaveBeenCalled();
  });
});
