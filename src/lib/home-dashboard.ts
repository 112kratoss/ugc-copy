import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';

/**
 * Pure projection/ranking logic for the signed-in home dashboard. The service
 * layer (`home-dashboard-service.ts`) feeds this module rows from
 * `listOwnerGenerationsForRoute` (detail=summary) and catalog descriptors;
 * everything here stays synchronous and unit-testable.
 */

/**
 * Statuses that count as "in flight" on the workspace card. Includes
 * `pending` (a start that has not reached the provider yet) — Studio's own
 * buckets ignore it, but a dashboard promising live context must not.
 */
export const HOME_WORKSPACE_ACTIVE_STATUSES = ['processing', 'waiting', 'pending'] as const;

export type HomeWorkspaceGenerationStatus =
  | 'pending'
  | 'processing'
  | 'waiting'
  | 'succeeded'
  | 'failed';

export interface HomeWorkspaceGenerationView {
  id: string;
  status: HomeWorkspaceGenerationStatus;
  category: string | null;
  model: string;
  origin: 'template' | 'creation';
  title: string | null;
  createdAt: string;
  completedAt: string | null;
  previewUrl: string | null;
  mediaKind: 'image' | 'video' | 'audio' | null;
  outputCount: number | null;
  isActive: boolean;
  isFailed: boolean;
}

const ACTIVE_STATUS_SET = new Set<string>(HOME_WORKSPACE_ACTIVE_STATUSES);

function normalizeStatus(value: unknown): HomeWorkspaceGenerationStatus | null {
  if (typeof value !== 'string') return null;
  // Legacy rows predating the succeeded/failed settlement split.
  if (value === 'completed') return 'succeeded';
  if (
    value === 'pending'
    || value === 'processing'
    || value === 'waiting'
    || value === 'succeeded'
    || value === 'failed'
  ) {
    return value;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveMediaKind(
  media: Record<string, unknown> | null,
  category: string | null,
): HomeWorkspaceGenerationView['mediaKind'] {
  const mediaKind = readString(media?.kind);
  if (mediaKind === 'image' || mediaKind === 'video') {
    return mediaKind;
  }

  switch (category) {
    case 'image':
      return 'image';
    case 'video':
    case 'motion':
      return 'video';
    case 'audio':
    case 'voiceover':
    case 'sound-effect':
      return 'audio';
    default:
      return null;
  }
}

/**
 * Projects one `detail=summary` row from `listOwnerGenerationsForRoute` into
 * the dashboard view. Returns null for rows missing the essentials so a
 * malformed row degrades to "not shown" instead of a crashed card.
 */
export function toHomeWorkspaceGenerationView(
  row: Record<string, unknown>,
): HomeWorkspaceGenerationView | null {
  const id = readString(row.id);
  const createdAt = readString(row.created_at);
  const status = normalizeStatus(row.status);
  if (!id || !createdAt || !status) {
    return null;
  }

  const media = row.media && typeof row.media === 'object'
    ? (row.media as Record<string, unknown>)
    : null;
  const category = readString(row.category);
  const previewUrl = readString(row.preview_url)
    ?? readString(media?.previewUrl)
    ?? (resolveMediaKind(media, category) === 'image' ? readString(media?.url) : null);

  return {
    id,
    status,
    category,
    model: readString(row.model) ?? 'unknown',
    origin: row.origin === 'template' ? 'template' : 'creation',
    title: readString(row.title),
    createdAt,
    completedAt: readString(row.completed_at),
    previewUrl,
    mediaKind: resolveMediaKind(media, category),
    outputCount: typeof row.output_count === 'number' ? row.output_count : null,
    isActive: ACTIVE_STATUS_SET.has(status),
    isFailed: status === 'failed',
  };
}

export interface RankedHomeWorkspaceGenerations {
  active: HomeWorkspaceGenerationView[];
  recent: HomeWorkspaceGenerationView[];
}

function byCreatedAtDesc(a: HomeWorkspaceGenerationView, b: HomeWorkspaceGenerationView): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * Workspace ordering decided with the user: everything in flight first
 * (newest run on top), then the most recent finished creations regardless of
 * outcome — failures stay visible inline (flagged via `isFailed`) rather than
 * being buried in a separate lane.
 */
export function rankHomeWorkspaceGenerations(
  views: HomeWorkspaceGenerationView[],
  { maxRecent = 4 }: { maxRecent?: number } = {},
): RankedHomeWorkspaceGenerations {
  const active = views.filter((view) => view.isActive).sort(byCreatedAtDesc);
  const recent = views
    .filter((view) => !view.isActive)
    .sort(byCreatedAtDesc)
    .slice(0, Math.max(0, maxRecent));

  return { active, recent };
}

export interface HomeWhatsNewModel {
  id: string;
  kind: GenerationModelDescriptor['kind'];
  displayName: string;
  description: string;
  badge: string | null;
  href: string;
  accent: 'image' | 'video' | 'motion';
}

const MODEL_CREATE_PATHS: Record<GenerationModelDescriptor['kind'], string> = {
  image: '/create-image',
  video: '/create-video',
  motion: '/create-motion',
};

function toHomeWhatsNewModel(model: GenerationModelDescriptor): HomeWhatsNewModel {
  return {
    id: model.id,
    kind: model.kind,
    displayName: model.displayName,
    description: model.description,
    badge: model.badge,
    href: `${MODEL_CREATE_PATHS[model.kind]}?model=${encodeURIComponent(model.id)}`,
    accent: model.kind,
  };
}

/**
 * "What's new" selection: models the catalog flags with a `New` badge
 * (case-insensitive — the badge is free text). When a release carries no New
 * badges the card falls back to the head of the catalog, which arrives
 * pre-sorted by `sortOrder`, so the card never renders empty while models
 * exist.
 */
export function selectWhatsNewModels(
  models: GenerationModelDescriptor[],
  limit = 4,
): HomeWhatsNewModel[] {
  if (limit <= 0) {
    return [];
  }

  const flaggedNew = models.filter(
    (model) => model.badge?.trim().toLowerCase() === 'new',
  );
  const selected = flaggedNew.length > 0 ? flaggedNew : models;

  return selected.slice(0, limit).map(toHomeWhatsNewModel);
}
