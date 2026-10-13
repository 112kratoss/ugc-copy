import type { ComponentType } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workflowCanvasEdgeTypes, workflowCanvasNodeTypes } from '@/app/create-workflow/WorkflowCanvasNodes';
import { createStarterGraph, createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';

vi.mock('@xyflow/react', async () => {
  const React = await import('react');

  return {
    BaseEdge: ({
      id,
      markerEnd,
      path,
    }: {
      id: string;
      markerEnd?: string;
      path: string;
    }) => <path data-testid={`workflow-base-edge-${id}`} d={path} markerEnd={markerEnd} />,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Handle: ({
      id,
      position,
      style,
      type,
    }: {
      id?: string;
      position?: string;
      style?: React.CSSProperties;
      type?: string;
    }) => (
      <div
        data-testid={`workflow-handle-${type}-${id}`}
        data-position={position}
        style={style}
      />
    ),
    Position: { Left: 'left', Right: 'right' },
    getBezierPath: () => ['M0 0 C 24 0 72 40 120 40', 60, 20],
  };
});

describe('WorkflowCanvasNodes edge controls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the centered delete button on hover and keeps it visible while moving onto the button', () => {
    const onDeleteEdge = vi.fn();
    const WorkflowEdge = workflowCanvasEdgeTypes.workflow as unknown as ComponentType<Record<string, unknown>>;

    render(
      <div className="relative">
        <svg>
          <g>
            <WorkflowEdge
              id="edge-1"
              sourceX={0}
              sourceY={0}
              targetX={120}
              targetY={40}
              markerEnd="url(#marker)"
              style={{ stroke: '#22c55e', strokeWidth: 2 }}
              data={{ onDeleteEdge }}
            />
          </g>
        </svg>
      </div>
    );

    const hoverZone = screen.getByTestId('workflow-edge-hover-zone-edge-1');
    expect(screen.queryByTestId('workflow-edge-delete-edge-1')).not.toBeInTheDocument();

    fireEvent.mouseEnter(hoverZone);
    const deleteButton = screen.getByTestId('workflow-edge-delete-edge-1');
    expect(deleteButton).toBeInTheDocument();

    fireEvent.mouseLeave(hoverZone);
    fireEvent.mouseEnter(deleteButton);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.getByTestId('workflow-edge-delete-edge-1')).toBeInTheDocument();

    fireEvent.click(deleteButton);
    expect(onDeleteEdge).toHaveBeenCalledWith('edge-1');

    fireEvent.mouseLeave(deleteButton);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.queryByTestId('workflow-edge-delete-edge-1')).not.toBeInTheDocument();
  });

  it('shows hover play and delete actions for run-capable nodes', () => {
    const graph = createStarterGraph();
    const node = graph.nodes.find((candidate) => candidate.type === 'video-generate');
    expect(node).toBeTruthy();

    const onDeleteNode = vi.fn();
    const onOpenRunMenu = vi.fn();
    const WorkflowNode = workflowCanvasNodeTypes['video-generate'] as unknown as ComponentType<Record<string, unknown>>;

    render(
      <WorkflowNode
        id={node?.id}
        data={{
          ...node?.data,
          __runtime: {
            showPlayControl: true,
            onDeleteNode,
            onOpenRunMenu,
          },
        }}
        dragging={false}
      />
    );

    const nodeShell = screen.getByText(node?.data.title || '').closest('.workflow-canvas-node-shell');
    expect(nodeShell).toBeTruthy();
    expect(screen.queryByTestId('workflow-node-action-play')).not.toBeInTheDocument();

    fireEvent.mouseEnter(nodeShell!);
    expect(screen.getByTestId('workflow-node-action-play')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-action-delete')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workflow-node-action-play'));
    expect(onOpenRunMenu).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('workflow-node-action-delete'));
    expect(onDeleteNode).toHaveBeenCalledTimes(1);
  });

  // The menu opens upward from its button; with a message and a note it ran under the canvas's
  // sticky header, where its buttons could not be pressed. jsdom lays nothing out, so the rects
  // are given: the header's bottom edge, the button's top, the menu's height.
  it('opens the run menu below its button when the room above ends at the canvas header', () => {
    const header = document.createElement('div');
    header.setAttribute('data-testid', 'workflow-canvas-header');
    document.body.appendChild(header);
    let buttonTop = 90;
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, width: 240, height, top, left: 0, right: 240, bottom: top + height, toJSON: () => ({}),
    });
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === header) return rect(0, 64);
      if (this.getAttribute('data-testid') === 'workflow-node-run-menu') return rect(buttonTop - 150, 150);
      return rect(buttonTop, 32);
    });
    const graph = createStarterGraph();
    const node = graph.nodes.find((candidate) => candidate.type === 'video-generate');
    const WorkflowNode = workflowCanvasNodeTypes['video-generate'] as unknown as ComponentType<Record<string, unknown>>;
    const runtime = {
      showPlayControl: true,
      isRunMenuOpen: true,
      onRunNode: vi.fn(),
      onRunBranch: vi.fn(),
      runNodePriceLabel: 'Cost unavailable',
      runBranchPriceLabel: 'Cost unavailable',
      runMessage: 'Ready to run with the current inputs.',
      runPriceNote: 'Unauthorized',
    };

    try {
      const { rerender } = render(<WorkflowNode id={node?.id} data={{ ...node?.data, __runtime: runtime }} dragging={false} />);
      // 90 above the button, a 150 menu: it would end 60 above the page, under the 64 header.
      expect(screen.getByTestId('workflow-node-run-menu')).toHaveAttribute('data-placement', 'below');

      // Lower on the canvas there is room, and a note no longer sends it under the header.
      buttonTop = 400;
      rerender(<WorkflowNode id={node?.id} data={{ ...node?.data, __runtime: { ...runtime, runPriceNote: null } }} dragging={false} />);
      expect(screen.getByTestId('workflow-node-run-menu')).toHaveAttribute('data-placement', 'above');
    } finally {
      rects.mockRestore();
      header.remove();
    }
  });

  it('prices both run choices in the open run menu and says why one has no price', () => {
    const graph = createStarterGraph();
    const node = graph.nodes.find((candidate) => candidate.type === 'video-generate');
    expect(node).toBeTruthy();
    const onRunNode = vi.fn();
    const WorkflowNode = workflowCanvasNodeTypes['video-generate'] as unknown as ComponentType<Record<string, unknown>>;

    render(
      <WorkflowNode
        id={node?.id}
        data={{
          ...node?.data,
          __runtime: {
            showPlayControl: true,
            isRunMenuOpen: true,
            onRunNode,
            onRunBranch: vi.fn(),
            runNodePriceLabel: '30 credits',
            runBranchPriceLabel: 'Cost unavailable',
            runPriceNote: 'Audio steps are priced when they start.',
          },
        }}
        dragging={false}
      />
    );

    const runNode = screen.getByTestId('workflow-node-run-node');
    expect(runNode).toHaveTextContent('Run this step · 30 credits');
    expect(runNode).toHaveAccessibleName('Run this step · 30 credits');
    expect(screen.getByTestId('workflow-node-run-branch')).toHaveAccessibleName('Run from here · Cost unavailable');
    expect(screen.getByText('Audio steps are priced when they start.')).toBeInTheDocument();

    fireEvent.click(runNode);
    expect(onRunNode).toHaveBeenCalledTimes(1);
  });

  it('shows only delete for note-style nodes', () => {
    const graph = createStarterGraph();
    const node = graph.nodes.find((candidate) => candidate.type === 'note');
    expect(node).toBeTruthy();

    const WorkflowNode = workflowCanvasNodeTypes.note as unknown as ComponentType<Record<string, unknown>>;

    render(
      <WorkflowNode
        id={node?.id}
        data={{
          ...node?.data,
          __runtime: {
            showPlayControl: false,
            onDeleteNode: vi.fn(),
          },
        }}
        dragging={false}
      />
    );

    const nodeShell = screen.getByText(node?.data.title || '').closest('.workflow-canvas-node-shell');
    expect(nodeShell).toBeTruthy();

    fireEvent.mouseEnter(nodeShell!);
    expect(screen.queryByTestId('workflow-node-action-play')).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-action-delete')).toBeInTheDocument();
  });

  it('shows assistant preview badges for assistant-managed nodes', () => {
    const graph = createStarterGraph();
    const node = graph.nodes.find((candidate) => candidate.type === 'video-generate');
    expect(node).toBeTruthy();

    const WorkflowNode = workflowCanvasNodeTypes['video-generate'] as unknown as ComponentType<Record<string, unknown>>;

    render(
      <WorkflowNode
        id={node?.id}
        data={{
          ...node?.data,
          __runtime: {
            assistantManaged: true,
            assistantPreviewState: 'changed',
          },
        }}
        dragging={false}
      />
    );

    expect(screen.getByText('Changed')).toBeInTheDocument();
  });

  it('keeps image and video generator output handles vertically centered on compact cards', () => {
    const graph = createStarterGraph();
    const imageNode = graph.nodes.find((candidate) => candidate.type === 'image-generate');
    const videoNode = graph.nodes.find((candidate) => candidate.type === 'video-generate');
    expect(imageNode).toBeTruthy();
    expect(videoNode).toBeTruthy();

    const ImageGenerateNode = workflowCanvasNodeTypes['image-generate'] as unknown as ComponentType<Record<string, unknown>>;
    const VideoGenerateNode = workflowCanvasNodeTypes['video-generate'] as unknown as ComponentType<Record<string, unknown>>;

    const { rerender } = render(
      <ImageGenerateNode
        id={imageNode?.id}
        data={imageNode?.data}
        dragging={false}
      />
    );

    expect(screen.getByTestId('workflow-handle-source-image')).toHaveStyle({ top: '60px' });

    rerender(
      <VideoGenerateNode
        id={videoNode?.id}
        data={videoNode?.data}
        dragging={false}
      />
    );

    expect(screen.getByTestId('workflow-handle-source-video')).toHaveStyle({ top: '72px' });
  });

  it('shows inline labels for multi-input workflow nodes only', () => {
    const graph = createStarterGraph();
    const imageNode = graph.nodes.find((candidate) => candidate.type === 'image-generate');
    const videoNode = graph.nodes.find((candidate) => candidate.type === 'video-generate');
    const motionNode = graph.nodes.find((candidate) => candidate.type === 'motion-generate');
    expect(imageNode).toBeTruthy();
    expect(videoNode).toBeTruthy();
    expect(motionNode).toBeTruthy();

    const ImageGenerateNode = workflowCanvasNodeTypes['image-generate'] as unknown as ComponentType<Record<string, unknown>>;
    const VideoGenerateNode = workflowCanvasNodeTypes['video-generate'] as unknown as ComponentType<Record<string, unknown>>;
    const MotionGenerateNode = workflowCanvasNodeTypes['motion-generate'] as unknown as ComponentType<Record<string, unknown>>;

    const { rerender } = render(
      <ImageGenerateNode
        id={imageNode?.id}
        data={imageNode?.data}
        dragging={false}
      />
    );

    expect(screen.getByText('PROMPT')).toBeInTheDocument();
    expect(screen.getByText('REF')).toBeInTheDocument();

    rerender(
      <VideoGenerateNode
        id={videoNode?.id}
        data={videoNode?.data}
        dragging={false}
      />
    );

    expect(screen.getByText('PROMPT')).toBeInTheDocument();
    expect(screen.getByText('START')).toBeInTheDocument();
    expect(screen.getByText('END')).toBeInTheDocument();
    expect(screen.queryByText(/^REF$/)).not.toBeInTheDocument();

    rerender(
      <MotionGenerateNode
        id={motionNode?.id}
        data={motionNode?.data}
        dragging={false}
      />
    );

    expect(screen.getByText('IMAGE')).toBeInTheDocument();
    expect(screen.getByText('VIDEO')).toBeInTheDocument();
    expect(screen.getByText('PROMPT')).toBeInTheDocument();
    expect(screen.queryByText('START')).not.toBeInTheDocument();
  });

  it('renders a typed approval checkpoint and resumes an awaiting run from the node', () => {
    const graph = createTemplateReadyStarterGraph();
    const node = graph.nodes.find((candidate) => candidate.type === 'approval-gate');
    expect(node).toBeTruthy();
    const onApprove = vi.fn();
    const ApprovalNode = workflowCanvasNodeTypes['approval-gate'] as unknown as ComponentType<Record<string, unknown>>;

    render(
      <ApprovalNode
        id={node?.id}
        data={{
          ...node?.data,
          runState: {
            ...node?.data.runState,
            status: 'awaiting_approval',
            outputUrl: 'https://example.com/pending.jpg',
          },
          __runtime: { onApprove },
        }}
        dragging={false}
      />
    );

    expect(screen.getByTestId('workflow-handle-target-image')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-handle-source-image')).toBeInTheDocument();
    expect(screen.getByText('review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve & continue/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});
