'use client';

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  Bot,
  ChevronDown,
  Clock3,
  Command,
  History,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { WorkflowCanvasHistoryEntry, WorkflowCanvasListItem } from '@/lib/workflow-canvas';
import type { WorkflowNodeLibraryItem } from './WorkflowCanvasNodes';
import type { WorkflowCommandAction } from './workflowCanvasUiTypes';

declare global {
  interface Window {
    __magicbookletWorkflowListCollapsed?: boolean;
    __emptybookletWorkflowListCollapsed?: boolean;
    __ugcWorkflowListCollapsed?: boolean;
  }
}

function OverlayShell({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose}>{children}</div>;
}

function getRememberedWorkflowListCollapsed() {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    window.__magicbookletWorkflowListCollapsed
    ?? window.__emptybookletWorkflowListCollapsed
    ?? window.__ugcWorkflowListCollapsed
    ?? false
  );
}

function rememberWorkflowListCollapsed(isCollapsed: boolean) {
  if (typeof window === 'undefined') {
    return;
  }

  window.__magicbookletWorkflowListCollapsed = isCollapsed;
}

interface PendingWorkflowDelete {
  id: string;
  title: string;
  isActive: boolean;
  willDiscardUnsavedChanges: boolean;
}

function WorkflowDeleteDialog({
  pendingDeleteCanvas,
  isPending,
  onCancel,
  onConfirm,
}: {
  pendingDeleteCanvas: PendingWorkflowDelete | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!pendingDeleteCanvas || isPending) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPending, onCancel, pendingDeleteCanvas]);

  if (!pendingDeleteCanvas) {
    return null;
  }

  const title = pendingDeleteCanvas.title.trim() || 'Untitled workflow';

  return (
    <OverlayShell onClose={isPending ? () => undefined : onCancel}>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workflow-delete-dialog-title"
          aria-describedby="workflow-delete-dialog-description"
          data-testid="workflow-delete-dialog"
          className="w-full max-w-md rounded-[28px] border border-white/10 bg-[#050505] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.65)]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="text-[11px] uppercase tracking-[0.18em] text-rose-300">Delete workflow</div>
          <div id="workflow-delete-dialog-title" className="mt-3 text-xl font-semibold text-white">
            {`Delete "${title}"?`}
          </div>
          <div id="workflow-delete-dialog-description" className="mt-2 text-sm leading-relaxed text-zinc-400">
            This permanently removes the workflow from your list.
          </div>

          {pendingDeleteCanvas.isActive && pendingDeleteCanvas.willDiscardUnsavedChanges ? (
            <div className="mt-4 rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm leading-relaxed text-rose-100">
              This is the active workflow. Any unsaved changes in it will be lost.
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button
              autoFocus
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" />
              Delete workflow
            </button>
          </div>
        </div>
      </div>
    </OverlayShell>
  );
}

export function WorkflowCanvasLeftRail({
  activeCanvasId,
  activeCanvasHasUnsavedChanges,
  canvases,
  isCanvasTransitionPending,
  nodeLibrary,
  onAddNode,
  onCreateCanvas,
  onDeleteCanvas,
  onSelectCanvas,
  searchInputRef,
}: {
  activeCanvasId: string | null;
  activeCanvasHasUnsavedChanges: boolean;
  canvases: WorkflowCanvasListItem[];
  isCanvasTransitionPending: boolean;
  nodeLibrary: WorkflowNodeLibraryItem[];
  onAddNode: (type: WorkflowNodeLibraryItem['type']) => void;
  onCreateCanvas: () => void;
  onDeleteCanvas: (canvasId: string) => void;
  onSelectCanvas: (canvas: WorkflowCanvasListItem) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState('');
  const [isWorkflowListCollapsed, setIsWorkflowListCollapsed] = useState(() => getRememberedWorkflowListCollapsed());
  const [openMenuCanvasId, setOpenMenuCanvasId] = useState<string | null>(null);
  const [pendingDeleteCanvas, setPendingDeleteCanvas] = useState<PendingWorkflowDelete | null>(null);
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredNodes = useMemo(() => {
    if (!normalizedQuery) {
      return nodeLibrary;
    }

    return nodeLibrary.filter((item) => (
      item.label.toLowerCase().includes(normalizedQuery) ||
      item.type.toLowerCase().includes(normalizedQuery)
    ));
  }, [nodeLibrary, normalizedQuery]);

  useEffect(() => {
    rememberWorkflowListCollapsed(isWorkflowListCollapsed);
  }, [isWorkflowListCollapsed]);

  useEffect(() => {
    if (!openMenuCanvasId) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(event.target as Node)) {
        setOpenMenuCanvasId(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenuCanvasId(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuCanvasId]);

  return (
    <>
      <aside
        data-testid="workflow-left-rail"
        className="flex h-full w-[320px] shrink-0 flex-col border-r border-white/10 bg-[#050505] shadow-[0_28px_120px_rgba(0,0,0,0.35)]"
      >
        <div className="border-b border-white/10 px-5 py-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Node library</div>
          <div className="mt-2 text-lg font-semibold text-white">Build your graph</div>
          <div className="mt-1 text-sm text-zinc-400">Switch workflows, add nodes, connect steps, and save when you are ready.</div>
          <label className="mt-4 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">
            <Search className="h-4 w-4 text-zinc-500" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search prompt, video, note..."
              className="w-full bg-transparent outline-none placeholder:text-zinc-500"
            />
          </label>
        </div>

        <div className="border-b border-white/10 px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Workflows</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setOpenMenuCanvasId(null);
                  setIsWorkflowListCollapsed((current) => !current);
                }}
                aria-expanded={!isWorkflowListCollapsed}
                aria-controls="workflow-canvas-list"
                aria-label={isWorkflowListCollapsed ? 'Expand workflows' : 'Collapse workflows'}
                className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${isWorkflowListCollapsed ? 'rotate-90' : ''}`} />
              </button>
              <button
                type="button"
                onClick={onCreateCanvas}
                disabled={isCanvasTransitionPending}
                className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" />
                New workflow
              </button>
            </div>
          </div>

          {!isWorkflowListCollapsed ? (
            <div id="workflow-canvas-list" data-testid="workflow-canvas-list" className="max-h-[40vh] overflow-y-auto pr-1">
              {canvases.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5 text-sm text-zinc-400">
                  No workflows yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {canvases.map((canvas) => {
                    const isActive = canvas.id === activeCanvasId;
                    const isMenuOpen = canvas.id === openMenuCanvasId;
                    return (
                      <div
                        key={canvas.id}
                        className={`rounded-2xl border px-3 py-3 transition ${
                          isActive
                            ? 'border-emerald-500/30 bg-emerald-500/10'
                            : 'border-white/10 bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuCanvasId(null);
                              onSelectCanvas(canvas);
                            }}
                            aria-label={`Open workflow ${canvas.title}`}
                            disabled={isCanvasTransitionPending}
                            className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <div className="truncate text-sm font-medium text-white">{canvas.title}</div>
                            <div className="mt-2 text-xs text-zinc-500">
                              {new Date(canvas.updated_at).toLocaleString()}
                            </div>
                          </button>

                          <div ref={isMenuOpen ? openMenuRef : undefined} className="relative shrink-0">
                            <button
                              type="button"
                              aria-haspopup="menu"
                              aria-expanded={isMenuOpen}
                              aria-label={`Open actions for ${canvas.title}`}
                              disabled={isCanvasTransitionPending}
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenMenuCanvasId((current) => (current === canvas.id ? null : canvas.id));
                              }}
                              className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>

                            {isMenuOpen ? (
                              <div
                                role="menu"
                                aria-label={`${canvas.title} actions`}
                                className="absolute right-0 top-full z-20 mt-2 w-44 overflow-hidden rounded-2xl border border-white/10 bg-[#090909] p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setOpenMenuCanvasId(null);
                                    setPendingDeleteCanvas({
                                      id: canvas.id,
                                      title: canvas.title,
                                      isActive,
                                      willDiscardUnsavedChanges: isActive && activeCanvasHasUnsavedChanges,
                                    });
                                  }}
                                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-rose-100 transition hover:bg-rose-500/10"
                                >
                                  <Trash2 className="h-4 w-4" />
                                  Delete workflow
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
            <Clock3 className="h-3.5 w-3.5" />
            Insert nodes
          </div>
          <div className="grid grid-cols-2 gap-2">
            {filteredNodes.map((item) => (
              <button
                key={item.type}
                type="button"
                onClick={() => onAddNode(item.type)}
                className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <WorkflowDeleteDialog
        pendingDeleteCanvas={pendingDeleteCanvas}
        isPending={isCanvasTransitionPending}
        onCancel={() => setPendingDeleteCanvas(null)}
        onConfirm={() => {
          if (!pendingDeleteCanvas) {
            return;
          }

          const canvasId = pendingDeleteCanvas.id;
          setPendingDeleteCanvas(null);
          setOpenMenuCanvasId(null);
          onDeleteCanvas(canvasId);
        }}
      />
    </>
  );
}

export function WorkflowCommandBar({
  actions,
  isOpen,
  onClose,
}: {
  actions: WorkflowCommandAction[];
  isOpen: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const filteredActions = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return actions;
    }

    return actions.filter((action) => {
      const haystack = [
        action.label,
        action.description,
        action.group,
        ...(action.keywords ?? []),
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [actions, deferredQuery]);

  const groupedActions = useMemo(() => {
    const groups = new Map<string, WorkflowCommandAction[]>();
    for (const action of filteredActions) {
      const bucket = groups.get(action.group) ?? [];
      bucket.push(action);
      groups.set(action.group, bucket);
    }

    return Array.from(groups.entries());
  }, [filteredActions]);

  if (!isOpen) {
    return null;
  }

  return (
    <OverlayShell onClose={onClose}>
      <div className="absolute left-1/2 top-[14vh] w-full max-w-2xl -translate-x-1/2 px-5" onClick={(event) => event.stopPropagation()}>
        <div className="overflow-hidden rounded-[32px] border border-white/10 bg-[#050505] shadow-[0_28px_120px_rgba(0,0,0,0.6)]">
          <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4 text-zinc-300">
            <Command className="h-4 w-4 text-zinc-500" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search nodes, workflows, runs, publish..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-500"
            />
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[68vh] overflow-y-auto px-4 py-4">
            {groupedActions.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-8 text-center text-sm text-zinc-400">
                No matching command.
              </div>
            ) : (
              <div className="space-y-5">
                {groupedActions.map(([group, groupActions]) => (
                  <div key={group}>
                    <div className="mb-2 px-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">{group}</div>
                    <div className="space-y-2">
                      {groupActions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          onClick={() => {
                            action.perform();
                            onClose();
                          }}
                          className="flex w-full items-start justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:bg-white/[0.06]"
                        >
                          <div>
                            <div className="text-sm font-medium text-white">{action.label}</div>
                            <div className="mt-1 text-sm text-zinc-400">{action.description}</div>
                          </div>
                          <Command className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </OverlayShell>
  );
}

function HistoryEntryCard({
  entry,
  onRestore,
}: {
  entry: WorkflowCanvasHistoryEntry;
  onRestore: (entry: WorkflowCanvasHistoryEntry) => void;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-[0.16em] ${
              entry.kind === 'published'
                ? 'border border-sky-500/30 bg-sky-500/10 text-sky-200'
                : 'border border-amber-500/30 bg-amber-500/10 text-amber-200'
            }`}>
              {entry.kind}
            </span>
            <span className="text-xs text-zinc-500">Revision {entry.revision}</span>
          </div>
          <div className="mt-3 text-sm font-medium text-white">{entry.title}</div>
          <div className="mt-1 text-xs text-zinc-500">{new Date(entry.created_at).toLocaleString()}</div>
        </div>
        <button
          type="button"
          onClick={() => onRestore(entry)}
          className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 transition hover:bg-emerald-500/20"
        >
          Restore
        </button>
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs text-zinc-400">
        <History className="h-3.5 w-3.5" />
        {entry.graph.nodes.length} nodes • {entry.graph.edges.length} connections
      </div>
    </div>
  );
}

export function WorkflowHistoryPanel({
  entries,
  error,
  isLoading,
  isOpen,
  onClose,
  onRestore,
}: {
  entries: WorkflowCanvasHistoryEntry[];
  error: string | null;
  isLoading: boolean;
  isOpen: boolean;
  onClose: () => void;
  onRestore: (entry: WorkflowCanvasHistoryEntry) => void;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <OverlayShell onClose={onClose}>
      <aside className="absolute inset-y-0 right-0 flex w-[420px] flex-col border-l border-white/10 bg-[#050505] shadow-[0_28px_120px_rgba(0,0,0,0.55)]" onClick={(event) => event.stopPropagation()}>
        <div className="border-b border-white/10 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Workflow history</div>
              <div className="mt-2 text-lg font-semibold text-white">Draft checkpoints and published snapshots</div>
              <div className="mt-1 text-sm text-zinc-400">Restore a previous state into the current draft.</div>
            </div>
            <button
              type="button"
              aria-label="Close history panel"
              onClick={onClose}
              className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {isLoading ? (
            <div className="rounded-3xl border border-white/10 bg-white/[0.03] px-5 py-8 text-sm text-zinc-400">
              Loading workflow history...
            </div>
          ) : error ? (
            <div className="rounded-3xl border border-rose-500/30 bg-rose-500/10 px-5 py-8 text-sm text-rose-100">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] px-5 py-8 text-sm text-zinc-400">
              No snapshots yet. Draft checkpoints appear after saves, and published states appear here after publish.
            </div>
          ) : (
            <div className="space-y-3">
              {entries.map((entry) => (
                <HistoryEntryCard key={entry.id} entry={entry} onRestore={onRestore} />
              ))}
            </div>
          )}
        </div>
      </aside>
    </OverlayShell>
  );
}

export function WorkflowAssistantLauncher({
  creditsLabel,
  onOpen,
}: {
  creditsLabel: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3.5 py-2 text-sm text-violet-100 transition hover:bg-violet-500/20"
    >
      <Bot className="h-4 w-4" />
      AI Builder
      {creditsLabel ? (
        <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-300">
          {creditsLabel}
        </span>
      ) : (
        <Sparkles className="h-3.5 w-3.5 text-violet-200" />
      )}
    </button>
  );
}
