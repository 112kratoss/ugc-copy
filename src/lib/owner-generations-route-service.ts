import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildLegacyGenerationInputMedia,
  loadGenerationInputMediaMap,
  type GenerationInputMediaItem,
} from '@/lib/generation-input-media';
import { buildGenerationPaywallPrefill } from '@/lib/generation-paywall';
import { classifyVisualMedia } from '@/lib/media-contract';
import { buildVisualMediaDescriptor, type MediaPreviewStatus } from '@/lib/media-descriptor';
import { getStoredMediaLocation } from '@/lib/media-urls';
import { resolveOwnedStoredMediaUrlMap } from '@/lib/owned-media-url-batch';

export type OwnerGenerationsRouteClient = SupabaseClient;

type GenerationRow = {
  id: string;
  output_url: string | null;
  preview_url?: string | null;
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
  template_run_id?: string | null;
  template_run_step_id?: string | null;
  studio_visible?: boolean;
};

type TemplateRunStudioRow = {
  id: string;
  template_id: string;
  result_generation_id: string;
};

type TemplateStudioMetadata = {
  runId: string;
  templateId: string;
  templateTitle: string | null;
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
const MAX_GENERATION_STATUS_IDS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function withoutWorkflowSettings<T extends { workflow_settings?: unknown }>(value: T): Omit<T, 'workflow_settings'> {
  const nextValue = { ...value };
  delete nextValue.workflow_settings;
  return nextValue;
}

export function projectGenerationForStudio(
  generation: GenerationRow,
  isTemplateResult: boolean,
): Record<string, unknown> {
  const projected = { ...withoutWorkflowSettings(generation) } as Record<string, unknown>;
  delete projected.template_run_id;
  delete projected.template_run_step_id;
  delete projected.studio_visible;
  if (isTemplateResult) {
    delete projected.prompt;
    projected.model = 'template-workflow';
  }
  return projected;
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

function getPersistedOutputStoragePaths(
  workflowSettings: Record<string, unknown> | null,
): string[] {
  const outputs = workflowSettings?.outputs;
  if (!Array.isArray(outputs)) {
    return [];
  }

  return outputs.flatMap((output) => {
    if (!output || typeof output !== 'object') {
      return [];
    }

    const storagePath = (output as Record<string, unknown>).storagePath;
    return typeof storagePath === 'string' && storagePath ? [storagePath] : [];
  });
}

function getPersistedOutputUrls(
  workflowSettings: Record<string, unknown> | null,
  resolvedMediaUrls: Map<string, string | null>,
): string[] {
  return getPersistedOutputStoragePaths(workflowSettings)
    .map((storagePath) => resolvedMediaUrls.get(storagePath) ?? null)
    .filter((url): url is string => Boolean(url));
}

function resolveShowcaseAssetUrl(
  adminSupabase: OwnerGenerationsRouteClient,
  showcaseAssetPath: string,
): string {
  const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(showcaseAssetPath);
  return data.publicUrl;
}

function resolveGenerationOutputUrl(
  adminSupabase: OwnerGenerationsRouteClient,
  generation: GenerationRow,
  resolvedMediaUrls: Map<string, string | null>,
): string | null {
  if (generation.showcase_asset_path) {
    return resolveShowcaseAssetUrl(adminSupabase, generation.showcase_asset_path);
  }

  if (!generation.output_url) {
    return null;
  }

  return resolvedMediaUrls.get(generation.output_url) ?? null;
}

function resolveGenerationPreviewUrl(
  generation: GenerationRow,
  outputUrl: string | null,
  resolvedMediaUrls: Map<string, string | null>,
): string | null {
  const previewSource = generation.preview_url || null;
  if (previewSource) {
    return resolvedMediaUrls.get(previewSource) ?? null;
  }

  if (generation.category === 'image') {
    return outputUrl;
  }

  return null;
}

function collectOwnerMediaUrlCandidates(
  generations: GenerationRow[],
  summaryOnly: boolean,
): string[] {
  const candidates = new Set<string>();

  for (const generation of generations) {
    if (!generation.showcase_asset_path && generation.output_url) {
      candidates.add(generation.output_url);
    }

    if (generation.preview_url) {
      candidates.add(generation.preview_url);
    }

    if (!summaryOnly) {
      for (const storagePath of getPersistedOutputStoragePaths(
        getWorkflowSettings(generation.workflow_settings),
      )) {
        candidates.add(storagePath);
      }
    }
  }

  return Array.from(candidates);
}

async function loadLinkedPostMap(params: {
  supabase: OwnerGenerationsRouteClient;
  generationIds: string[];
  userId: string;
  includeArchived: boolean;
}): Promise<Map<string, LinkedPostRow>> {
  const linkedPostMap = new Map<string, LinkedPostRow>();
  if (params.generationIds.length === 0) {
    return linkedPostMap;
  }

  let postsQuery = params.supabase
    .from('posts')
    .select('id, generation_id, title, visibility, archived_at')
    .in('generation_id', params.generationIds)
    .eq('user_id', params.userId);

  if (!params.includeArchived) {
    postsQuery = postsQuery.is('archived_at', null);
  }

  const postsResult = await postsQuery;
  if (postsResult.error) {
    logBackendError('failed_to_load_linked_posts_for_generations', { error: postsResult.error });
    return linkedPostMap;
  }

  for (const post of (postsResult.data ?? []) as LinkedPostRow[]) {
    if (post.generation_id) {
      linkedPostMap.set(post.generation_id, post);
    }
  }

  return linkedPostMap;
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

function parseRequestedGenerationIds(value: string | null) {
  if (value === null) return null;

  return Array.from(new Set(
    value
      .split(',')
      .map((candidate) => candidate.trim())
      .filter((candidate) => UUID_PATTERN.test(candidate)),
  )).slice(0, MAX_GENERATION_STATUS_IDS);
}

async function fetchOwnerGenerations({
  supabase,
  userId,
  includeArchived,
  requestedGenerationId,
  requestedGenerationIds,
  statusOnly,
  cursorOffset,
  pageLimit,
}: {
  supabase: OwnerGenerationsRouteClient;
  userId: string;
  includeArchived: boolean;
  requestedGenerationId: string | null;
  requestedGenerationIds: string[] | null;
  statusOnly: boolean;
  cursorOffset: number;
  pageLimit: number;
}): Promise<{ rows: GenerationRow[]; hasMore: boolean }> {
  const projectionColumns = 'template_run_id, template_run_step_id, studio_visible';
  const statusColumns = `id, status, created_at, completed_at, model, category, archived_at, ${projectionColumns}`;
  const baseColumns = `id, output_url, showcase_asset_path, status, created_at, completed_at, duration, cost, model, category, is_public, title, description, prompt, workflow_settings, archived_at, ${projectionColumns}`;
  const columns = statusOnly
    ? statusColumns
    : `${baseColumns}, preview_url, preview_thumbhash, preview_status, creation_mode`;

  let query = supabase
    .from('generations')
    .select(columns)
    .eq('user_id', userId)
    .or('and(template_run_id.is.null,template_run_step_id.is.null),studio_visible.eq.true')
    .order('created_at', { ascending: false });

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }

  if (requestedGenerationId) {
    query = query.eq('id', requestedGenerationId).range(0, 0);
  } else if (requestedGenerationIds) {
    query = query.in('id', requestedGenerationIds).range(0, Math.max(0, requestedGenerationIds.length - 1));
  } else {
    query = query.range(cursorOffset, cursorOffset + pageLimit);
  }

  const result = await query;

  if (result.error) {
    throw result.error;
  }

  const rows = (result.data || []) as unknown as GenerationRow[];
  const hasMore = requestedGenerationId || requestedGenerationIds ? false : rows.length > pageLimit;
  return {
    rows: hasMore ? rows.slice(0, pageLimit) : rows,
    hasMore,
  };
}

async function authorizeOwnerStudioProjection({
  adminSupabase,
  generations,
  userId,
}: {
  adminSupabase: OwnerGenerationsRouteClient;
  generations: GenerationRow[];
  userId: string;
}): Promise<{
  generations: GenerationRow[];
  templateMetadata: Map<string, TemplateStudioMetadata>;
}> {
  const candidateRunIds = Array.from(new Set(generations.flatMap((generation) => (
    generation.template_run_id ? [generation.template_run_id] : []
  ))));
  const templateMetadata = new Map<string, TemplateStudioMetadata>();

  if (candidateRunIds.length > 0) {
    const { data: runData, error: runError } = await adminSupabase
      .from('template_runs')
      .select('id, template_id, result_generation_id')
      .in('id', candidateRunIds)
      .eq('user_id', userId)
      .eq('status', 'succeeded')
      .eq('is_test', false);
    if (runError) throw runError;

    const runs = (runData ?? []) as unknown as TemplateRunStudioRow[];
    const templateIds = Array.from(new Set(runs.map((run) => run.template_id)));
    const templateTitles = new Map<string, string | null>();
    if (templateIds.length > 0) {
      const { data: templateData, error: templateError } = await adminSupabase
        .from('templates')
        .select('id, name')
        .in('id', templateIds);
      if (templateError) throw templateError;
      for (const template of (templateData ?? []) as Array<{ id: string; name: string | null }>) {
        templateTitles.set(template.id, template.name);
      }
    }

    for (const run of runs) {
      templateMetadata.set(run.result_generation_id, {
        runId: run.id,
        templateId: run.template_id,
        templateTitle: templateTitles.get(run.template_id) ?? null,
      });
    }
  }

  return {
    generations: generations.filter((generation) => {
      const isOrdinary = !generation.template_run_id && !generation.template_run_step_id;
      if (isOrdinary) return true;
      const metadata = templateMetadata.get(generation.id);
      return Boolean(
        generation.studio_visible === true
        && generation.status === 'succeeded'
        && generation.template_run_id
        && generation.template_run_step_id
        && metadata?.runId === generation.template_run_id,
      );
    }),
    templateMetadata,
  };
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
  const requestedGenerationIds = requestedGenerationId
    ? null
    : parseRequestedGenerationIds(searchParams.get('ids'));
  const detailMode = searchParams.get('detail');
  const summaryOnly = detailMode === 'summary';
  const statusOnly = detailMode === 'status';
  const requestedLimit = parsePositiveInteger(searchParams.get('limit'), DEFAULT_GENERATIONS_PAGE_LIMIT);
  const pageLimit = Math.min(requestedLimit, MAX_GENERATIONS_PAGE_LIMIT);
  const cursorOffset = Math.max(0, parsePositiveInteger(searchParams.get('cursor'), 0));

  if (requestedGenerationIds?.length === 0) {
    return {
      generations: [],
      pagination: buildPagination(pageLimit, false, 0),
    };
  }
  const adminSupabase = getAdminSupabase();
  const { rows: candidateGenerations, hasMore } = await fetchOwnerGenerations({
    supabase: adminSupabase,
    userId,
    includeArchived,
    requestedGenerationId,
    requestedGenerationIds,
    statusOnly,
    cursorOffset,
    pageLimit,
  });
  const {
    generations,
    templateMetadata,
  } = await authorizeOwnerStudioProjection({
    adminSupabase,
    generations: candidateGenerations,
    userId,
  });

  if (statusOnly) {
    return {
      generations: generations.map((generation) => {
        const template = templateMetadata.get(generation.id) ?? null;
        return {
          id: generation.id,
          status: generation.status,
          created_at: generation.created_at,
          completed_at: generation.completed_at ?? null,
          category: generation.category ?? null,
          model: template ? 'template-workflow' : generation.model,
          origin: template ? 'template' : 'creation',
          template,
        };
      }),
      pagination: buildPagination(pageLimit, hasMore, cursorOffset),
    };
  }

  const generationIds = generations.map((generation) => generation.id).filter(Boolean);
  const ordinaryGenerationIds = generationIds.filter((generationId) => !templateMetadata.has(generationId));
  const [linkedPostMap, inputMediaMap, resolvedMediaUrls] = await Promise.all([
    loadLinkedPostMap({
      supabase,
      generationIds,
      userId,
      includeArchived,
    }),
    summaryOnly
      ? Promise.resolve(new Map<string, GenerationInputMediaItem[]>())
      : loadGenerationInputMediaMap({
        supabase: adminSupabase,
        generationIds: ordinaryGenerationIds,
        urlMode: 'signed',
      }),
    resolveOwnedStoredMediaUrlMap({
      supabase: adminSupabase,
      outputUrls: collectOwnerMediaUrlCandidates(generations, summaryOnly),
      ownerUserId: userId,
    }),
  ]);

  const generationsWithUrls = await Promise.all(generations.map(async (generation) => {
    const template = templateMetadata.get(generation.id) ?? null;
    const workflowSettings = template ? null : getWorkflowSettings(generation.workflow_settings);
    const outputCount = getWorkflowOutputCount(workflowSettings);
    const outputUrls = summaryOnly ? [] : getPersistedOutputUrls(workflowSettings, resolvedMediaUrls);
    const durableInputMedia = inputMediaMap.get(generation.id) ?? [];
    const inputMedia = summaryOnly || template
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
    const paywallPrefill = summaryOnly || template
      ? null
      : buildGenerationPaywallPrefill({
        category: generation.category,
        model: generation.model,
        prompt: generation.prompt,
        workflowSettings,
        inputMedia,
      });
    const outputUrl = resolveGenerationOutputUrl(adminSupabase, generation, resolvedMediaUrls);
    const previewUrl = resolveGenerationPreviewUrl(generation, outputUrl, resolvedMediaUrls);
    const classification = classifyVisualMedia({
      category: generation.category,
      contentType: inferVisualContentType(generation.output_url),
    });
    const canonicalCategory = classification?.category ?? generation.category;
    const previewSource = generation.preview_url || null;
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
    const rest = projectGenerationForStudio(generation, Boolean(template));
    const linkedPost = linkedPostMap.get(generation.id);

    return {
      ...rest,
      origin: template ? 'template' : 'creation',
      template,
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
