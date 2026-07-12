'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowRight,
  Boxes,
  Check,
  Copy,
  Image as ImageIcon,
  ListFilter,
  Loader2,
  MoreHorizontal,
  Music2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Video,
  Workflow,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/app/components/AuthProvider';
import { getClientE2EAuthState } from '@/lib/e2e-auth';
import type {
  WorkflowCanvasListItem,
  WorkflowCanvasOutputKind,
  WorkflowCanvasPreview,
  WorkflowCanvasRecord,
  WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import { createWorkflowCanvasLibrarySummary } from '@/lib/workflow-canvas-preview';

type LibrarySort = 'recent' | 'name';
type LibraryDialog =
  | { kind: 'rename'; canvas: WorkflowCanvasListItem }
  | { kind: 'delete'; canvas: WorkflowCanvasListItem }
  | null;

const OUTPUT_META: Record<WorkflowCanvasOutputKind, { label: string; icon: typeof ImageIcon }> = {
  image: { label: 'Image', icon: ImageIcon },
  video: { label: 'Video', icon: Video },
  audio: { label: 'Audio', icon: Music2 },
};

function toCanvasListItem(canvas: WorkflowCanvasRecord): WorkflowCanvasListItem {
  return {
    id: canvas.id,
    title: canvas.title,
    updated_at: canvas.updated_at,
    revision: canvas.revision,
    status: canvas.status,
    published_at: canvas.published_at,
    ...createWorkflowCanvasLibrarySummary(canvas.graph),
  };
}

function formatEditedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Edited recently';
  }

  return `Edited ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)}`;
}

function getPreviewNodeColor(type: WorkflowNodeKind) {
  if (type === 'image-input' || type === 'video-input' || type === 'audio-input') return '#38bdf8';
  if (type === 'image-generate') return '#60a5fa';
  if (type === 'video-generate') return '#fb7185';
  if (type === 'motion-generate') return '#a78bfa';
  if (type === 'approval-gate') return '#34d399';
  if (type.includes('generate')) return '#fbbf24';
  if (type === 'note' || type === 'group') return '#71717a';
  return '#f59e0b';
}

function MiniGraphPreview({ preview }: { preview: WorkflowCanvasPreview }) {
  const dimensions = useMemo(() => {
    if (preview.nodes.length === 0) {
      return { nodeById: new Map<string, { x: number; y: number }>(), nodes: [] };
    }

    const xs = preview.nodes.map((node) => node.position.x);
    const ys = preview.nodes.map((node) => node.position.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    const nodes = preview.nodes.map((node) => ({
      ...node,
      x: 12 + ((node.position.x - minX) / width) * 196,
      y: 12 + ((node.position.y - minY) / height) * 96,
    }));

    return {
      nodes,
      nodeById: new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
    };
  }, [preview.nodes]);

  if (preview.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-600">
        <Workflow className="h-9 w-9" aria-hidden="true" />
      </div>
    );
  }

  return (
    <svg
      viewBox="0 0 220 120"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className="h-full w-full"
    >
      <rect width="220" height="120" rx="16" fill="#10b981" fillOpacity="0.045" />
      {preview.edges.map((edge, index) => {
        const source = dimensions.nodeById.get(edge.source);
        const target = dimensions.nodeById.get(edge.target);
        if (!source || !target) return null;
        const midpoint = (source.x + target.x) / 2;
        return (
          <path
            key={`${edge.source}-${edge.target}-${index}`}
            d={`M ${source.x} ${source.y} C ${midpoint} ${source.y}, ${midpoint} ${target.y}, ${target.x} ${target.y}`}
            fill="none"
            stroke="#3f3f46"
            strokeWidth="1.4"
          />
        );
      })}
      {dimensions.nodes.map((node) => (
        <g key={node.id} transform={`translate(${node.x - 7} ${node.y - 5})`}>
          <rect width="14" height="10" rx="3" fill="#09090b" stroke={getPreviewNodeColor(node.type)} strokeWidth="1.5" />
          <circle cx="14" cy="5" r="1.5" fill={getPreviewNodeColor(node.type)} />
        </g>
      ))}
    </svg>
  );
}

function DialogShell({
  children,
  labelledBy,
  onClose,
  restoreFocusTo,
}: {
  children: ReactNode;
  labelledBy: string;
  onClose: () => void;
  restoreFocusTo?: HTMLElement | null;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialogElement = dialogRef.current;
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';
    const initialFocus = dialogElement?.querySelector<HTMLElement>('[data-dialog-initial-focus="true"]')
      ?? dialogElement?.querySelector<HTMLElement>(focusableSelector)
      ?? dialogElement;
    initialFocus?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogElement) return;

      const focusable = [...dialogElement.querySelectorAll<HTMLElement>(focusableSelector)];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogElement.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (restoreFocusTo?.isConnected) {
        restoreFocusTo.focus();
      } else {
        previouslyFocused?.focus();
      }
    };
  }, [restoreFocusTo]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="w-full max-w-md rounded-[28px] border border-white/10 bg-[#080a09] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.72)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function WorkflowCard({
  canvas,
  isPending,
  menuOpen,
  onDelete,
  onDuplicate,
  onMenuChange,
  onOpen,
  onRename,
}: {
  canvas: WorkflowCanvasListItem;
  isPending: boolean;
  menuOpen: boolean;
  onDelete: (trigger: HTMLElement | null) => void;
  onDuplicate: () => void;
  onMenuChange: (open: boolean) => void;
  onOpen: () => void;
  onRename: (trigger: HTMLElement | null) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onMenuChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onMenuChange(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen, onMenuChange]);

  return (
    <article className="group relative overflow-visible rounded-[26px] border border-white/10 bg-[#0a0c0b] transition duration-200 hover:-translate-y-0.5 hover:border-emerald-400/25 hover:shadow-[0_24px_80px_rgba(0,0,0,0.38)] focus-within:border-emerald-400/35 motion-reduce:transform-none">
      <button
        type="button"
        onClick={onOpen}
        disabled={isPending}
        aria-label={`Open canvas ${canvas.title}`}
        className="block w-full rounded-t-[26px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400/70 disabled:cursor-wait disabled:opacity-60"
      >
        <div className="relative h-40 overflow-hidden rounded-t-[25px] border-b border-white/[0.07] bg-[radial-gradient(circle_at_30%_20%,rgba(16,185,129,0.12),transparent_45%),linear-gradient(145deg,#090b0a,#050505)] p-4">
          <div className="absolute inset-0 opacity-35 [background-image:radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.12)_1px,transparent_0)] [background-size:18px_18px]" />
          <div className="relative h-full">
            <MiniGraphPreview preview={canvas.preview} />
          </div>
          <span className="absolute left-4 top-4 rounded-full border border-white/10 bg-black/65 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-300 backdrop-blur-md">
            {canvas.status === 'published' ? 'Published' : 'Draft'}
          </span>
        </div>
      </button>

      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <button type="button" onClick={onOpen} disabled={isPending} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70">
            <h2 className="truncate text-lg font-semibold tracking-tight text-white">{canvas.title || 'Untitled workflow'}</h2>
            <p className="mt-1 text-xs text-zinc-500">{formatEditedAt(canvas.updated_at)}</p>
          </button>

          <div ref={menuRef} className="relative shrink-0">
            <button
              ref={menuButtonRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Actions for ${canvas.title}`}
              onClick={() => onMenuChange(!menuOpen)}
              disabled={isPending}
              className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-400 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 disabled:cursor-wait disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
            </button>
            {menuOpen ? (
              <div role="menu" aria-label={`${canvas.title} actions`} className="absolute right-0 top-full z-30 mt-2 w-48 rounded-2xl border border-white/10 bg-[#111312] p-1.5 shadow-[0_22px_70px_rgba(0,0,0,0.7)]">
                <button type="button" role="menuitem" onClick={() => onRename(menuButtonRef.current)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-zinc-200 hover:bg-white/[0.06]">
                  <Pencil className="h-4 w-4" /> Rename
                </button>
                <button type="button" role="menuitem" onClick={onDuplicate} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-zinc-200 hover:bg-white/[0.06]">
                  <Copy className="h-4 w-4" /> Duplicate
                </button>
                <button type="button" role="menuitem" onClick={() => onDelete(menuButtonRef.current)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-rose-200 hover:bg-rose-500/10">
                  <Trash2 className="h-4 w-4" /> Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex min-h-7 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-zinc-400">
            <Boxes className="h-3.5 w-3.5" /> {canvas.node_count} {canvas.node_count === 1 ? 'node' : 'nodes'}
          </span>
          {canvas.output_kinds.map((kind) => {
            const meta = OUTPUT_META[kind];
            const Icon = meta.icon;
            return (
              <span key={kind} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/[0.07] px-2.5 py-1 text-xs text-emerald-100">
                <Icon className="h-3.5 w-3.5" /> {meta.label}
              </span>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onOpen}
          disabled={isPending}
          className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-4 text-sm font-medium text-emerald-50 transition hover:bg-emerald-500/18 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 disabled:cursor-wait disabled:opacity-50"
        >
          Open canvas <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </article>
  );
}

export default function WorkflowLibraryClient() {
  const router = useRouter();
  const { session } = useAuth();
  const e2eAuth = useMemo(() => getClientE2EAuthState(), []);
  const effectiveSession = session ?? e2eAuth?.session ?? null;
  const [canvases, setCanvases] = useState<WorkflowCanvasListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingCanvasId, setPendingCanvasId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<LibrarySort>('recent');
  const [openMenuCanvasId, setOpenMenuCanvasId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<LibraryDialog>(null);
  const [dialogReturnFocus, setDialogReturnFocus] = useState<HTMLElement | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const authHeaders = useCallback(() => {
    const token = effectiveSession?.access_token;
    if (!token) throw new Error('Please log in to view your workflows.');
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }, [effectiveSession?.access_token]);

  const loadCanvases = useCallback(async () => {
    if (!effectiveSession?.user?.id) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await fetch('/api/workflow-canvases', { headers: authHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load workflows.');
      setCanvases(data.canvases as WorkflowCanvasListItem[]);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load workflows.');
    } finally {
      setIsLoading(false);
    }
  }, [authHeaders, effectiveSession?.user?.id]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      void loadCanvases();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [loadCanvases]);

  const visibleCanvases = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const filtered = normalizedQuery
      ? canvases.filter((canvas) => canvas.title.toLowerCase().includes(normalizedQuery))
      : canvases;

    return [...filtered].sort((left, right) => (
      sort === 'name'
        ? left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
        : right.updated_at.localeCompare(left.updated_at)
    ));
  }, [canvases, deferredQuery, sort]);

  const openCanvas = useCallback((canvasId: string) => {
    router.push(`/create-workflow?canvas=${encodeURIComponent(canvasId)}`);
  }, [router]);

  const createCanvas = useCallback(async () => {
    setIsCreating(true);
    setActionError(null);
    try {
      const response = await fetch('/api/workflow-canvases', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ title: `Workflow ${canvases.length + 1}` }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to create workflow.');
      openCanvas((data.canvas as WorkflowCanvasRecord).id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create workflow.');
      setIsCreating(false);
    }
  }, [authHeaders, canvases.length, openCanvas]);

  const duplicateCanvas = useCallback(async (canvas: WorkflowCanvasListItem) => {
    setOpenMenuCanvasId(null);
    setPendingCanvasId(canvas.id);
    setActionError(null);
    try {
      const detailResponse = await fetch(`/api/workflow-canvases/${canvas.id}`, { headers: authHeaders() });
      const detailData = await detailResponse.json();
      if (!detailResponse.ok) throw new Error(detailData.error || 'Failed to load workflow for duplication.');
      const source = detailData.canvas as WorkflowCanvasRecord;
      const createResponse = await fetch('/api/workflow-canvases', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ title: `Copy of ${canvas.title}`, graph: source.graph }),
      });
      const createData = await createResponse.json();
      if (!createResponse.ok) throw new Error(createData.error || 'Failed to duplicate workflow.');
      const created = createData.canvas as WorkflowCanvasRecord;
      setCanvases((current) => [toCanvasListItem(created), ...current]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to duplicate workflow.');
    } finally {
      setPendingCanvasId(null);
    }
  }, [authHeaders]);

  const renameCanvas = useCallback(async () => {
    if (dialog?.kind !== 'rename') return;
    const title = renameValue.trim();
    if (!title) return;
    const canvas = dialog.canvas;
    setPendingCanvasId(canvas.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/workflow-canvases/${canvas.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ title }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to rename workflow.');
      const updated = toCanvasListItem(data.canvas as WorkflowCanvasRecord);
      setCanvases((current) => current.map((item) => item.id === updated.id ? updated : item));
      setDialog(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to rename workflow.');
    } finally {
      setPendingCanvasId(null);
    }
  }, [authHeaders, dialog, renameValue]);

  const deleteCanvas = useCallback(async () => {
    if (dialog?.kind !== 'delete') return;
    const canvas = dialog.canvas;
    setPendingCanvasId(canvas.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/workflow-canvases/${canvas.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to delete workflow.');
      setCanvases((current) => current.filter((item) => item.id !== canvas.id));
      setDialog(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to delete workflow.');
    } finally {
      setPendingCanvasId(null);
    }
  }, [authHeaders, dialog]);

  return (
    <div className="relative min-h-[calc(100vh-4rem)] overflow-hidden bg-[#060706] text-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(circle_at_72%_0%,rgba(16,185,129,0.14),transparent_48%),radial-gradient(circle_at_18%_10%,rgba(52,211,153,0.07),transparent_34%)]" />
      <div className="relative mx-auto w-full max-w-[1500px] px-5 py-8 sm:px-8 lg:px-10 lg:py-12">
        <header className="flex flex-col gap-7 border-b border-white/10 pb-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-emerald-300">
              <Sparkles className="h-3.5 w-3.5" /> Workflow library
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl lg:text-5xl">Your creation systems, at a glance.</h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400 sm:text-base">
              Preview the shape of every workflow, open one to edit its graph, or duplicate a proven setup for your next idea.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void createCanvas()}
            disabled={isCreating}
            className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 shadow-[0_14px_45px_rgba(52,211,153,0.18)] transition hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-wait disabled:opacity-60"
          >
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {isCreating ? 'Creating…' : 'New workflow'}
          </button>
        </header>

        {actionError ? (
          <div role="alert" className="mt-6 flex items-start justify-between gap-4 rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            <span>{actionError}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setActionError(null)} className="shrink-0 rounded-full p-1 hover:bg-white/10"><X className="h-4 w-4" /></button>
          </div>
        ) : null}

        <section aria-label="Workflow controls" className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex min-h-12 w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 text-sm text-zinc-300 transition focus-within:border-emerald-400/35 sm:max-w-md">
            <Search className="h-4 w-4 text-zinc-500" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflows" className="w-full bg-transparent outline-none placeholder:text-zinc-600" />
            {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="rounded-full p-1 text-zinc-500 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button> : null}
          </label>
          <label className="flex min-h-12 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 text-sm text-zinc-300">
            <ListFilter className="h-4 w-4 text-zinc-500" />
            <span className="sr-only">Sort workflows</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)} className="bg-transparent pr-4 outline-none">
              <option value="recent" className="bg-zinc-950">Recently edited</option>
              <option value="name" className="bg-zinc-950">Name</option>
            </select>
          </label>
        </section>

        {isLoading ? (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading workflows">
            {[0, 1, 2].map((item) => <div key={item} className="h-[365px] animate-pulse rounded-[26px] border border-white/[0.07] bg-white/[0.025]" />)}
          </div>
        ) : loadError ? (
          <div className="mt-8 flex min-h-72 flex-col items-center justify-center rounded-[28px] border border-rose-500/20 bg-rose-500/[0.05] p-8 text-center">
            <RefreshCw className="h-8 w-8 text-rose-300" />
            <h2 className="mt-4 text-xl font-semibold">Your workflows could not be loaded</h2>
            <p className="mt-2 max-w-md text-sm text-zinc-400">{loadError}</p>
            <button type="button" onClick={() => void loadCanvases()} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 text-sm text-white hover:bg-white/[0.09]"><RefreshCw className="h-4 w-4" /> Try again</button>
          </div>
        ) : visibleCanvases.length > 0 ? (
          <section aria-label="Your workflows" className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {visibleCanvases.map((canvas) => (
              <WorkflowCard
                key={canvas.id}
                canvas={canvas}
                isPending={pendingCanvasId === canvas.id}
                menuOpen={openMenuCanvasId === canvas.id}
                onMenuChange={(open) => setOpenMenuCanvasId(open ? canvas.id : null)}
                onOpen={() => openCanvas(canvas.id)}
                onRename={(trigger) => {
                  setDialogReturnFocus(trigger);
                  setOpenMenuCanvasId(null);
                  setRenameValue(canvas.title);
                  setDialog({ kind: 'rename', canvas });
                }}
                onDuplicate={() => void duplicateCanvas(canvas)}
                onDelete={(trigger) => {
                  setDialogReturnFocus(trigger);
                  setOpenMenuCanvasId(null);
                  setDialog({ kind: 'delete', canvas });
                }}
              />
            ))}
          </section>
        ) : (
          <div className="mt-8 flex min-h-80 flex-col items-center justify-center rounded-[28px] border border-dashed border-white/10 bg-white/[0.018] p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-500/10 text-emerald-200"><Workflow className="h-7 w-7" /></div>
            <h2 className="mt-5 text-xl font-semibold">{canvases.length === 0 ? 'Build your first workflow' : 'No workflows match that search'}</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">{canvases.length === 0 ? 'Start with a flexible canvas, connect your media steps, and turn the result into a reusable template when it is ready.' : 'Try a shorter title or clear the search to see the full library.'}</p>
            {canvases.length === 0 ? (
              <button type="button" onClick={() => void createCanvas()} disabled={isCreating} className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-60"><Plus className="h-4 w-4" /> New workflow</button>
            ) : (
              <button type="button" onClick={() => setQuery('')} className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 text-sm text-white hover:bg-white/[0.08]"><X className="h-4 w-4" /> Clear search</button>
            )}
          </div>
        )}
      </div>

      {dialog?.kind === 'rename' ? (
        <DialogShell labelledBy="workflow-rename-title" onClose={() => pendingCanvasId ? undefined : setDialog(null)} restoreFocusTo={dialogReturnFocus}>
          <div className="flex items-start justify-between gap-4">
            <div><div className="text-[11px] uppercase tracking-[0.18em] text-emerald-300">Rename workflow</div><h2 id="workflow-rename-title" className="mt-3 text-xl font-semibold">Give this canvas a clear name</h2></div>
            <button type="button" aria-label="Close rename dialog" onClick={() => setDialog(null)} disabled={Boolean(pendingCanvasId)} className="rounded-full border border-white/10 p-2 text-zinc-400 hover:bg-white/[0.06]"><X className="h-4 w-4" /></button>
          </div>
          <label className="mt-6 block text-sm text-zinc-300">Workflow name<input autoFocus data-dialog-initial-focus="true" maxLength={80} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && renameValue.trim()) void renameCanvas(); }} className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 text-white outline-none focus:border-emerald-400/40" /></label>
          <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setDialog(null)} disabled={Boolean(pendingCanvasId)} className="min-h-11 rounded-full border border-white/10 px-4 text-sm text-zinc-300 hover:bg-white/[0.05]">Cancel</button><button type="button" onClick={() => void renameCanvas()} disabled={!renameValue.trim() || Boolean(pendingCanvasId)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-50">{pendingCanvasId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save name</button></div>
        </DialogShell>
      ) : null}

      {dialog?.kind === 'delete' ? (
        <DialogShell labelledBy="workflow-delete-title" onClose={() => pendingCanvasId ? undefined : setDialog(null)} restoreFocusTo={dialogReturnFocus}>
          <div className="text-[11px] uppercase tracking-[0.18em] text-rose-300">Delete workflow</div>
          <h2 id="workflow-delete-title" className="mt-3 text-xl font-semibold">Delete “{dialog.canvas.title || 'Untitled workflow'}”?</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">This permanently removes the canvas. Published templates created from it are not changed.</p>
          <div className="mt-6 flex justify-end gap-2"><button autoFocus data-dialog-initial-focus="true" type="button" onClick={() => setDialog(null)} disabled={Boolean(pendingCanvasId)} className="min-h-11 rounded-full border border-white/10 px-4 text-sm text-zinc-300 hover:bg-white/[0.05]">Cancel</button><button type="button" onClick={() => void deleteCanvas()} disabled={Boolean(pendingCanvasId)} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/12 px-5 text-sm font-medium text-rose-100 hover:bg-rose-500/20 disabled:opacity-50">{pendingCanvasId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete workflow</button></div>
        </DialogShell>
      ) : null}
    </div>
  );
}
