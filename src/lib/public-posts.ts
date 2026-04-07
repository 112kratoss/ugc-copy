import 'server-only';

import { getCreatorDisplayName } from '@/lib/profile';
import {
  getPostResourceBundleDetailByPostId,
  type PostResourceBundleDetail,
} from '@/lib/post-resource-bundles-server';
import { getPublicGenerationDetail } from '@/lib/public-generations';
import {
  canRemixPost,
  deriveTitleFromBody,
  getPostMediaKind,
  isMissingPostTextColumnsError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
  resolvePostMediaUrl,
  summarizeBody,
  type PostReferenceRow,
} from '@/lib/posts-server';
import { createServiceClient } from '@/lib/server-helpers';
import type {
  ShowcaseCreator,
  ShowcaseItemCategory,
  ShowcaseMediaKind,
  ShowcasePostFormat,
  ShowcaseSourceKind,
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
  source_kind: ShowcaseSourceKind;
  source_tool: string | null;
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
}

async function fetchPublicPostRow(
  id: string
): Promise<PublicPostRow | null> {
  const adminSupabase = createServiceClient();

  let result = await adminSupabase
    .from('posts')
    .select('id, user_id, generation_id, visibility, output_url, showcase_asset_path, prompt, title, description, body, category, save_count, remix_count, share_count, share_visit_count, source_kind, source_tool, created_at, post_format')
    .eq('id', id)
    .in('visibility', ['public', 'unlisted'])
    .maybeSingle();

  if (isMissingPostTextColumnsError(result.error)) {
    const legacyResult = await adminSupabase
      .from('posts')
      .select('id, user_id, generation_id, visibility, output_url, showcase_asset_path, prompt, title, description, category, save_count, remix_count, share_count, share_visit_count, source_kind, source_tool, created_at')
      .eq('id', id)
      .in('visibility', ['public', 'unlisted'])
      .maybeSingle();

    if (legacyResult.error) {
      console.error('Failed to fetch public post detail:', legacyResult.error);
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
    console.error('Failed to fetch public post detail:', result.error);
    throw result.error;
  }

  return (result.data as PublicPostRow | null) ?? null;
}

export async function getPostReferenceForShowcaseId(
  id: string
): Promise<PostReferenceRow | null> {
  const adminSupabase = createServiceClient();
  try {
    const { data: directPost, error: directError } = await adminSupabase
      .from('posts')
      .select('id, generation_id, visibility, category, prompt, source_kind')
      .eq('id', id)
      .maybeSingle();

    if (directError) {
      console.error('Failed to resolve showcase post by id:', directError);
      throw directError;
    }

    if (directPost) {
      return directPost as PostReferenceRow;
    }

    const { data: legacyPost, error: legacyError } = await adminSupabase
      .from('posts')
      .select('id, generation_id, visibility, category, prompt, source_kind')
      .eq('generation_id', id)
      .maybeSingle();

    if (legacyError) {
      console.error('Failed to resolve showcase post by generation id:', legacyError);
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
      generation_id: generation.id,
      visibility: 'public',
      category: generation.category,
      prompt: generation.prompt,
      source_kind: 'ugc_copy',
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

    return {
      id: generation.id,
      generationId: generation.id,
      visibility: 'public',
      mediaUrl: generation.url,
      mediaKind: generation.category === 'image' ? 'image' : 'video',
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
      sourceKind: 'ugc_copy',
      sourceTool: null,
      creator: generation.creator,
      resourceBundle: null,
      canRemix: true,
    };
  }

  if (!row) {
    return null;
  }

  const mediaUrl = await resolvePostMediaUrl(adminSupabase, row);
  const mediaKind = getPostMediaKind(row.category, row.post_format);
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
      console.error('Failed to fetch public post creator profile:', profileError);
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
    row.source_kind === 'manual'
      ? 'manual'
      : row.source_tool ?? 'external';

  if (row.generation_id) {
    const { data: generation, error: generationError } = await adminSupabase
      .from('generations')
      .select('model')
      .eq('id', row.generation_id)
      .maybeSingle();

    if (generationError) {
      console.error('Failed to fetch post generation model:', generationError);
    } else if (generation?.model) {
      model = generation.model;
    }
  }

  const prompt = resourceBundle ? '' : row.prompt?.trim() || '';
  const body = row.body?.trim() || '';
  const title =
    row.title?.trim() ||
    deriveTitleFromBody(body) ||
    (row.post_format === 'text' ? 'Untitled Note' : 'Untitled Creation');
  const description = row.description?.trim() || '';

  return {
    id: row.id,
    generationId: row.generation_id,
    visibility: row.visibility === 'unlisted' ? 'unlisted' : 'public',
    mediaUrl,
    mediaKind,
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
    sourceKind: row.source_kind,
    sourceTool: row.source_tool,
    creator,
    resourceBundle,
    canRemix: canRemixPost(row.generation_id) && (!resourceBundle?.allowRemix || resourceBundle.viewerCanAccess),
  };
}

export function getPublicPostMetaDescription(detail: PublicPostDetail): string {
  return (
    detail.description ||
    summarizeBody(detail.body) ||
    detail.resourceBundle?.summary ||
    detail.resourceBundle?.previewText ||
    detail.prompt ||
    `Explore ${detail.title} on UGC copy.`
  );
}
