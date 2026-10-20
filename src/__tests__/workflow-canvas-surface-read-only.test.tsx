import { render } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowCanvasSurface } from '@/app/create-workflow/WorkflowCanvasSurface';
import { createStarterGraph } from '@/lib/workflow-canvas';

// What the Surface handed React Flow on its last render.
const flow = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    flow.props = props;
    return <div data-testid="reactflow-mock" />;
  },
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  BaseEdge: () => null,
  Controls: () => null,
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: 'left', Right: 'right' },
  SelectionMode: { Partial: 'partial', Full: 'full' },
  applyEdgeChanges: (_changes: unknown, current: unknown) => current,
  applyNodeChanges: (_changes: unknown, current: unknown) => current,
  getBezierPath: () => ['M0 0', 0, 0],
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: null }),
}));

function renderSurface(isReadOnly: boolean) {
  const graph = createStarterGraph();
  const menuHandlers = {
    onEdgeContextMenu: vi.fn(),
    onNodeContextMenu: vi.fn(),
    onPaneContextMenu: vi.fn(),
  };

  render(
    <WorkflowCanvasSurface
      canvasSectionRef={createRef<HTMLElement>()}
      contextMenu={null}
      edges={graph.edges}
      error={null}
      isReadOnly={isReadOnly}
      nodeActionRuntimeById={{}}
      nodeRunStateById={{}}
      onAddNote={vi.fn()}
      onClearSelection={vi.fn()}
      onCloseContextMenu={vi.fn()}
      onClosePreview={vi.fn()}
      onCommitNodePositions={vi.fn()}
      onConnect={vi.fn()}
      onDeleteSelection={vi.fn()}
      onDeleteEdge={vi.fn()}
      onEditNode={vi.fn()}
      onEdgeClick={vi.fn()}
      onEdgeContextMenu={menuHandlers.onEdgeContextMenu}
      onFitView={vi.fn()}
      onMoveEnd={vi.fn()}
      onNodeClick={vi.fn()}
      onNodeContextMenu={menuHandlers.onNodeContextMenu}
      onNodeDoubleClick={vi.fn()}
      onNodeDragStart={vi.fn()}
      onOpenPreview={vi.fn()}
      onPaneClick={vi.fn()}
      onPaneContextMenu={menuHandlers.onPaneContextMenu}
      onRunBranch={vi.fn()}
      onRunNode={vi.fn()}
      onSelectAll={vi.fn()}
      onSelectionChange={vi.fn()}
      previewMedia={null}
      renderNodes={graph.nodes}
      selection={{ nodeIds: [], edgeIds: [] }}
      setReactFlowInstance={vi.fn()}
    />
  );

  return menuHandlers;
}

// The editor hands the Surface no context menu to draw while an AI Builder proposal
// is previewed (isReadOnly). The pane's handler was the one still wired then: a
// right-click on the pane stored a menu nothing showed, and it came up at the old
// pointer once the proposal was dismissed.
describe('WorkflowCanvasSurface', () => {
  it('hands React Flow every context menu handler while the canvas is editable', () => {
    const menuHandlers = renderSurface(false);

    expect(flow.props?.onPaneContextMenu).toBe(menuHandlers.onPaneContextMenu);
    expect(flow.props?.onNodeContextMenu).toBe(menuHandlers.onNodeContextMenu);
    expect(flow.props?.onEdgeContextMenu).toBe(menuHandlers.onEdgeContextMenu);
  });

  it('hands React Flow no context menu handler, the pane\'s included, while a proposal is previewed', () => {
    renderSurface(true);

    expect(flow.props?.onPaneContextMenu).toBeUndefined();
    expect(flow.props?.onNodeContextMenu).toBeUndefined();
    expect(flow.props?.onEdgeContextMenu).toBeUndefined();
  });
});
