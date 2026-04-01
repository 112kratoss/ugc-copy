'use client';

import { Layers3, PencilLine, Play, Plus, Trash2, X, ZoomIn } from 'lucide-react';
import type { WorkflowCanvasEdge, WorkflowCanvasNode } from '@/lib/workflow-canvas';
import type {
  CanvasContextMenuState,
  CanvasSelectionState,
  PreviewMediaState,
} from './workflowCanvasUiTypes';
import { getNodeLabel } from './workflowCanvasUiUtils';

interface WorkflowCanvasOverlaysProps {
  contextMenu: CanvasContextMenuState | null;
  edges: WorkflowCanvasEdge[];
  nodes: WorkflowCanvasNode[];
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
  onDeleteSelection: () => void;
  onEditNode: (nodeId: string) => void;
  onFitView: () => void;
  onRunBranch: (nodeId: string) => void;
  onRunNode: (nodeId: string) => void;
  onSelectAll: () => void;
  preview: PreviewMediaState | null;
  selection: CanvasSelectionState;
  showSelectionHud: boolean;
}

function CanvasSelectionHud({
  selection,
  onDelete,
  onClear,
}: {
  selection: CanvasSelectionState;
  onDelete: () => void;
  onClear: () => void;
}) {
  const nodeCount = selection.nodeIds.length;
  const edgeCount = selection.edgeIds.length;

  return (
    <div data-testid="canvas-selection-hud" className="absolute left-4 top-24 z-20 max-w-md rounded-[28px] border border-white/10 bg-black/85 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-zinc-300">
            <Layers3 className="h-3.5 w-3.5" />
            Selection
          </div>
          <div className="mt-3 text-sm text-zinc-300">
            {nodeCount > 0 ? `${nodeCount} node${nodeCount === 1 ? '' : 's'}` : 'No nodes'}
            {edgeCount > 0 ? ` • ${edgeCount} connection${edgeCount === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      </div>
    </div>
  );
}

function PreviewMediaOverlay({
  preview,
  onClose,
}: {
  preview: PreviewMediaState | null;
  onClose: () => void;
}) {
  if (!preview) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl rounded-[28px] border border-white/10 bg-[#050505] p-4 shadow-[0_32px_120px_rgba(0,0,0,0.65)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-white">{preview.title}</div>
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Press Escape to close</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:bg-white/[0.06]"
          >
            Close
          </button>
        </div>

        {preview.kind === 'image' && (
          <div className="overflow-auto rounded-3xl border border-white/10 bg-black/60 p-4">
            <img src={preview.url} alt={preview.title} className="mx-auto max-h-[76vh] max-w-full rounded-2xl object-contain" />
          </div>
        )}

        {preview.kind === 'video' && (
          <div className="rounded-3xl border border-white/10 bg-black/60 p-4">
            <video src={preview.url} controls autoPlay className="max-h-[76vh] w-full rounded-2xl" />
          </div>
        )}

        {preview.kind === 'audio' && (
          <div className="rounded-3xl border border-white/10 bg-black/60 p-8">
            <audio src={preview.url} controls autoPlay className="w-full" />
          </div>
        )}
      </div>
    </div>
  );
}

function CanvasContextMenu({
  contextMenu,
  selection,
  nodes,
  edges,
  nodeRunStateById,
  onClose,
  onDeleteSelection,
  onEditNode,
  onClearSelection,
  onAddNote,
  onFitView,
  onRunBranch,
  onRunNode,
  onSelectAll,
}: {
  contextMenu: CanvasContextMenuState | null;
  selection: CanvasSelectionState;
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  nodeRunStateById: WorkflowCanvasOverlaysProps['nodeRunStateById'];
  onClose: () => void;
  onDeleteSelection: () => void;
  onEditNode: (nodeId: string) => void;
  onClearSelection: () => void;
  onAddNote: (position: { x: number; y: number }) => void;
  onFitView: () => void;
  onRunBranch: (nodeId: string) => void;
  onRunNode: (nodeId: string) => void;
  onSelectAll: () => void;
}) {
  if (!contextMenu) {
    return null;
  }

  const selectionCount = selection.nodeIds.length + selection.edgeIds.length;
  const isSelectionMenu = contextMenu.target !== 'pane' && selectionCount > 1;
  const node = contextMenu.nodeId ? nodes.find((candidate) => candidate.id === contextMenu.nodeId) || null : null;
  const edge = contextMenu.edgeId ? edges.find((candidate) => candidate.id === contextMenu.edgeId) || null : null;
  const nodeRunState = node ? nodeRunStateById[node.id] : undefined;
  const actionClassName = 'flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-200 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        data-testid="canvas-context-menu"
        className="absolute min-w-[260px] rounded-[24px] border border-white/10 bg-black/95 p-3 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 px-2">
          <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            {contextMenu.target === 'pane' ? 'Canvas' : isSelectionMenu ? 'Selection' : contextMenu.target === 'node' ? 'Node' : 'Connection'}
          </div>
          <div className="mt-1 text-sm text-zinc-200">
            {contextMenu.target === 'pane'
              ? 'Common actions'
              : isSelectionMenu
                ? `${selection.nodeIds.length} node${selection.nodeIds.length === 1 ? '' : 's'}${selection.edgeIds.length ? ` • ${selection.edgeIds.length} connection${selection.edgeIds.length === 1 ? '' : 's'}` : ''}`
                : node
                  ? node.data.title
                  : edge
                    ? `${getNodeLabel(nodes, edge.source)} → ${getNodeLabel(nodes, edge.target)}`
                    : 'Quick actions'}
          </div>
        </div>

        <div className="space-y-2">
          {contextMenu.target === 'pane' && (
            <>
              <button type="button" onClick={() => { onClose(); onAddNote(contextMenu.flowPosition || { x: 240, y: 240 }); }} className={actionClassName}>
                <span>Add note</span>
                <Plus className="h-4 w-4 text-zinc-500" />
              </button>
              <button type="button" onClick={() => { onClose(); onFitView(); }} className={actionClassName}>
                <span>Fit view</span>
                <ZoomIn className="h-4 w-4 text-zinc-500" />
              </button>
              <button type="button" onClick={() => { onClose(); onSelectAll(); }} className={actionClassName}>
                <span>Select all</span>
                <Layers3 className="h-4 w-4 text-zinc-500" />
              </button>
            </>
          )}

          {isSelectionMenu && (
            <>
              <button type="button" onClick={() => { onClose(); onDeleteSelection(); }} className={actionClassName}>
                <span>Delete selected</span>
                <Trash2 className="h-4 w-4 text-rose-300" />
              </button>
              <button type="button" onClick={() => { onClose(); onClearSelection(); }} className={actionClassName}>
                <span>Clear selection</span>
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </>
          )}

          {!isSelectionMenu && contextMenu.target === 'node' && node && (
            <>
              <button
                type="button"
                onClick={() => { onClose(); onEditNode(node.id); }}
                className={actionClassName}
              >
                <span>Edit node</span>
                <PencilLine className="h-4 w-4 text-zinc-500" />
              </button>
              {nodeRunState?.canRunNode && (
                <button
                  type="button"
                  onClick={() => { onClose(); onRunNode(node.id); }}
                  disabled={nodeRunState.runNodeDisabled}
                  className={actionClassName}
                >
                  <span>Run this step</span>
                  <Play className="h-4 w-4 fill-current text-emerald-300" />
                </button>
              )}
              {nodeRunState?.canRunBranch && (
                <button
                  type="button"
                  onClick={() => { onClose(); onRunBranch(node.id); }}
                  disabled={nodeRunState.runBranchDisabled}
                  className={actionClassName}
                >
                  <span>Run from here</span>
                  <Play className="h-4 w-4 fill-current text-sky-300" />
                </button>
              )}
              <button type="button" onClick={() => { onClose(); onDeleteSelection(); }} className={actionClassName}>
                <span>Delete</span>
                <Trash2 className="h-4 w-4 text-rose-300" />
              </button>
            </>
          )}

          {!isSelectionMenu && contextMenu.target === 'edge' && edge && (
            <button type="button" onClick={() => { onClose(); onDeleteSelection(); }} className={actionClassName}>
              <span>Delete connection</span>
              <Trash2 className="h-4 w-4 text-rose-300" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkflowCanvasOverlays({
  contextMenu,
  edges,
  nodes,
  nodeRunStateById,
  onAddNote,
  onClearSelection,
  onCloseContextMenu,
  onClosePreview,
  onDeleteSelection,
  onEditNode,
  onFitView,
  onRunBranch,
  onRunNode,
  onSelectAll,
  preview,
  selection,
  showSelectionHud,
}: WorkflowCanvasOverlaysProps) {
  return (
    <>
      {showSelectionHud && (
        <CanvasSelectionHud
          selection={selection}
          onDelete={onDeleteSelection}
          onClear={onClearSelection}
        />
      )}

      <CanvasContextMenu
        contextMenu={contextMenu}
        selection={selection}
        nodes={nodes}
        edges={edges}
        nodeRunStateById={nodeRunStateById}
        onClose={onCloseContextMenu}
        onDeleteSelection={onDeleteSelection}
        onEditNode={onEditNode}
        onClearSelection={onClearSelection}
        onAddNote={onAddNote}
        onFitView={onFitView}
        onRunBranch={onRunBranch}
        onRunNode={onRunNode}
        onSelectAll={onSelectAll}
      />

      <PreviewMediaOverlay preview={preview} onClose={onClosePreview} />
    </>
  );
}
