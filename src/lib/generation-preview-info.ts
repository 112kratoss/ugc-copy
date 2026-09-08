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
 *
 * `signPreviewFor` names the generations that actually need the signature.
 * Only a cover with no poster of its own is grafted onto, but this map is
 * loaded for every generation-backed post on the page, and signing a private
 * preview for each of them was the single largest source of Storage signing
 * calls in the product — one fresh token per feed read, none of them reusable
 * by the CDN.
 *
 * It arrives as a promise on purpose. Callers derive it from their
 * `post_media` read, but only the *signing* depends on that read — the row
 * fetch below does not — so taking it unresolved lets this run beside the
 * caller's other queries instead of behind them. The showcase feed calls this
 * once per scan batch inside a filtering loop, where a sequential read would
 * have cost a round trip per batch rather than one per request.
 *
 * Omitting it signs every preview, which is the behaviour every caller had
 * before this argument existed. Note the returned `previewUrl` is now "signed
 * if the caller asked for it", not "signed whenever the generation has one":
 * a new consumer that needs a poster must widen the set, not just read the map.
 * The model is returned for every generation either way; callers read it
 * whether or not a poster is grafted.
 */
export async function loadGenerationPreviewInfoMap(
  adminSupabase: SupabaseClient,
  generationIds: string[],
  options?: { signPreviewFor?: PromiseLike<ReadonlySet<string>> },
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

  // Awaited only now, after the read above has already happened.
  const signPreviewFor = options?.signPreviewFor ? await options.signPreviewFor : null;

  const entries = await Promise.all((models ?? []).flatMap((generation) => {
    if (typeof generation.id !== 'string' || typeof generation.model !== 'string') return [];
    const previewSource =
      typeof generation.preview_url === 'string' && generation.preview_url
        ? generation.preview_url
        : null;
    const needsPreview = !signPreviewFor || signPreviewFor.has(generation.id);
    return [Promise.resolve(needsPreview && previewSource && generation.user_id
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
 * Whether a post's cover would use the linked generation's preview as its
 * poster — which is exactly when signing that private preview is worth doing.
 *
 * Callers deciding what to sign and the graft below must agree, or the graft
 * silently stops finding a poster it was promised (posts render poster-less)
 * or a signature is minted for a cover that already has one. One predicate,
 * used by both.
 */
export function coverNeedsGenerationPreview(
  mediaItems: PostMediaSummary[] | undefined,
): boolean {
  const cover = mediaItems?.[0];
  // No cover row at all means one is synthesised without a poster, so it does.
  return !cover || !cover.previewUrl;
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
  if (!generationInfo?.previewUrl || !mediaItems[0] || !coverNeedsGenerationPreview(mediaItems)) {
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
