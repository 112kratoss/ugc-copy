import 'server-only';

import { cache } from 'react';

import {
  canRemixPost,
  deriveTitleFromBody,
  getMarketplaceAssetSummaryMap,
  getPostMediaKind,
  isMissingPostTextColumnsError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
  resolvePostMediaUrl,
} from '@/lib/posts-server';
import { getCreatorDisplayName, normalizeUsername } from '@/lib/profile';
import {
  createServiceClient,
  resolveStoredMediaUrl,
} from '@/lib/server-helpers';
import type { ShowcaseFeedItem, ShowcaseItemCategory, ShowcasePostFormat } from '@/lib/showcase';

interface CreatorPostRow {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  prompt: string | null;
  title: string | null;
  body: string | null;
  category: ShowcaseItemCategory;
  post_format: ShowcasePostFormat;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  generation_id: string | null;
  source_kind: 'ugc_copy' | 'external' | 'manual';
  source_tool: string | null;
}

interface LegacyCreatorPostRow {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  prompt: string | null;
  title: string | null;
  category: ShowcaseItemCategory;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  generation_id: string | null;
  source_kind: 'ugc_copy' | 'external';
  source_tool: string | null;
}

interface LegacyCreatorGenerationRow {
  id: string;
  output_url: string | null;
  showcase_asset_path?: string | null;
  prompt: string | null;
  title: string | null;
  category: ShowcaseItemCategory | null;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  model: string;
}

export interface CreatorProfilePageData {
  profile: {
    id: string;
    username: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    coverUrl: string | null;
    websiteUrl: string | null;
    twitterHandle: string | null;
    instagramHandle: string | null;
    tiktokHandle: string | null;
    location: string | null;
  };
  stats: {
    publicCreations: number;
    totalSaves: number;
    totalRemixes: number;
  };
  items: ShowcaseFeedItem[];
}

function resolveItemCategory(category: ShowcaseItemCategory | null): ShowcaseItemCategory {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad' || category === 'text') {
    return category;
  }

  return 'image';
}

export const getCreatorProfilePageData = cache(async (rawUsername: string): Promise<CreatorProfilePageData | null> => {
  const username = normalizeUsername(rawUsername);
  if (!username) {
    return null;
  }

  const adminSupabase = createServiceClient();
  const { data: profile, error: profileError } = await adminSupabase
    .from('profiles')
    .select('id, username, display_name, bio, avatar_url, cover_url, website_url, twitter_handle, instagram_handle, tiktok_handle, location')
    .eq('username', username)
    .maybeSingle();

  if (profileError) {
    console.error('Failed to fetch creator profile:', profileError);
    throw profileError;
  }

  if (!profile) {
    return null;
  }

  let visibleRows: CreatorPostRow[] = [];
  let legacyItems: ShowcaseFeedItem[] | null = null;

  try {
    let result = await adminSupabase
      .from('posts')
      .select('id, output_url, showcase_asset_path, prompt, title, body, category, post_format, save_count, remix_count, created_at, generation_id, source_kind, source_tool')
      .eq('user_id', profile.id)
      .eq('visibility', 'public')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(24);

    if (isMissingPostTextColumnsError(result.error)) {
      const legacyResult = await adminSupabase
        .from('posts')
        .select('id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, generation_id, source_kind, source_tool')
        .eq('user_id', profile.id)
        .eq('visibility', 'public')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(24);

      if (legacyResult.error) {
        console.error('Failed to fetch creator posts:', legacyResult.error);
        throw legacyResult.error;
      }

      visibleRows = ((legacyResult.data ?? []) as LegacyCreatorPostRow[]).map((row) => ({
        ...row,
        body: null,
        post_format: normalizeLegacyPostFormat(row.category),
      }));
    } else {
      if (result.error) {
        console.error('Failed to fetch creator posts:', result.error);
        throw result.error;
      }

      visibleRows = (result.data ?? []) as CreatorPostRow[];
    }
  } catch (error) {
    if (!isMissingPostsSchemaError(error)) {
      throw error;
    }

    const selectWithAsset = 'id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, model';
    const selectWithoutAsset = 'id, output_url, prompt, title, category, save_count, remix_count, created_at, model';
    const legacyWithAssetResult = await adminSupabase
      .from('generations')
      .select(selectWithAsset)
      .eq('user_id', profile.id)
      .eq('is_public', true)
      .eq('status', 'succeeded')
      .order('created_at', { ascending: false })
      .limit(24);

    const legacyResult = legacyWithAssetResult.error?.code === '42703'
      ? await adminSupabase
        .from('generations')
        .select(selectWithoutAsset)
        .eq('user_id', profile.id)
        .eq('is_public', true)
        .eq('status', 'succeeded')
        .order('created_at', { ascending: false })
        .limit(24)
      : legacyWithAssetResult;

    if (legacyResult.error) {
      console.error('Failed to fetch legacy creator generations:', legacyResult.error);
      throw legacyResult.error;
    }

    const rows = (legacyResult.data ?? []) as LegacyCreatorGenerationRow[];
    const resolvedLegacyItems = await Promise.all<ShowcaseFeedItem | null>(
      rows.map(async (generation) => {
        const mediaUrl = generation.showcase_asset_path
          ? adminSupabase.storage.from('showcase_media').getPublicUrl(generation.showcase_asset_path).data.publicUrl
          : generation.output_url
            ? await resolveStoredMediaUrl(adminSupabase, generation.output_url)
            : null;

        if (!mediaUrl) {
          return null;
        }

        const category = resolveItemCategory(generation.category);

        return {
          id: generation.id,
          mediaUrl,
          mediaKind: getPostMediaKind(category, 'media'),
          model: generation.model,
          title: generation.title || 'Untitled Creation',
          prompt: generation.prompt || '',
          body: '',
          category,
          postFormat: 'media',
          saveCount: generation.save_count || 0,
          remixCount: generation.remix_count || 0,
          createdAt: generation.created_at,
          creator: {
            id: profile.id,
            username: profile.username,
            name: getCreatorDisplayName({
              displayName: profile.display_name,
              username: profile.username,
            }),
            avatar: profile.avatar_url,
          },
          sourceKind: 'ugc_copy',
          sourceTool: null,
          generationId: generation.id,
          asset: null,
          canRemix: true,
        } satisfies ShowcaseFeedItem;
      })
    );
    legacyItems = resolvedLegacyItems.filter((item): item is ShowcaseFeedItem => item !== null);
  }

  if (legacyItems) {
    return {
      profile: {
        id: profile.id,
        username: profile.username ?? username,
        displayName: getCreatorDisplayName({
          displayName: profile.display_name,
          username: profile.username,
        }),
        bio: profile.bio,
        avatarUrl: profile.avatar_url,
        coverUrl: profile.cover_url,
        websiteUrl: profile.website_url,
        twitterHandle: profile.twitter_handle,
        instagramHandle: profile.instagram_handle,
        tiktokHandle: profile.tiktok_handle,
        location: profile.location,
      },
      stats: {
        publicCreations: legacyItems.length,
        totalSaves: legacyItems.reduce((sum, item) => sum + item.saveCount, 0),
        totalRemixes: legacyItems.reduce((sum, item) => sum + item.remixCount, 0),
      },
      items: legacyItems,
    };
  }

  const assetMap = await getMarketplaceAssetSummaryMap(
    visibleRows.map((post) => post.id),
    adminSupabase
  );
  const generationIds = Array.from(new Set(visibleRows.map((post) => post.generation_id).filter(Boolean))) as string[];
  const modelMap = new Map<string, string>();

  if (generationIds.length > 0) {
    const { data: models, error: modelsError } = await adminSupabase
      .from('generations')
      .select('id, model')
      .in('id', generationIds);

    if (modelsError) {
      console.error('Failed to fetch creator generation models:', modelsError);
    } else {
      for (const row of models ?? []) {
        if (typeof row.id === 'string' && typeof row.model === 'string') {
          modelMap.set(row.id, row.model);
        }
      }
    }
  }

  const resolvedItems = await Promise.all(
    visibleRows.map(async (post): Promise<ShowcaseFeedItem | null> => {
      const mediaUrl = await resolvePostMediaUrl(adminSupabase, post);
      if (post.post_format !== 'text' && !mediaUrl) {
        return null;
      }

      const asset = assetMap.get(post.id) ?? null;
      const body = post.body?.trim() || '';
      const model = post.generation_id
        ? modelMap.get(post.generation_id) ?? 'ugc_copy'
        : post.source_kind === 'manual'
          ? 'manual'
          : post.source_tool ?? 'external';

      return {
        id: post.id,
        mediaUrl,
        mediaKind: getPostMediaKind(post.category, post.post_format),
        model,
        title: post.title?.trim() || deriveTitleFromBody(body) || (post.post_format === 'text' ? 'Untitled Note' : 'Untitled Creation'),
        prompt: post.prompt || '',
        body,
        category: resolveItemCategory(post.category),
        postFormat: post.post_format,
        saveCount: post.save_count || 0,
        remixCount: post.remix_count || 0,
        createdAt: post.created_at,
        creator: {
          id: profile.id,
          username: profile.username,
          name: getCreatorDisplayName({
            displayName: profile.display_name,
            username: profile.username,
          }),
          avatar: profile.avatar_url,
        },
        sourceKind: post.source_kind,
        sourceTool: post.source_tool,
        generationId: post.generation_id,
        asset,
        canRemix: canRemixPost(post.generation_id) && !asset?.allowRemix,
      };
    })
  );

  const items = resolvedItems.filter((item): item is ShowcaseFeedItem => item !== null);

  return {
    profile: {
      id: profile.id,
      username: profile.username ?? username,
      displayName: getCreatorDisplayName({
        displayName: profile.display_name,
        username: profile.username,
      }),
      bio: profile.bio,
      avatarUrl: profile.avatar_url,
      coverUrl: profile.cover_url,
      websiteUrl: profile.website_url,
      twitterHandle: profile.twitter_handle,
      instagramHandle: profile.instagram_handle,
      tiktokHandle: profile.tiktok_handle,
      location: profile.location,
    },
    stats: {
      publicCreations: items.length,
      totalSaves: items.reduce((sum, item) => sum + item.saveCount, 0),
      totalRemixes: items.reduce((sum, item) => sum + item.remixCount, 0),
    },
    items,
  };
});
