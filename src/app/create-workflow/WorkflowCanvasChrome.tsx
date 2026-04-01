'use client';

import type { ReactNode } from 'react';
import { ArrowLeft, Save } from 'lucide-react';
import type { CanvasSaveState } from './useWorkflowCanvasPersistence';

interface WorkflowCanvasChromeProps {
  canvasTitle: string;
  children: ReactNode;
  canvasOverlay?: ReactNode;
  leftRail: ReactNode;
  onCanvasTitleChange: (title: string) => void;
  onNavigateBack: () => void;
  onSave: () => void;
  saveState: CanvasSaveState;
}

function getSaveLabel(saveState: CanvasSaveState) {
  if (saveState === 'saving') {
    return 'Saving...';
  }

  if (saveState === 'dirty') {
    return 'Unsaved changes';
  }

  return 'Saved';
}

export function WorkflowCanvasChrome({
  canvasTitle,
  children,
  canvasOverlay,
  leftRail,
  onCanvasTitleChange,
  onNavigateBack,
  onSave,
  saveState,
}: WorkflowCanvasChromeProps) {
  const isSaving = saveState === 'saving';
  const canSave = saveState === 'dirty';

  return (
    <div className="workflow-builder-shell flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        data-testid="workflow-canvas-header"
        className="shrink-0 border-b border-white/10 bg-black/88 px-5 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-xl supports-[backdrop-filter]:bg-black/74"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button
              type="button"
              onClick={onNavigateBack}
              aria-label="Back to create"
              className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06]"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>

            <div className="min-w-[280px] flex-1">
              <div className="mb-1 text-[11px] uppercase tracking-[0.18em] text-zinc-500">Workflow title</div>
              <input
                aria-label="Workflow title"
                value={canvasTitle}
                onChange={(event) => onCanvasTitleChange(event.target.value)}
                className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2 text-base font-semibold outline-none transition focus:border-emerald-500/40"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className={`text-xs uppercase tracking-[0.16em] ${
              saveState === 'dirty'
                ? 'text-amber-300'
                : saveState === 'saving'
                  ? 'text-zinc-300'
                  : 'text-zinc-500'
            }`}>
              {getSaveLabel(saveState)}
            </span>
            <button
              type="button"
              onClick={onSave}
              disabled={!canSave || isSaving}
              className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-sm text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {leftRail}

        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
          {canvasOverlay}
        </main>
      </div>

      <style>{`
        .workflow-builder-shell button:not(:disabled),
        .workflow-builder-shell [role="button"]:not([aria-disabled="true"]) {
          cursor: pointer;
        }

        .workflow-builder-shell button:disabled,
        .workflow-builder-shell [aria-disabled="true"] {
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
