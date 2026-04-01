'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';

import type {
  WorkflowCanvasEdge,
  WorkflowCanvasNode,
} from '@/lib/workflow-canvas';
import { WorkflowCanvasOverlays } from './WorkflowCanvasOverlays';
import {
  WorkflowCanvasPreviewProvider,
  decorateWorkflowEdge,
  decorateWorkflowNode,
  workflowCanvasEdgeTypes,
  workflowCanvasNodeTypes,
  type WorkflowNodeRuntimeData,
} from './WorkflowCanvasNodes';
import type {
  CanvasContextMenuState,
  CanvasSelectionState,
  PreviewMediaState,
} from './workflowCanvasUiTypes';

interface WorkflowCanvasSurfaceProps {
  canvasSectionRef: RefObject<HTMLElement | null>;
  contextMenu: CanvasContextMenuState | null;
  edges: WorkflowCanvasEdge[];
  error: string | null;
  nodeActionRuntimeById: Record<string, WorkflowNodeRuntimeData | undefined>;
  nodeRunStateById: Record<string, {
    canRunBranch: boolean;
    canRunNode: boolean;
    runBranchDisabled: boolean;
    runNodeDisabled: boolean;
  } | undefined>;
  onAddNote: (position: { x: number; y: number }) => void;
  onClearSelection: () => void;
  onCloseContextMenu: () => void;
  onClosePreview: () => void;
  onCommitNodePositions: (updates: Array<{ id: string; position: { x: number; y: number } }>) => void;
  onConnect: (connection: Connection) => void;
  onDeleteSelection: () => void;
  onDeleteEdge: (edgeId: string) => void;
  onEditNode: (nodeId: string) => void;
  onEdgeClick: (event: ReactMouseEvent, edge: WorkflowCanvasEdge) => void;
  onEdgeContextMenu: (event: ReactMouseEvent, edge: WorkflowCanvasEdge) => void;
  onFitView: () => void;
  onMoveEnd: (nextViewport: Viewport) => void;
  onNodeClick: (event: ReactMouseEvent, node: WorkflowCanvasNode) => void;
  onNodeContextMenu: (event: ReactMouseEvent, node: WorkflowCanvasNode) => void;
  onNodeDoubleClick: (event: ReactMouseEvent, node: WorkflowCanvasNode) => void;
  onNodeDragStart: () => void;
  onOpenPreview: (preview: PreviewMediaState) => void;
  onPaneClick: () => void;
  onPaneContextMenu: (event: MouseEvent | ReactMouseEvent) => void;
  onRunBranch: (nodeId: string) => void;
  onRunNode: (nodeId: string) => void;
  onSelectAll: () => void;
  onSelectionChange: (selection: CanvasSelectionState) => void;
  previewMedia: PreviewMediaState | null;
  renderNodes: WorkflowCanvasNode[];
  selection: CanvasSelectionState;
  setReactFlowInstance: Dispatch<SetStateAction<ReactFlowInstance | null>>;
}

function areItemRefsEqual<T>(left: T[], right: T[]) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

export function WorkflowCanvasSurface({
  canvasSectionRef,
  contextMenu,
  edges,
  error,
  nodeActionRuntimeById,
  nodeRunStateById,
  onAddNote,
  onClearSelection,
  onCloseContextMenu,
  onClosePreview,
  onCommitNodePositions,
  onConnect,
  onDeleteSelection,
  onDeleteEdge,
  onEditNode,
  onEdgeClick,
  onEdgeContextMenu,
  onFitView,
  onMoveEnd,
  onNodeClick,
  onNodeContextMenu,
  onNodeDoubleClick,
  onNodeDragStart,
  onOpenPreview,
  onPaneClick,
  onPaneContextMenu,
  onRunBranch,
  onRunNode,
  onSelectAll,
  onSelectionChange,
  previewMedia,
  renderNodes,
  selection,
  setReactFlowInstance,
}: WorkflowCanvasSurfaceProps) {
  const [flowNodes, setFlowNodes] = useState(renderNodes);
  const [flowEdges, setFlowEdges] = useState(edges);
  const canonicalNodesRef = useRef(renderNodes);
  const canonicalEdgesRef = useRef(edges);
  const flowNodesRef = useRef(renderNodes);
  const isDraggingRef = useRef(false);
  const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null);

  useEffect(() => {
    flowNodesRef.current = flowNodes;
  }, [flowNodes]);

  useEffect(() => {
    if (isDraggingRef.current || areItemRefsEqual(canonicalNodesRef.current, renderNodes)) {
      return;
    }

    canonicalNodesRef.current = renderNodes;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setFlowNodes(renderNodes);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [renderNodes]);

  useEffect(() => {
    if (isDraggingRef.current || areItemRefsEqual(canonicalEdgesRef.current, edges)) {
      return;
    }

    canonicalEdgesRef.current = edges;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setFlowEdges(edges);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [edges]);

  const handleNodesChange = useCallback((changes: NodeChange<WorkflowCanvasNode>[]) => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<WorkflowCanvasEdge>[]) => {
    setFlowEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const handleDeleteEdge = useCallback((edgeId: string) => {
    setFlowEdges((current) => current.filter((edge) => edge.id !== edgeId));
    onDeleteEdge(edgeId);
    onCloseContextMenu();
  }, [onCloseContextMenu, onDeleteEdge]);

  const commitDraggedNodes = useCallback((draggedNodeIds: string[]) => {
    isDraggingRef.current = false;
    const nodesToCommit = draggedNodeIds
      .map((nodeId) => flowNodesRef.current.find((node) => node.id === nodeId))
      .filter((node): node is WorkflowCanvasNode => Boolean(node))
      .map((node) => ({
        id: node.id,
        position: node.position,
      }));

    if (nodesToCommit.length > 0) {
      onCommitNodePositions(nodesToCommit);
    }
  }, [onCommitNodePositions]);

  const defaultEdgeOptions = useMemo(() => ({ animated: true, interactionWidth: 32 }), []);
  const minimapNodeColor = useCallback(() => '#3f3f46', []);
  const renderedNodes = useMemo(
    () => flowNodes.map((node) => decorateWorkflowNode(node, nodeActionRuntimeById[node.id])),
    [flowNodes, nodeActionRuntimeById]
  );
  const renderedEdges = useMemo(
    () => flowEdges.map((edge) => decorateWorkflowEdge(edge, { onDeleteEdge: handleDeleteEdge })),
    [flowEdges, handleDeleteEdge]
  );

  return (
    <WorkflowCanvasPreviewProvider onOpenPreview={onOpenPreview}>
      <section ref={canvasSectionRef} className="relative min-h-0 flex-1">
        {error && (
          <div className="absolute left-4 top-4 z-20 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        <ReactFlow
          nodes={renderedNodes as never}
          edges={renderedEdges as never}
          onNodesChange={handleNodesChange as never}
          onEdgesChange={handleEdgesChange as never}
          onConnect={onConnect as never}
          onPaneClick={onPaneClick}
          onPaneContextMenu={onPaneContextMenu as never}
          onEdgeClick={onEdgeClick as never}
          onNodeClick={onNodeClick as never}
          onNodeDoubleClick={onNodeDoubleClick as never}
          onNodeContextMenu={onNodeContextMenu as never}
          onNodeDragStart={() => {
            isDraggingRef.current = true;
            onNodeDragStart();
          }}
          onNodeDragStop={(_, __, draggedNodes: WorkflowCanvasNode[]) => {
            commitDraggedNodes(draggedNodes.map((draggedNode) => draggedNode.id));
          }}
          onSelectionDragStop={(_, draggedNodes: WorkflowCanvasNode[]) => {
            commitDraggedNodes(draggedNodes.map((draggedNode) => draggedNode.id));
          }}
          onEdgeContextMenu={onEdgeContextMenu as never}
          onSelectionChange={({ nodes: nextNodes, edges: nextEdges }: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => {
            onSelectionChange({
              nodeIds: nextNodes.map((node) => node.id),
              edgeIds: nextEdges.map((edge) => edge.id),
            });
            onCloseContextMenu();
          }}
          onInit={(instance) => {
            reactFlowInstanceRef.current = instance as unknown as ReactFlowInstance;
            setReactFlowInstance(instance as never);
          }}
          onMoveEnd={(_, nextViewport) => onMoveEnd(nextViewport)}
          fitView
          defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
          nodeTypes={workflowCanvasNodeTypes as never}
          edgeTypes={workflowCanvasEdgeTypes as never}
          className="dark bg-[#070707]"
          colorMode="dark"
          deleteKeyCode={null}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          selectionKeyCode={['Shift']}
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          panActivationKeyCode="Space"
          panOnDrag={[1]}
          panOnScroll={false}
          zoomOnScroll
          zoomOnPinch
          preventScrolling
          zoomOnDoubleClick={false}
          defaultEdgeOptions={defaultEdgeOptions}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#27272a" />
          <MiniMap
            pannable
            zoomable
            className="!bottom-4 !right-4 !border !border-white/10 !bg-black/80"
            nodeColor={minimapNodeColor}
          />
          <Controls className="!bottom-4 !left-4 !border !border-white/10 !bg-black/80" />
        </ReactFlow>

        <WorkflowCanvasOverlays
          contextMenu={contextMenu}
          edges={flowEdges}
          nodes={flowNodes}
          nodeRunStateById={nodeRunStateById}
          onAddNote={onAddNote}
          onClearSelection={onClearSelection}
          onCloseContextMenu={onCloseContextMenu}
          onClosePreview={onClosePreview}
          onDeleteSelection={onDeleteSelection}
          onEditNode={onEditNode}
          onFitView={onFitView}
          onRunBranch={onRunBranch}
          onRunNode={onRunNode}
          onSelectAll={onSelectAll}
          preview={previewMedia}
          selection={selection}
          showSelectionHud={false}
        />
      </section>
      <WorkflowCanvasStyles />
    </WorkflowCanvasPreviewProvider>
  );
}

function WorkflowCanvasStyles() {
  return (
    <style>{`
      .react-flow {
        --xy-controls-button-background-color: #171717;
        --xy-controls-button-background-color-hover: #262626;
        --xy-controls-button-color: #f4f4f5;
        --xy-controls-button-border-color: rgba(255, 255, 255, 0.1);
        --xy-controls-box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      }

      .react-flow__edge-path {
        transition: stroke-width 140ms ease, filter 140ms ease, opacity 140ms ease;
      }

      .react-flow__node {
        transition: none !important;
      }

      .react-flow__node.dragging {
        z-index: 6 !important;
      }

      .react-flow__edge.selected .react-flow__edge-path {
        stroke-width: 3px;
        filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.35));
      }

      .react-flow__selection {
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(255, 255, 255, 0.06);
        backdrop-filter: blur(2px);
      }

      .react-flow__controls-button {
        color: #f4f4f5;
        background: #171717;
      }

      .react-flow__controls-button:hover {
        background: #262626;
      }
    `}</style>
  );
}
