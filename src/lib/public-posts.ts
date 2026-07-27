import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { getCreatorDisplayName } from '@/lib/profile';
import {
  getPostResourceBundleDetailByPostId,
  type PostResourceBundleDetail,
} from '@/lib/post-resource-bundles-server';
import {
  resolvePostRemixCapability,
  type PostRemixCapability,
  type PostRemixTarget,
} from '@/lib/post-resource-bundles';
import { getPublicGenerationDetail } from '@/lib/public-generations';
import {
  deriveTitleFromBody,
  isMissingPostReviewStatusColumnError,
  isMissingPostTextColumnsError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
  summarizeBody,
  type PostReferenceRow,
} from '@/lib/posts-server';
import {
  buildLegacyPostMediaItems,
  loadPostMediaItemsMap,
  type PostMediaSummary,
} from '@/lib/post-media';
import { createServiceClient } from '@/lib/server-helpers';
import { buildVisualMediaDescriptor } from '@/lib/media-descriptor';
import { sanitizePublicPostContent } from '@/lib/post-public-content';
import {
  MAGICBOOKLET_SOURCE_KIND,
  normalizeShowcaseSourceKind,
  type RawShowcaseSourceKind,
  type ShowcaseCreator,
  type ShowcaseItemCategory,
  type ShowcaseMediaKind,
  type ShowcasePostFormat,
  type ShowcaseSourceKind,
} from '@/lib/showcase';

type PublicPostRow = {
  id: string;
  user_id: string | null;
  generation_id: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  output_url: string | null;
  showcase_asset_path: string | null;
  prompt: string | null;
  title: string | null;
  description: string | null;
  body: string | null;
  category: ShowcaseItemCategory;
  save_count: number | null;
  remix_count: number | null;
  share_count: number | null;
  share_visit_count: number | null;
  source_kind: RawShowcaseSourceKind;
  source_tool: string | null;
  review_status?: string | null;
  created_at: string;
  post_format: ShowcasePostFormat;
};

type ProfileSummary = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export interface PublicPostDetail {
  id: string;
  generationId: string | null;
  visibility: 'public' | 'unlisted';
  mediaUrl: string | null;
  mediaKind: ShowcaseMediaKind | null;
  mediaItems: PostMediaSummary[];
  model: string;
  title: string;
  description: string;
  prompt: string;
  body: string;
  category: ShowcaseItemCategory;
  postFormat: ShowcasePostFormat;
  saveCount: number;
  remixCount: number;
  shareCount: number;
  shareVisitCount: number;
  createdAt: string;
  sourceKind: ShowcaseSourceKind;
  sourceTool: string | null;
  creator: ShowcaseCreator;
  resourceBundle: PostResourceBundleDetail | null;
  canRemix: boolean;
  remixCapability: PostRemixCapability;
  remixTarget: PostRemixTarget;
}

async function fetchPublicPostRow(
  id: string
): Promise<PublicPostRow | null> {
  const adminSupabase = createServiceClient();

  const result = await adminSupabase
    .from('posts')
    .select('id, user_id, generation_id, visibility, output_url, showcase_asset_path, prompt, title, description, body, category, save_count, remix_count, share_count, share_visit_count, source_kind, source_tool, review_status, created_at, post_format')
    .eq('id', id)
    .is('archived_at', null)
    .in('visibility', ['public', 'unlisted'])
    .eq('review_status', 'visible')
    .maybeSingle();

  if (isMissingPostReviewStatusColumnError(result.error)) {
    logBackendError('cannot_enforce_the_public_post_moderation_boundary', { error: result.error });
    return null;
  }

  if (isMissingPostTextColumnsError(result.error)) {
    const legacyResult = await adminSupabase
      .from('posts')
      .select('id, user_id, generation_id, visibility, output_url, showcase_asset_path, prompt, title, description, category, save_count, remix_count, share_count, share_visit_count, source_kind, source_tool, review_status, created_at')
      .eq('id', id)
      .is('archived_at', null)
      .in('visibility', ['public', 'unlisted'])
      .eq('review_status', 'visible')
      .maybeSingle();

    if (isMissingPostReviewStatusColumnError(legacyResult.error)) {
      logBackendError('cannot_enforce_the_public_post_moderation_boundary', { error: legacyResult.error });
      return null;
    }

    if (legacyResult.error) {
      logBackendError('failed_to_fetch_public_post_detail', { error: legacyResult.error });
      throw legacyResult.error;
    }

    if (!legacyResult.data) {
      return null;
    }

    const legacyCategory = legacyResult.data.category as ShowcaseItemCategory;
    return {
      ...(legacyResult.data as Omit<PublicPostRow, 'body' | 'post_format'>),
      body: null,
      post_format: normalizeLegacyPostFormat(legacyCategory),
    };
  }

  if (result.error) {
    logBackendError('failed_to_fetch_public_post_detail', { error: result.error });
    throw result.error;
  }

  const row = (result.data as PublicPostRow | null) ?? null;
  return row?.review_status === 'visible' ? row : null;
}

export async function getPostReferenceForShowcaseId(
  id: string
): Promise<PostReferenceRow | null> {
  const adminSupabase = createServiceClient();
  try {
    const { data: directPost, error: directError } = await adminSupabase
      .from('posts')
      .select('id, user_id, generation_id, visibility, category, prompt, source_kind, archived_at, review_status')
      .eq('id', id)
      .is('archived_at', null)
      .in('visibility', ['public', 'unlisted'])
      .eq('review_status', 'visible')
      .maybeSingle();

    if (directError) {
      if (isMissingPostReviewStatusColumnError(directError)) {
        logBackendError('cannot_enforce_the_public_post_moderation_boundary', { error: directError });
        return null;
      }
      logBackendError('failed_to_resolve_showcase_post_by_id', { error: directError });
      throw directError;
    }

    if (directPost) {
      return directPost as PostReferenceRow;
    }

    const { data: legacyPost, error: legacyError } = await adminSupabase
      .from('posts')
      .select('id, user_id, generation_id, visibility, category, prompt, source_kind, archived_at, review_status')
      .eq('generation_id', id)
      .is('archived_at', null)
      .in('visibility', ['public', 'unlisted'])
      .eq('review_status', 'visible')
      .maybeSingle();

    if (legacyError) {
      if (isMissingPostReviewStatusColumnError(legacyError)) {
        logBackendError('cannot_enforce_the_public_post_moderation_boundary', { error: legacyError });
        return null;
      }
      logBackendError('failed_to_resolve_showcase_post_by_generation_id', { error: legacyError });
      throw legacyError;
    }

    return (legacyPost as PostReferenceRow | null) ?? null;
  } catch (error) {
    if (!isMissingPostsSchemaError(error)) {
      throw error;
    }

    const generation = await getPublicGenerationDetail(id);
    if (!generation) {
      return null;
    }

    return {
      id: generation.id,
      user_id: generation.creator.id,
      generation_id: generation.id,
      visibility: 'public',
      category: generation.category,
      prompt: generation.prompt,
      source_kind: MAGICBOOKLET_SOURCE_KIND,
    };
  }
}

export async function getPublicPostDetail(
  id: string,
  options?: {
    viewerUserId?: string | null;
    countryCode?: string | null;
  }
): Promise<PublicPostDetail | null> {
  const adminSupabase = createServiceClient();
  const viewerUserId = options?.viewerUserId ?? null;
  const countryCode = options?.countryCode ?? null;
  let row: PublicPostRow | null = null;

  try {
    row = await fetchPublicPostRow(id);
  } catch (error) {
    if (!isMissingPostsSchemaError(error)) {
      throw error;
    }

    const generation = await getPublicGenerationDetail(id);
    if (!generation) {
      return null;
    }

    const mediaKind = generation.category === 'image' ? 'image' : 'video';
    const preview = buildVisualMediaDescriptor({
      id: `${generation.id}:cover`,
      kind: mediaKind,
      url: generation.url,
      storageKey: generation.id,
      previewUrl: generation.previewUrl,
      previewStorageKey: generation.previewUrl,
      previewThumbhash: null,
      previewStatus: generation.previewUrl ? 'ready' : 'pending',
      expiresAt: null,
      width: null,
      height: null,
      durationSeconds: null,
    });

    return {
      id: generation.id,
      generationId: generation.id,
      visibility: 'public',
      mediaUrl: generation.url,
      mediaKind,
      mediaItems: [{
        id: `${generation.id}:cover`,
        mediaKey: 'media-1',
        url: generation.url,
        // This legacy generation-cover path has no post_media row behind it, so
        // there is no rendition to point at.
        renditionUrl: null,
        renditionStatus: 'skipped',
        previewUrl: generation.previewUrl,
        previewThumbhash: preview.thumbhash,
        previewStatus: preview.status,
        previewCacheKey: preview.cacheKey,
        gridReady: preview.gridReady,
        preview,
        mediaKind,
        contentType: null,
        originalName: null,
        width: null,
        height: null,
        durationSeconds: null,
        sortOrder: 0,
      }],
      model: generation.model,
      title: generation.title,
      description: generation.description,
      prompt: generation.prompt,
      body: '',
      category: generation.category,
      postFormat: 'media',
      saveCount: generation.saveCount,
      remixCount: generation.remixCount,
      shareCount: generation.shareCount,
      shareVisitCount: generation.shareVisitCount,
      createdAt: generation.createdAt,
      sourceKind: MAGICBOOKLET_SOURCE_KIND,
      sourceTool: null,
      creator: generation.creator,
      resourceBundle: null,
      canRemix: true,
      remixCapability: 'public',
      remixTarget: generation.category === 'video' ? 'video' : 'image',
    };
  }

  if (!row) {
    return null;
  }

  const mediaItemsMap = await loadPostMediaItemsMap(adminSupabase, [row.id]);
  const mediaItems = mediaItemsMap.get(row.id) ?? await buildLegacyPostMediaItems({
    supabase: adminSupabase,
    postId: row.id,
    row,
  });
  const coverMedia = mediaItems[0] ?? null;
  const mediaUrl = coverMedia?.url ?? null;
  const mediaKind = coverMedia?.mediaKind ?? null;
  if (row.post_format !== 'text' && !mediaUrl) {
    return null;
  }

  let creator: ShowcaseCreator = {
    id: null,
    username: null,
    name: 'Anonymous',
    avatar: null,
  };

  if (row.user_id) {
    const { data: profile, error: profileError } = await adminSupabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('id', row.user_id)
      .maybeSingle();

    if (profileError) {
      logBackendError('failed_to_fetch_public_post_creator_profile', { error: profileError });
    } else if (profile) {
      const typedProfile = profile as ProfileSummary;
      creator = {
        id: typedProfile.id,
        username: typedProfile.username,
        name: getCreatorDisplayName({
          displayName: typedProfile.display_name,
          username: typedProfile.username,
        }),
        avatar: typedProfile.avatar_url,
      };
    }
  }

  const resourceBundle = await getPostResourceBundleDetailByPostId(row.id, {
    viewerUserId,
    countryCode,
  });
  let model =
    normalizeShowcaseSourceKind(row.source_kind) === 'manual'
      ? 'manual'
      : row.source_tool ?? 'external';

  if (row.generation_id) {
    const { data: generation, error: generationError } = await adminSupabase
      .from('generations')
      .select('model')
      .eq('id', row.generation_id)
      .maybeSingle();

    if (generationError) {
      logBackendError('failed_to_fetch_post_generation_model', { error: generationError });
    } else if (generation?.model) {
      model = generation.model;
    }
  }

  const publicContent = sanitizePublicPostContent({
    prompt: row.prompt?.trim() || '',
    body: row.body?.trim() || '',
    description: row.description?.trim() || '',
    hasRecipe: Boolean(resourceBundle),
    isPaidRecipe: resourceBundle?.accessMode === 'paid',
  });
  const prompt = publicContent.prompt;
  const body = publicContent.body;
  const title =
    row.title?.trim() ||
    deriveTitleFromBody(body) ||
    (row.post_format === 'text' ? 'Untitled Note' : 'Untitled Creation');
  const description = publicContent.description;

  const remix = resolvePostRemixCapability({
    generationId: row.generation_id,
    postFormat: row.post_format,
    category: row.category,
    sourceKind: normalizeShowcaseSourceKind(row.source_kind),
    resourceBundle: resourceBundle
      ? {
          viewerCanAccess: resourceBundle.viewerCanAccess,
          allowRemix: resourceBundle.allowRemix,
          items: resourceBundle.resources?.items ?? resourceBundle.lockedPreview.itemPreviews,
        }
      : null,
  });

  return {
    id: row.id,
    generationId: row.generation_id,
    visibility: row.visibility === 'unlisted' ? 'unlisted' : 'public',
    mediaUrl,
    mediaKind,
    mediaItems,
    model,
    title,
    description,
    prompt,
    body,
    category: row.category,
    postFormat: row.post_format,
    saveCount: row.save_count ?? 0,
    remixCount: row.remix_count ?? 0,
    shareCount: row.share_count ?? 0,
    shareVisitCount: row.share_visit_count ?? 0,
    createdAt: row.created_at,
    sourceKind: normalizeShowcaseSourceKind(row.source_kind),
    sourceTool: row.source_tool,
    creator,
    resourceBundle,
    canRemix: remix.capability === 'public' && remix.target !== 'workflow' && remix.target !== 'text_template',
    remixCapability: remix.capability,
    remixTarget: remix.target,
  };
}

export function getPublicPostMetaDescription(detail: PublicPostDetail): string {
  return (
    detail.description ||
    summarizeBody(detail.body) ||
    detail.resourceBundle?.summary ||
    detail.resourceBundle?.previewText ||
    detail.prompt ||
    `Explore ${detail.title} on magicbooklet.`
  );
}
