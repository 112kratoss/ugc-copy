'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Copy,
  PanelRightOpen,
  Play,
  Plus,
  Save,
  Trash2,
  ZoomIn,
} from 'lucide-react';
import type { WorkflowNodeKind, WorkflowCanvasListItem } from '@/lib/workflow-canvas';
import type { CanvasSaveState } from './useWorkflowCanvasPersistence';
import type { WorkflowRunAffordance } from './workflowCanvasUiTypes';

interface WorkflowCanvasChromeProps {
  activeCanvasId: string | null;
  canvasTitle: string;
  canvases: WorkflowCanvasListItem[];
  children: ReactNode;
  hasSelectedNode: boolean;
  isCanvasTransitionPending: boolean;
  hasNodeSelection: boolean;
  nodeLibrary: Array<{ type: WorkflowNodeKind; label: string; icon: ReactNode }>;
  onAddNode: (type: WorkflowNodeKind) => void;
  onCanvasTitleBlur: () => void;
  onCanvasTitleChange: (title: string) => void;
  onCreateCanvas: () => void;
  onDeleteCanvas: (canvasId: string) => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onOpenPlanner: () => void;
  onRunBranch: () => void;
  onRunNode: () => void;
  onSave: () => void;
  onSelectCanvas: (canvas: WorkflowCanvasListItem) => void;
  runAffordance: WorkflowRunAffordance | null;
  saveState: CanvasSaveState;
  selectionCount: number;
}

function getSaveLabel(saveState: CanvasSaveState) {
  if (saveState === 'saving') {
    return 'Saving changes';
  }

  if (saveState === 'dirty') {
    return 'Unsaved changes';
  }

  return 'All changes saved';
}

function getRunStatusClassName(runAffordance: WorkflowRunAffordance) {
  if (runAffordance.tone === 'blocked') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-100';
  }

  if (runAffordance.tone === 'queued') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-100';
  }

  if (runAffordance.tone === 'static') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-100';
  }

  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100';
}

export function WorkflowCanvasChrome({
  activeCanvasId,
  canvasTitle,
  canvases,
  children,
  hasSelectedNode,
  hasNodeSelection,
  isCanvasTransitionPending,
  nodeLibrary,
  onAddNode,
  onCanvasTitleBlur,
  onCanvasTitleChange,
  onCreateCanvas,
  onDeleteCanvas,
  onDeleteSelection,
  onDuplicateSelection,
  onOpenPlanner,
  onRunBranch,
  onRunNode,
  onSave,
  onSelectCanvas,
  runAffordance,
  saveState,
  selectionCount,
}: WorkflowCanvasChromeProps) {
  return (
    <>
      <aside className="flex w-[290px] shrink-0 flex-col border-r border-white/10 bg-black/60">
        <div className="border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <Link href="/create" className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 hover:bg-white/[0.06]">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <div className="text-sm font-semibold">Workflow Canvas</div>
              <div className="text-xs text-zinc-500">Build node-based image, video, motion, and audio flows.</div>
            </div>
          </div>
        </div>

        <div className="border-b border-white/10 px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Node palette</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {nodeLibrary.map((item) => (
              <button
                key={item.type}
                onClick={() => onAddNode(item.type)}
                className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Saved canvases</div>
            <button
              onClick={onCreateCanvas}
              disabled={isCanvasTransitionPending}
              className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              New
            </button>
          </div>
          <div className="space-y-2">
            {canvases.map((canvas) => (
              <div
                key={canvas.id}
                className={`rounded-2xl border px-3 py-3 ${canvas.id === activeCanvasId ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-white/10 bg-white/[0.03]'}`}
              >
                <button
                  className="w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => onSelectCanvas(canvas)}
                  disabled={isCanvasTransitionPending}
                >
                  <div className="text-sm font-medium text-white">{canvas.title}</div>
                  <div className="text-xs text-zinc-500">{new Date(canvas.updated_at).toLocaleString()}</div>
                </button>
                <button
                  onClick={() => onDeleteCanvas(canvas.id)}
                  disabled={isCanvasTransitionPending}
                  className="mt-2 text-xs text-zinc-500 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="sticky top-16 z-40 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-black/85 px-5 py-4 shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl supports-[backdrop-filter]:bg-black/70">
          <div className="flex min-w-0 items-center gap-4">
            <input
              value={canvasTitle}
              onChange={(event) => onCanvasTitleChange(event.target.value)}
              onBlur={onCanvasTitleBlur}
              className="min-w-[280px] rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2 text-lg font-semibold outline-none focus:border-emerald-500/40"
            />
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              {getSaveLabel(saveState)}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={onOpenPlanner}
              className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm text-violet-100 transition hover:bg-violet-500/20"
            >
              <PanelRightOpen className="h-4 w-4" /> Planner
            </button>
            <button onClick={onSave} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:bg-white/[0.06]">
              <Save className="h-4 w-4" /> Save
            </button>
            {hasSelectedNode && (
              <>
                <button
                  onClick={onRunNode}
                  disabled={runAffordance?.runNodeDisabled}
                  className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Play className="h-4 w-4" /> Run node
                </button>
                <button
                  onClick={onRunBranch}
                  disabled={runAffordance?.runBranchDisabled}
                  className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-100 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <ZoomIn className="h-4 w-4" /> Run from here
                </button>
              </>
            )}
            {hasNodeSelection && (
              <button
                type="button"
                onClick={onDuplicateSelection}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:bg-white/[0.06]"
              >
                <Copy className="h-4 w-4" /> Duplicate
              </button>
            )}
            {selectionCount > 0 && (
              <button
                type="button"
                onClick={onDeleteSelection}
                className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 hover:bg-rose-500/20"
              >
                <Trash2 className="h-4 w-4" /> Delete selected
              </button>
            )}
          </div>
          {runAffordance && (
            <div className={`flex w-full flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${getRunStatusClassName(runAffordance)}`}>
              <span>{runAffordance.message}</span>
              {runAffordance.creditLabel && (
                <span className="text-xs uppercase tracking-[0.18em] text-current/80">
                  {runAffordance.creditLabel}
                </span>
              )}
            </div>
          )}
        </div>
        {children}
      </main>
    </>
  );
}
