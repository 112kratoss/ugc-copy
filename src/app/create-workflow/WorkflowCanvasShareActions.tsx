'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownToLine,
  Check,
  Copy,
  Link2,
  Loader2,
  Share2,
  Upload,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';

import type { WorkflowCanvasGraph, WorkflowCanvasRecord } from '@/lib/workflow-canvas';
import {
  extractWorkflowShareId,
  type WorkflowShareImportResponse,
  type WorkflowSharePreview,
  type WorkflowShareSummary,
} from '@/lib/workflow-share';

type PersistCanvasResult = {
  status: 'saved' | 'noop' | 'conflict' | 'failed';
};

type ShareRequestState = 'idle' | 'loading' | 'ready' | 'error';
type ImportPreviewState = 'idle' | 'loading' | 'ready' | 'error';
type CopyState = 'idle' | 'copied' | 'error';

interface WorkflowCanvasShareActionsProps {
  activeCanvasId: string | null;
  activeCanvasHasUnsavedChanges: boolean;
  authHeaders: () => Promise<Record<string, string>>;
  canvasTitle: string;
  graph: WorkflowCanvasGraph;
  initialImportShareId?: string | null;
  importedCanvasPath?: (canvas: WorkflowCanvasRecord) => string;
  onBeforeImport: () => Promise<boolean>;
  onImportComplete: (canvas: WorkflowCanvasRecord) => void;
  onPersistCanvas: (
    title?: string,
    graph?: WorkflowCanvasGraph
  ) => Promise<PersistCanvasResult>;
}

function OverlayShell({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/72 backdrop-blur-sm"
      onClick={onClose}
    >
      {children}
    </div>
  );
}

function formatCountLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function WorkflowCanvasShareActions({
  activeCanvasId,
  activeCanvasHasUnsavedChanges,
  authHeaders,
  canvasTitle,
  graph,
  initialImportShareId = null,
  importedCanvasPath,
  onBeforeImport,
  onImportComplete,
  onPersistCanvas,
}: WorkflowCanvasShareActionsProps) {
  const router = useRouter();
  const autoOpenedImportRef = useRef(false);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portalRoot = typeof document === 'undefined' ? null : document.body;
  const initialImportValue = initialImportShareId?.trim() || null;
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [shareRequestState, setShareRequestState] = useState<ShareRequestState>('idle');
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareSummary, setShareSummary] = useState<WorkflowShareSummary | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importInput, setImportInput] = useState(initialImportValue ?? '');
  const [importPreviewState, setImportPreviewState] = useState<ImportPreviewState>('idle');
  const [importPreview, setImportPreview] = useState<WorkflowSharePreview | null>(null);
  const [importPreviewError, setImportPreviewError] = useState<string | null>(null);
  const [importRequestError, setImportRequestError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const importCounts = useMemo(() => ({
    nodeLabel: formatCountLabel(importPreview?.nodeCount ?? 0, 'node', 'nodes'),
    edgeLabel: formatCountLabel(importPreview?.edgeCount ?? 0, 'connection', 'connections'),
  }), [importPreview?.edgeCount, importPreview?.nodeCount]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const queueCopyReset = useCallback(() => {
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }

    copyResetTimerRef.current = setTimeout(() => {
      setCopyState('idle');
      copyResetTimerRef.current = null;
    }, 2200);
  }, []);

  const resetImportState = useCallback((options?: { preserveInput?: boolean }) => {
    setImportPreviewState('idle');
    setImportPreview(null);
    setImportPreviewError(null);
    setImportRequestError(null);
    setIsImporting(false);
    if (!options?.preserveInput) {
      setImportInput('');
    }
  }, []);

  const loadImportPreview = useCallback(async (rawValue: string) => {
    const shareId = extractWorkflowShareId(rawValue);
    setImportPreview(null);
    setImportPreviewError(null);
    setImportRequestError(null);

    if (!shareId) {
      setImportPreviewState('error');
      setImportPreviewError('Paste a shared workflow link or share id to preview it.');
      return null;
    }

    setImportPreviewState('loading');

    try {
      const response = await fetch(`/api/workflow-shares/${shareId}`, {
        headers: await authHeaders(),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load workflow share preview.');
      }

      const nextPreview = data.share as WorkflowSharePreview;
      setImportPreview(nextPreview);
      setImportPreviewState('ready');
      return nextPreview;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load workflow share preview.';
      setImportPreviewState('error');
      setImportPreviewError(message);
      return null;
    }
  }, [authHeaders]);

  const handleShareWorkflow = useCallback(async () => {
    if (!activeCanvasId) {
      return;
    }

    setIsShareDialogOpen(true);
    setShareRequestState('loading');
    setShareError(null);
    setShareSummary(null);
    setCopyState('idle');

    try {
      if (activeCanvasHasUnsavedChanges) {
        const saveResult = await onPersistCanvas(canvasTitle, graph);
        if (saveResult.status !== 'saved' && saveResult.status !== 'noop') {
          throw new Error('Save your latest changes before creating a share link.');
        }
      }

      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/share`, {
        method: 'POST',
        headers: await authHeaders(),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create workflow share link.');
      }

      setShareSummary(data.share as WorkflowShareSummary);
      setShareRequestState('ready');
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Failed to create workflow share link.');
      setShareRequestState('error');
    }
  }, [
    activeCanvasHasUnsavedChanges,
    activeCanvasId,
    authHeaders,
    canvasTitle,
    graph,
    onPersistCanvas,
  ]);

  const handleCopyShareLink = useCallback(async () => {
    if (!shareSummary?.importUrl) {
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard sharing is not supported in this browser.');
      }

      await navigator.clipboard.writeText(shareSummary.importUrl);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      queueCopyReset();
    }
  }, [queueCopyReset, shareSummary?.importUrl]);

  const openImportDialog = useCallback(() => {
    setIsImportDialogOpen(true);
    if (!initialImportValue) {
      resetImportState({ preserveInput: true });
    }
  }, [initialImportValue, resetImportState]);

  const handleImportWorkflow = useCallback(async () => {
    if (!importPreview) {
      return;
    }

    setImportRequestError(null);
    setIsImporting(true);

    try {
      const canImport = await onBeforeImport();
      if (!canImport) {
        return;
      }

      const response = await fetch(`/api/workflow-shares/${importPreview.id}/import`, {
        method: 'POST',
        headers: await authHeaders(),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to import workflow share.');
      }

      const payload = data as WorkflowShareImportResponse;
      onImportComplete(payload.canvas);
      setIsImportDialogOpen(false);
      resetImportState();
      if (initialImportValue) {
        router.replace(importedCanvasPath?.(payload.canvas) ?? '/create-workflow');
      }
    } catch (error) {
      setImportRequestError(error instanceof Error ? error.message : 'Failed to import workflow share.');
    } finally {
      setIsImporting(false);
    }
  }, [
    authHeaders,
    importPreview,
    importedCanvasPath,
    initialImportValue,
    onBeforeImport,
    onImportComplete,
    resetImportState,
    router,
  ]);

  const renderInPortal = useCallback((content: ReactNode) => {
    if (!portalRoot) {
      return null;
    }

    return createPortal(content, portalRoot);
  }, [portalRoot]);

  useEffect(() => {
    if (!initialImportValue || autoOpenedImportRef.current) {
      return;
    }

    autoOpenedImportRef.current = true;
    setIsImportDialogOpen(true);
    setImportInput(initialImportValue);
    void loadImportPreview(initialImportValue);
  }, [initialImportValue, loadImportPreview]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            void handleShareWorkflow();
          }}
          disabled={!activeCanvasId || shareRequestState === 'loading'}
          className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-2 text-sm text-emerald-100 transition hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {shareRequestState === 'loading' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Share2 className="h-4 w-4" />
          )}
          Share workflow
        </button>

        <button
          type="button"
          onClick={openImportDialog}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm text-zinc-200 transition hover:bg-white/[0.06]"
        >
          <ArrowDownToLine className="h-4 w-4" />
          Import workflow
        </button>
      </div>

      {isShareDialogOpen ? renderInPortal(
        <OverlayShell onClose={() => setIsShareDialogOpen(false)}>
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <div
              role="dialog"
              aria-modal="true"
              data-testid="workflow-share-dialog"
              className="w-full max-w-xl rounded-[30px] border border-white/10 bg-[#050505] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.65)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-300">Workflow share</div>
                  <div className="mt-3 text-2xl font-semibold text-white">Share this workflow as an import link</div>
                  <div className="mt-2 text-sm leading-relaxed text-zinc-400">
                    Prompts, layout, handles, and node settings come across. Uploaded media, storage paths, run outputs,
                    and generation links stay out of the snapshot.
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setIsShareDialogOpen(false)}
                  className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-6 rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
                <div className="text-sm font-medium text-white">{shareSummary?.title || canvasTitle.trim() || 'Untitled workflow'}</div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs uppercase tracking-[0.16em] text-zinc-500">
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
                    {formatCountLabel(shareSummary?.nodeCount ?? graph.nodes.length, 'node', 'nodes')}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
                    {formatCountLabel(shareSummary?.edgeCount ?? graph.edges.length, 'connection', 'connections')}
                  </span>
                </div>
              </div>

              {shareRequestState === 'loading' ? (
                <div className="mt-6 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-zinc-300">
                  <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
                  Creating a fresh snapshot link...
                </div>
              ) : null}

              {shareRequestState === 'error' ? (
                <div className="mt-6 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {shareError}
                </div>
              ) : null}

              {shareSummary ? (
                <div className="mt-6">
                  <label className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Share link</label>
                  <div className="mt-2 flex gap-2">
                    <input
                      readOnly
                      value={shareSummary.importUrl}
                      className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-200 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void handleCopyShareLink();
                      }}
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-100 transition hover:bg-white/[0.06]"
                    >
                      {copyState === 'copied' ? (
                        <Check className="h-4 w-4" />
                      ) : copyState === 'error' ? (
                        <X className="h-4 w-4" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                      {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Try again' : 'Copy link'}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </OverlayShell>
      ) : null}

      {isImportDialogOpen ? renderInPortal(
        <OverlayShell onClose={() => setIsImportDialogOpen(false)}>
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <div
              role="dialog"
              aria-modal="true"
              data-testid="workflow-import-dialog"
              className="w-full max-w-xl rounded-[30px] border border-white/10 bg-[#050505] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.65)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Workflow import</div>
                  <div className="mt-3 text-2xl font-semibold text-white">Import a shared workflow snapshot</div>
                  <div className="mt-2 text-sm leading-relaxed text-zinc-400">
                    Bring in the workflow structure, prompts, and node settings as a new private draft.
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setIsImportDialogOpen(false)}
                  className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {!initialImportValue ? (
                <form
                  className="mt-6"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadImportPreview(importInput);
                  }}
                >
                  <label className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                    Shared workflow URL or id
                  </label>
                  <div className="mt-2 flex gap-2">
                    <input
                      aria-label="Shared workflow URL or id"
                      value={importInput}
                      onChange={(event) => setImportInput(event.target.value)}
                      placeholder="Paste a /create-workflow?import=... link"
                      className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-100 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {importPreviewState === 'loading' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Link2 className="h-4 w-4" />
                      )}
                      Preview import
                    </button>
                  </div>
                </form>
              ) : importPreviewState === 'error' ? (
                <form
                  className="mt-6"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadImportPreview(importInput);
                  }}
                >
                  <label className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                    Try another shared workflow link
                  </label>
                  <div className="mt-2 flex gap-2">
                    <input
                      aria-label="Try another shared workflow link"
                      value={importInput}
                      onChange={(event) => setImportInput(event.target.value)}
                      placeholder="Paste a /create-workflow?import=... link"
                      className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-100 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Link2 className="h-4 w-4" />
                      Preview import
                    </button>
                  </div>
                </form>
              ) : null}

              {importPreviewState === 'loading' ? (
                <div className="mt-6 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-zinc-300">
                  <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
                  Loading shared workflow preview...
                </div>
              ) : null}

              {importPreviewError ? (
                <div className="mt-6 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {importPreviewError}
                </div>
              ) : null}

              {importPreview ? (
                <div className="mt-6 rounded-[24px] border border-white/10 bg-white/[0.03] p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold text-white">{importPreview.title}</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs uppercase tracking-[0.16em] text-zinc-500">
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">{importCounts.nodeLabel}</span>
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">{importCounts.edgeLabel}</span>
                      </div>
                    </div>

                    <div className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-emerald-200">
                      Safe import
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm leading-relaxed text-zinc-300">
                    Media uploads, storage paths, run outputs, and generation-linked references are removed before import.
                  </div>
                </div>
              ) : null}

              {importRequestError ? (
                <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {importRequestError}
                </div>
              ) : null}

              <div className="mt-6 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsImportDialogOpen(false)}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleImportWorkflow();
                  }}
                  disabled={!importPreview || isImporting}
                  className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100 transition hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isImporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Import workflow
                </button>
              </div>
            </div>
          </div>
        </OverlayShell>
      ) : null}
    </>
  );
}
