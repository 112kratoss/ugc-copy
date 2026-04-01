import type { ComponentType } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workflowCanvasEdgeTypes, workflowCanvasNodeTypes } from '@/app/create-workflow/WorkflowCanvasNodes';
import { createStarterGraph } from '@/lib/workflow-canvas';

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
});
