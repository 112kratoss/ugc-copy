'use client';

import Link from 'next/link';
import { AlertCircle, ArrowRight, Image as ImageIcon, Music, Play } from 'lucide-react';
import { useMemo, useSyncExternalStore } from 'react';

import { StudioGenerationStatus } from '@/components/CreatorStudio';
import { Kicker, Text } from '@/components/DesignSystem';
import type { CreatorToolAccent } from '@/lib/creator-tools';
import {
  rankHomeWorkspaceGenerations,
  type HomeWorkspaceGenerationView,
} from '@/lib/home-dashboard';
import { subscribeToGenerationStatusSynced } from '@/lib/generation-status-client';
import {
  estimateGenerationDurationMs,
  formatTimeAgoShort,
  normalizeStoredGenerationTiming,
  withGenerationTimingEstimate,
  type GenerationKind,
} from '@/lib/generation-timing';
import { useTicker } from '@/lib/use-ticker';
import { useMediaQuery } from '@/lib/use-media-query';

/**
 * The poller's sessionStorage snapshot, consumed as an external store: the
 * app-wide `GenerationNotifications` poller writes the cache and then fires
 * the status-sync broadcast, which acts as this store's change notifier.
 * `useSyncExternalStore` keeps hydration safe — the server snapshot is empty,
 * and the freshest statuses apply on the first post-mount render.
 */
function subscribeToStatusStore(notify: () => void) {
  return subscribeToGenerationStatusSynced(notify);
}

function readStatusStoreSnapshot(): string {
  try {
    return window.sessionStorage.getItem(STATUS_CACHE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function readStatusStoreServerSnapshot(): string {
  return '';
}

function parseStatusSnapshot(raw: string): Array<{ id: string; status: string }> {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.entries(parsed).map(([id, status]) => ({ id, status }));
  } catch {
    return [];
  }
}

const STATUS_CACHE_STORAGE_KEY = 'magicbooklet:generation-status-cache:v1';

interface WorkspaceCardProps {
  initialGenerations: HomeWorkspaceGenerationView[];
  variant?: 'rail' | 'inline';
}

function toGenerationKind(view: HomeWorkspaceGenerationView): GenerationKind {
  switch (view.mediaKind) {
    case 'audio':
      return 'audio';
    case 'video':
      return view.category === 'motion' ? 'motion' : 'video';
    default:
      return view.category === 'motion' ? 'motion' : (view.mediaKind ?? 'image');
  }
}

const KIND_ACCENTS: Record<GenerationKind, CreatorToolAccent> = {
  image: 'blue',
  video: 'rose',
  motion: 'violet',
  audio: 'amber',
};

const KIND_LABELS: Record<GenerationKind, string> = {
  image: 'Image',
  video: 'Video',
  motion: 'Motion',
  audio: 'Audio',
};

function KindGlyph({ kind, className }: { kind: GenerationKind; className?: string }) {
  const Icon = kind === 'audio' ? Music : kind === 'image' ? ImageIcon : Play;
  return <Icon className={className} aria-hidden />;
}

function applyStatusUpdate(
  views: HomeWorkspaceGenerationView[],
  updates: Array<{ id: string; status: string; completed_at?: string | null }>,
): HomeWorkspaceGenerationView[] {
  if (updates.length === 0) return views;

  const updateById = new Map(updates.map((update) => [update.id, update]));
  let changed = false;

  const next = views.map((view) => {
    const update = updateById.get(view.id);
    if (!update || update.status === view.status) return view;

    const status = update.status as HomeWorkspaceGenerationView['status'];
    if (!['pending', 'processing', 'waiting', 'succeeded', 'failed'].includes(status)) {
      return view;
    }

    changed = true;
    return {
      ...view,
      status,
      completedAt: update.completed_at ?? view.completedAt,
      isActive: status === 'pending' || status === 'processing' || status === 'waiting',
      isFailed: status === 'failed',
    };
  });

  return changed ? next : views;
}

/**
 * The signed-in workspace summary: active runs with live progress and the
 * most recent finished creations, each opening in Studio. Purely a consumer
 * of live data — `GenerationNotifications` owns the polling and broadcasts
 * every sync (`subscribeToGenerationStatusSynced`); this card never fetches
 * `/api/generations` itself.
 */
export default function WorkspaceCard({
  initialGenerations,
  variant = 'rail',
}: WorkspaceCardProps) {
  const statusSnapshot = useSyncExternalStore(
    subscribeToStatusStore,
    readStatusStoreSnapshot,
    readStatusStoreServerSnapshot,
  );

  const { active, recent } = useMemo(() => {
    const views = applyStatusUpdate(initialGenerations, parseStatusSnapshot(statusSnapshot));
    return rankHomeWorkspaceGenerations(views);
  }, [initialGenerations, statusSnapshot]);
  // The page renders this card twice, in the strip and in the rail, and the
  // stylesheet shows one of them per width. Only the shown one ticks, and only
  // the rail reads the clock: the strip shows a count, so a tick there would
  // re-render a phone's Home every second for nothing.
  const isRailWidth = useMediaQuery('(min-width: 80rem)');
  const isShown = variant === 'rail' ? isRailWidth : !isRailWidth;
  const nowMs = useTicker(active.length > 0 && isShown && variant === 'rail');

  // The strip only has news while something renders: the balance is the top
  // bar's, and a new creation starts from its Create menu.
  if (variant === 'inline') {
    if (active.length === 0) return null;
    return (
      <section aria-label="Workspace overview" className="ui-card mb-5 flex flex-wrap items-center gap-3 p-4">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-bold text-[var(--ui-text-secondary)]">
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-[var(--ui-primary)]" />
          {active.length === 1 ? '1 render in progress' : `${active.length} renders in progress`}
        </span>
        <Link
          href="/creations"
          prefetch={false}
          className="ui-focus-ring inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-xs font-bold text-[var(--ui-text-muted)] transition hover:text-[var(--ui-text-primary)]"
        >
          Open Studio
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </section>
    );
  }

  return (
    <section aria-label="Workspace overview" className="ui-card flex flex-col gap-4 p-5">
      {/* The one way to Studio from here, whether runs are going, done or none. */}
      <div className="flex items-center justify-between gap-3">
        <Kicker>Workspace</Kicker>
        <Link
          href="/creations"
          prefetch={false}
          className="ui-focus-ring inline-flex items-center gap-1 rounded-full text-xs font-bold text-[var(--ui-text-muted)] transition hover:text-[var(--ui-text-primary)]"
        >
          Open Studio
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>

      {active.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {active.map((view) => {
            const kind = toGenerationKind(view);
            // Timing text waits for the mounted clock (see useTicker).
            const timing = nowMs === null ? null : withGenerationTimingEstimate(
              normalizeStoredGenerationTiming({
                kind,
                status: view.status,
                createdAt: view.createdAt,
                completedAt: view.completedAt,
                nowMs,
              }),
              estimateGenerationDurationMs({ kind, model: view.model }),
            );

            return (
              <li key={view.id} className="rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-bold text-[var(--ui-text-muted)]">
                  <KindGlyph kind={kind} className="h-3.5 w-3.5" />
                  <span className="truncate">{view.title ?? `${KIND_LABELS[kind]} · ${view.model}`}</span>
                </div>
                {timing && nowMs !== null ? <StudioGenerationStatus accent={KIND_ACCENTS[kind]} timing={timing} nowMs={nowMs} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {recent.length > 0 ? (
        <div>
          <Text variant="label" className="mb-2 block text-[var(--ui-text-faint)]">Recent</Text>
          <ul className="grid grid-cols-4 gap-2">
            {recent.map((view) => {
              const kind = toGenerationKind(view);
              const label = view.title ?? `${KIND_LABELS[kind]} creation`;

              return (
                <li key={view.id}>
                  {/* Opens this creation in Studio, as an alert about it does. */}
                  <Link
                    href={`/creations?generation=${encodeURIComponent(view.id)}`}
                    prefetch={false}
                    className="ui-focus-ring group relative block aspect-square overflow-hidden rounded-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)]"
                    title={view.isFailed ? `${label} — failed` : label}
                  >
                    {view.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- tiny signed-URL thumb; next/image adds nothing here
                      <img
                        src={view.previewUrl}
                        alt={label}
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[var(--ui-text-faint)]">
                        <KindGlyph kind={kind} className="h-4 w-4" />
                      </span>
                    )}
                    {view.isFailed ? (
                      <span
                        aria-label="Generation failed"
                        className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-[rgba(12,12,14,0.78)] py-0.5 text-[10px] font-bold text-[#ff7c8b]"
                      >
                        <AlertCircle className="h-3 w-3" aria-hidden />
                        Failed
                      </span>
                    ) : null}
                    {nowMs !== null ? <span className="sr-only">{formatTimeAgoShort(Date.parse(view.createdAt), nowMs)}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {active.length === 0 && recent.length === 0 ? (
        <Text variant="bodySm" className="text-[var(--ui-text-muted)]">
          Nothing in flight yet — your next creation lands here with live progress.
        </Text>
      ) : null}
    </section>
  );
}
