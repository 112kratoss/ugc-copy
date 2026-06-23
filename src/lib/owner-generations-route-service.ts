import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildLegacyGenerationInputMedia,
  loadGenerationInputMediaMap,
} from '@/lib/generation-input-media';
import { buildGenerationPaywallPrefill } from '@/lib/generation-paywall';
import { getStoredMediaLocation, resolveStoredMediaUrl } from '@/lib/server-helpers';
import { classifyVisualMedia } from '@/lib/media-contract';
import { buildVisualMediaDescriptor, type MediaPreviewStatus } from '@/lib/media-descriptor';

export type OwnerGenerationsRouteClient = SupabaseClient;

type GenerationRow = {
  id: string;
  output_url: string | null;
  preview_url?: string | null;
  thumbnail_url?: string | null;
  preview_thumbhash?: string | null;
  preview_status?: MediaPreviewStatus;
  creation_mode?: 'motion' | null;
  showcase_asset_path?: string | null;
  status: string;
  created_at: string;
  completed_at?: string | null;
  workflow_settings?: unknown;
  model: string;
  category?: string | null;
  prompt?: string | null;
};

type LinkedPostRow = {
  id: string;
  generation_id: string | null;
  title: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
};

export type OwnerGenerationsRoutePayload = {
  generations: Array<Record<string, unknown>>;
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

const DEFAULT_GENERATIONS_PAGE_LIMIT = 80;
const MAX_GENERATIONS_PAGE_LIMIT = 100;

function withoutWorkflowSettings<T extends { workflow_settings?: unknown }>(value: T): Omit<T, 'workflow_settings'> {
  const nextValue = { ...value };
  delete nextValue.workflow_settings;
  return nextValue;
}

function getWorkflowSettings(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getWorkflowOutputCount(workflowSettings: Record<string, unknown> | null): number | null {
  const outputs = workflowSettings?.outputs;
  return Array.isArray(outputs) && outputs.length > 0 ? outputs.length : null;
}

function inferVisualContentType(value: string | null): string | null {
  if (!value) return null;
  if (/\.(mp4|mov|m4v|webm)(\?|$)/i.test(value) || value.startsWith('generated_videos/')) return 'video/unknown';
  if (/\.(avif|gif|jpe?g|png|webp)(\?|$)/i.test(value) || value.startsWith('generated_images/')) return 'image/unknown';
  if (/\.(mp3|m4a|wav|aac)(\?|$)/i.test(value) || value.startsWith('generated_audio/')) return 'audio/unknown';
  return null;
}

async function getPersistedOutputUrls(
  workflowSettings: Record<string, unknown> | null,
  adminSupabase: OwnerGenerationsRouteClient,
): Promise<string[]> {
  const outputs = workflowSettings?.outputs;
  if (!Array.isArray(outputs)) {
    return [];
  }

  const urls = await Promise.all(
    outputs.map(async (output) => {
      if (!output || typeof output !== 'object') {
        return null;
      }

      const storagePath = (output as Record<string, unknown>).storagePath;
      if (typeof storagePath !== 'string' || !storagePath) {
        return null;
      }

      return resolveStoredMediaUrl(adminSupabase, storagePath);
    }),
  );

  return urls.filter((url): url is string => Boolean(url));
}

function resolveShowcaseAssetUrl(
  adminSupabase: OwnerGenerationsRouteClient,
  showcaseAssetPath: string,
): string {
  const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(showcaseAssetPath);
  return data.publicUrl;
}

async function resolveGenerationOutputUrl(
  adminSupabase: OwnerGenerationsRouteClient,
  generation: GenerationRow,
): Promise<string | null> {
  if (generation.showcase_asset_path) {
    return resolveShowcaseAssetUrl(adminSupabase, generation.showcase_asset_path);
  }

  if (!generation.output_url) {
    return null;
  }

  return resolveStoredMediaUrl(adminSupabase, generation.output_url);
}

async function resolveGenerationPreviewUrl(
  adminSupabase: OwnerGenerationsRouteClient,
  generation: GenerationRow,
  outputUrl: string | null,
): Promise<string | null> {
  const previewSource = generation.preview_url || generation.thumbnail_url || null;
  if (previewSource) {
    return resolveStoredMediaUrl(adminSupabase, previewSource);
  }

  if (generation.category === 'image') {
    return outputUrl;
  }

  return null;
}

type SupabaseSchemaError = {
  code?: string;
  message?: string;
};

function isMissingGenerationPreviewColumnError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message = '' } = error as SupabaseSchemaError;
  return (
    (code === '42703' || code === 'PGRST204')
    && /preview_(url|thumbhash|status)|thumbnail_url|creation_mode/.test(message)
  );
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

async function fetchOwnerGenerations({
  supabase,
  userId,
  includeArchived,
  requestedGenerationId,
  statusOnly,
  cursorOffset,
  pageLimit,
}: {
  supabase: OwnerGenerationsRouteClient;
  userId: string;
  includeArchived: boolean;
  requestedGenerationId: string | null;
  statusOnly: boolean;
  cursorOffset: number;
  pageLimit: number;
}): Promise<{ rows: GenerationRow[]; hasMore: boolean }> {
  const statusColumns = 'id, status, created_at, completed_at, model, category, archived_at';
  const baseColumns = 'id, output_url, showcase_asset_path, status, created_at, completed_at, duration, cost, model, category, is_public, title, description, prompt, workflow_settings, archived_at';
  const selectCandidates = statusOnly ? [statusColumns] : [
    `${baseColumns}, preview_url, thumbnail_url, preview_thumbhash, preview_status, creation_mode`,
    `${baseColumns}, preview_url, thumbnail_url`,
    `${baseColumns}, preview_url`,
    `${baseColumns}, thumbnail_url`,
    baseColumns,
  ];

  let lastPreviewColumnError: unknown = null;
  for (const columns of selectCandidates) {
    let query = supabase
      .from('generations')
      .select(columns)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (!includeArchived) {
      query = query.is('archived_at', null);
    }

    if (requestedGenerationId) {
      query = query.eq('id', requestedGenerationId).range(0, 0);
    } else {
      query = query.range(cursorOffset, cursorOffset + pageLimit);
    }

    const result = await query;

    if (result.error) {
      if (isMissingGenerationPreviewColumnError(result.error)) {
        lastPreviewColumnError = result.error;
        continue;
      }

      throw result.error;
    }

    const rows = (result.data || []) as unknown as GenerationRow[];
    const hasMore = requestedGenerationId ? false : rows.length > pageLimit;
    return {
      rows: hasMore ? rows.slice(0, pageLimit) : rows,
      hasMore,
    };
  }

  throw lastPreviewColumnError ?? new Error('Failed to fetch generations');
}

function buildPagination(pageLimit: number, hasMore: boolean, cursorOffset: number) {
  return {
    limit: pageLimit,
    hasMore,
    nextCursor: hasMore ? String(cursorOffset + pageLimit) : null,
  };
}

export async function listOwnerGenerationsForRoute({
  userId,
  supabase,
  getAdminSupabase,
  searchParams,
}: {
  userId: string;
  supabase: OwnerGenerationsRouteClient;
  getAdminSupabase: () => OwnerGenerationsRouteClient;
  searchParams: URLSearchParams;
}): Promise<OwnerGenerationsRoutePayload> {
  const includeArchived = searchParams.get('includeArchived') === 'true';
  const requestedGenerationId = searchParams.get('id')?.trim() || null;
  const detailMode = searchParams.get('detail');
  const summaryOnly = detailMode === 'summary';
  const statusOnly = detailMode === 'status';
  const requestedLimit = parsePositiveInteger(searchParams.get('limit'), DEFAULT_GENERATIONS_PAGE_LIMIT);
  const pageLimit = Math.min(requestedLimit, MAX_GENERATIONS_PAGE_LIMIT);
  const cursorOffset = Math.max(0, parsePositiveInteger(searchParams.get('cursor'), 0));

  const { rows: generations, hasMore } = await fetchOwnerGenerations({
    supabase,
    userId,
    includeArchived,
    requestedGenerationId,
    statusOnly,
    cursorOffset,
    pageLimit,
  });

  if (statusOnly) {
    return {
      generations: generations.map((generation) => ({
        id: generation.id,
        status: generation.status,
        created_at: generation.created_at,
        completed_at: generation.completed_at ?? null,
        category: generation.category ?? null,
        model: generation.model,
      })),
      pagination: buildPagination(pageLimit, hasMore, cursorOffset),
    };
  }

  const generationIds = generations.map((generation) => generation.id).filter(Boolean);
  const linkedPostMap = new Map<string, LinkedPostRow>();

  if (generationIds.length > 0) {
    let postsQuery = supabase
      .from('posts')
      .select('id, generation_id, title, visibility, archived_at')
      .in('generation_id', generationIds)
      .eq('user_id', userId);

    if (!includeArchived) {
      postsQuery = postsQuery.is('archived_at', null);
    }

    const postsResult = await postsQuery;
    if (postsResult.error) {
      console.error('Failed to load linked posts for generations:', postsResult.error);
    } else {
      for (const post of (postsResult.data ?? []) as LinkedPostRow[]) {
        if (post.generation_id) {
          linkedPostMap.set(post.generation_id, post);
        }
      }
    }
  }

  const adminSupabase = getAdminSupabase();
  const inputMediaMap = summaryOnly
    ? new Map()
    : await loadGenerationInputMediaMap({
      supabase: adminSupabase,
      generationIds,
      urlMode: 'signed',
    });

  const generationsWithUrls = await Promise.all(generations.map(async (generation) => {
    const workflowSettings = getWorkflowSettings(generation.workflow_settings);
    const outputCount = getWorkflowOutputCount(workflowSettings);
    const outputUrls = summaryOnly ? [] : await getPersistedOutputUrls(workflowSettings, adminSupabase);
    const durableInputMedia = inputMediaMap.get(generation.id) ?? [];
    const inputMedia = summaryOnly
      ? []
      : durableInputMedia.length > 0
        ? durableInputMedia
        : await buildLegacyGenerationInputMedia({
          supabase: adminSupabase,
          generationId: generation.id,
          ownerUserId: userId,
          category: generation.category ?? null,
          workflowSettings: workflowSettings ?? {},
        });
    const paywallPrefill = summaryOnly
      ? null
      : buildGenerationPaywallPrefill({
        category: generation.category,
        model: generation.model,
        prompt: generation.prompt,
        workflowSettings,
        inputMedia,
      });
    const outputUrl = await resolveGenerationOutputUrl(adminSupabase, generation);
    const previewUrl = await resolveGenerationPreviewUrl(adminSupabase, generation, outputUrl);
    const classification = classifyVisualMedia({
      category: generation.category,
      contentType: inferVisualContentType(generation.output_url),
    });
    const canonicalCategory = classification?.category ?? generation.category;
    const previewSource = generation.preview_url || generation.thumbnail_url || null;
    const previewStatus: MediaPreviewStatus = generation.preview_status
      ?? (previewSource ? 'ready' : 'pending');
    const expiresAt = getStoredMediaLocation(generation.output_url ?? '')
      ? new Date(Date.now() + 55 * 60 * 1000).toISOString()
      : null;
    const media = outputUrl && classification?.kind
      ? buildVisualMediaDescriptor({
        id: generation.id,
        kind: classification.kind,
        url: outputUrl,
        storageKey: generation.showcase_asset_path || generation.output_url || generation.id,
        previewUrl,
        previewStorageKey: previewSource,
        previewThumbhash: generation.preview_thumbhash ?? null,
        previewStatus,
        expiresAt,
        width: null,
        height: null,
        durationSeconds: typeof (generation as GenerationRow & { duration?: unknown }).duration === 'number'
          ? (generation as GenerationRow & { duration: number }).duration
          : null,
      })
      : null;
    const rest = withoutWorkflowSettings(generation);
    const linkedPost = linkedPostMap.get(generation.id);

    return {
      ...rest,
      category: canonicalCategory,
      creationMode: generation.creation_mode ?? classification?.creationMode ?? null,
      media,
      ...(outputUrl ? { output_url: outputUrl } : {}),
      preview_url: previewUrl,
      ...(outputCount !== null ? { output_count: outputCount } : {}),
      ...(outputUrls.length > 0 ? { output_urls: outputUrls } : {}),
      ...(summaryOnly ? {} : {
        input_media: inputMedia,
        paywallPrefill,
      }),
      linked_post_id: linkedPost?.id ?? null,
      linked_post_title: linkedPost?.title ?? null,
      linked_post_visibility: linkedPost?.visibility ?? null,
      linked_post_archived_at: linkedPost?.archived_at ?? null,
    };
  }));

  return {
    generations: generationsWithUrls,
    pagination: buildPagination(pageLimit, hasMore, cursorOffset),
  };
}
