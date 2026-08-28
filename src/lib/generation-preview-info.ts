import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import type { PostMediaSummary } from '@/lib/post-media';
import { toUsablePreviewSize, type PreviewSize } from '@/lib/preview-dimensions';
import { resolveOwnedStoredMediaUrl } from '@/lib/server-helpers';

export interface GenerationPreviewInfo {
  model: string;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
}

function previewSizeFields(size: PreviewSize | null) {
  return { previewWidth: size?.width ?? null, previewHeight: size?.height ?? null };
}

/**
 * Loads each generation's model and signed preview URL, keyed by generation id.
 * Shared by every surface that synthesises a cover for a post without
 * `post_media` rows (the showcase feed and the owner post list/detail), so a
 * generation-backed post renders its poster the same way everywhere.
 */
export async function loadGenerationPreviewInfoMap(
  adminSupabase: SupabaseClient,
  generationIds: string[],
): Promise<Map<string, GenerationPreviewInfo>> {
  const generationInfoMap = new Map<string, GenerationPreviewInfo>();
  const uniqueIds = Array.from(new Set(generationIds.filter(Boolean)));
  if (uniqueIds.length === 0) return generationInfoMap;

  type GenerationInfoRow = {
    id: string;
    user_id: string | null;
    model: string;
    preview_url?: string | null;
    preview_width?: number | null;
    preview_height?: number | null;
  };

  const modelsWithPreviewResult = await adminSupabase
    .from('generations')
    .select('id, user_id, model, preview_url, preview_width, preview_height, category')
    .in('id', uniqueIds);
  const models = modelsWithPreviewResult.data as GenerationInfoRow[] | null;
  const modelsError = modelsWithPreviewResult.error;

  if (modelsError) {
    logBackendError('error_fetching_showcase_generation_models', { error: modelsError });
    return generationInfoMap;
  }

  const entries = await Promise.all((models ?? []).flatMap((generation) => {
    if (typeof generation.id !== 'string' || typeof generation.model !== 'string') return [];
    const previewSource =
      typeof generation.preview_url === 'string' && generation.preview_url
        ? generation.preview_url
        : null;
    return [Promise.resolve(previewSource && generation.user_id
      ? resolveOwnedStoredMediaUrl(adminSupabase, previewSource, generation.user_id)
      : null)
      .then((previewUrl) => [generation.id, {
        model: generation.model,
        previewUrl,
        // One rule for a usable size, shared with the backfill that writes
        // the column and the pipeline that measures it.
        ...previewSizeFields(toUsablePreviewSize(generation.preview_width, generation.preview_height)),
      }] as const)];
  }));
  for (const [generationId, generationInfo] of entries) {
    generationInfoMap.set(generationId, generationInfo);
  }
  return generationInfoMap;
}

/**
 * Grafts the linked generation's preview onto a synthesised cover. Posts that
 * predate `post_media` (and creation posts whose derivative rows were removed
 * when they went private) are served `previewUrl: null`, which clients render
 * as a poster-less plate — the generation's own preview is the poster they
 * should show instead.
 */
export function graftGenerationPreviewOntoCover(
  mediaItems: PostMediaSummary[],
  generationInfo: GenerationPreviewInfo | null | undefined,
): PostMediaSummary[] {
  if (!generationInfo?.previewUrl || !mediaItems[0] || mediaItems[0].previewUrl) {
    return mediaItems;
  }

  const previewUrl = generationInfo.previewUrl;
  const cover = mediaItems[0];
  // Covers that predate `post_media` are synthesised with no dimensions,
  // and the grid needs an aspect ratio to lay a card out at its real
  // height instead of resizing it once the image has been measured. Only
  // filled in where nothing already knows better — a real media row's own
  // dimensions describe the source and always win.
  const previewWidth = cover.preview?.width ?? generationInfo.previewWidth;
  const previewHeight = cover.preview?.height ?? generationInfo.previewHeight;
  return [
    {
      ...cover,
      previewUrl,
      previewStatus: 'ready',
      gridReady: true,
      preview: {
        ...cover.preview,
        previewUrl,
        status: 'ready',
        gridReady: true,
        width: previewWidth,
        height: previewHeight,
      },
    },
    ...mediaItems.slice(1),
  ];
}
