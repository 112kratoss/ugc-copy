'use client';

import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  RefObject,
  SetStateAction,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';

import type {
  WorkflowCanvasEdge,
  WorkflowCanvasNode,
  WorkflowNodeData,
  WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import { WorkflowCanvasOverlays } from './WorkflowCanvasOverlays';
import {
  WorkflowCanvasPreviewProvider,
  workflowCanvasNodeTypes,
} from './WorkflowCanvasNodes';
import {
  FloatingEdgeEditor,
  FloatingNodeEditor,
} from './WorkflowNodeEditors';
import type {
  CanvasContextMenuState,
  CanvasFloatingPosition,
  CanvasSelectionState,
  PreviewMediaState,
  WorkflowRunAffordance,
} from './workflowCanvasUiTypes';

interface WorkflowCanvasSurfaceProps {
  canvasSectionRef: RefObject<HTMLElement | null>;
  contextMenu: CanvasContextMenuState | null;
  edgeEditorPosition: CanvasFloatingPosition | null;
  editorPosition: CanvasFloatingPosition | null;
  edges: WorkflowCanvasEdge[];
  error: string | null;
  onAddNote: (position: { x: number; y: number }) => void;
  onClearSelection: () => void;
  onCloseContextMenu: () => void;
  onClosePreview: () => void;
  onConnect: (connection: Connection) => void;
  onDeleteEdge: (edgeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onEdgeClick: (event: ReactMouseEvent, edge: WorkflowCanvasEdge) => void;
  onEdgeContextMenu: (event: ReactMouseEvent, edge: WorkflowCanvasEdge) => void;
  onEdgesChange: (changes: EdgeChange<WorkflowCanvasEdge>[]) => void;
  onFitView: () => void;
  onMoveEnd: (nextViewport: Viewport) => void;
  onNodeContextMenu: (event: ReactMouseEvent, node: WorkflowCanvasNode) => void;
  onNodesChange: (changes: NodeChange<WorkflowCanvasNode>[]) => void;
  onOpenPlanner: () => void;
  onOpenPreview: (preview: PreviewMediaState) => void;
  onPaneClick: () => void;
  onPaneContextMenu: (event: MouseEvent | ReactMouseEvent) => void;
  onRunBranch: (nodeId: string) => void;
  onRunNode: (nodeId: string) => void;
  onSelectAll: () => void;
  onSelectionChange: (selection: CanvasSelectionState) => void;
  onSetError: (message: string | null) => void;
  onUploadAsset: (file: File, bucket: 'generated_images' | 'generated_videos' | 'generated_audio') => Promise<{ signedUrl: string; storagePath: string }>;
  onUpdateNode: (nodeId: string, updates: Partial<WorkflowNodeData>) => void;
  previewMedia: PreviewMediaState | null;
  renderNodes: WorkflowCanvasNode[];
  runAffordance: WorkflowRunAffordance | null;
  selectedEdge: WorkflowCanvasEdge | null;
  selectedKind: WorkflowNodeKind | undefined;
  selectedNode: WorkflowCanvasNode | null;
  selection: CanvasSelectionState;
  selectionCount: number;
  setReactFlowInstance: Dispatch<SetStateAction<ReactFlowInstance | null>>;
}

export function WorkflowCanvasSurface({
  canvasSectionRef,
  contextMenu,
  edgeEditorPosition,
  editorPosition,
  edges,
  error,
  onAddNote,
  onClearSelection,
  onCloseContextMenu,
  onClosePreview,
  onConnect,
  onDeleteEdge,
  onDeleteNode,
  onDeleteSelection,
  onDuplicateSelection,
  onEdgeClick,
  onEdgeContextMenu,
  onEdgesChange,
  onFitView,
  onMoveEnd,
  onNodeContextMenu,
  onNodesChange,
  onOpenPlanner,
  onOpenPreview,
  onPaneClick,
  onPaneContextMenu,
  onRunBranch,
  onRunNode,
  onSelectAll,
  onSelectionChange,
  onSetError,
  onUploadAsset,
  onUpdateNode,
  previewMedia,
  renderNodes,
  runAffordance,
  selectedEdge,
  selectedKind,
  selectedNode,
  selection,
  selectionCount,
  setReactFlowInstance,
}: WorkflowCanvasSurfaceProps) {
  return (
    <WorkflowCanvasPreviewProvider onOpenPreview={onOpenPreview}>
      <section ref={canvasSectionRef} className="relative min-h-0 flex-1">
        {error && (
          <div className="absolute left-4 top-4 z-20 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        <ReactFlow
          nodes={renderNodes as never}
          edges={edges as never}
          onNodesChange={onNodesChange as never}
          onEdgesChange={onEdgesChange as never}
          onConnect={onConnect as never}
          onPaneClick={onPaneClick as never}
          onPaneContextMenu={onPaneContextMenu as never}
          onEdgeClick={onEdgeClick as never}
          onNodeContextMenu={onNodeContextMenu as never}
          onEdgeContextMenu={onEdgeContextMenu as never}
          onSelectionChange={({ nodes: nextNodes, edges: nextEdges }: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => {
            onSelectionChange({
              nodeIds: nextNodes.map((node) => node.id),
              edgeIds: nextEdges.map((edge) => edge.id),
            });
            onCloseContextMenu();
          }}
          onInit={setReactFlowInstance}
          onMoveEnd={(_, nextViewport) => onMoveEnd(nextViewport)}
          fitView
          defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
          nodeTypes={workflowCanvasNodeTypes as never}
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
          defaultEdgeOptions={{ animated: true, interactionWidth: 32 }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#27272a" />
          <MiniMap
            pannable
            zoomable
            className="!bottom-4 !right-4 !border !border-white/10 !bg-black/80"
            nodeColor={() => '#3f3f46'}
          />
          <Controls className="!bottom-4 !left-4 !border !border-white/10 !bg-black/80" />
        </ReactFlow>

        {selectedNode && editorPosition && (
          <FloatingNodeEditor
            node={selectedNode}
            selectedKind={selectedKind}
            position={editorPosition}
            onUpdateNode={onUpdateNode}
            onUploadAsset={onUploadAsset}
            onDeleteNode={() => onDeleteNode(selectedNode.id)}
            onOpenPreview={onOpenPreview}
            onClose={onClearSelection}
            onSetError={onSetError}
          />
        )}

        {!contextMenu && selectedEdge && edgeEditorPosition && (
          <FloatingEdgeEditor
            edge={selectedEdge}
            nodes={renderNodes}
            position={edgeEditorPosition}
            onDelete={() => onDeleteEdge(selectedEdge.id)}
            onClose={onClearSelection}
          />
        )}

        <WorkflowCanvasOverlays
          contextMenu={contextMenu}
          edges={edges}
          nodeRunAffordance={runAffordance}
          nodes={renderNodes}
          onAddNote={onAddNote}
          onClearSelection={onClearSelection}
          onCloseContextMenu={onCloseContextMenu}
          onClosePreview={onClosePreview}
          onDeleteSelection={onDeleteSelection}
          onDuplicateSelection={onDuplicateSelection}
          onFitView={onFitView}
          onOpenPlanner={onOpenPlanner}
          onRunBranch={onRunBranch}
          onRunNode={onRunNode}
          onSelectAll={onSelectAll}
          preview={previewMedia}
          selection={selection}
          showSelectionHud={!selectedNode && !selectedEdge && selectionCount > 0}
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
