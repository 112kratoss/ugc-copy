import 'server-only';

import { cache } from 'react';

import {
  canRemixPost,
  deriveTitleFromBody,
  getMarketplaceAssetSummaryMap,
  getPostMediaKind,
  isMissingPostReviewStatusColumnError,
  isMissingPostTextColumnsError,
  isMissingPostSourceToolSlugColumnError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
  resolvePostMediaUrl,
} from '@/lib/posts-server';
import { getCreatorDisplayName, normalizeUsername } from '@/lib/profile';
import {
  createServiceClient,
  resolveStoredMediaUrl,
} from '@/lib/server-helpers';
import { getPostResourceBundlePriceQuote } from '@/lib/post-resource-bundles-server';
import {
  MAGICBOOKLET_SOURCE_KIND,
  normalizeShowcaseSourceKind,
  type RawShowcaseSourceKind,
  type ShowcaseFeedItem,
  type ShowcaseItemCategory,
  type ShowcasePostFormat,
} from '@/lib/showcase';
import { slugifySourceTool } from '@/lib/source-tools';

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
  source_kind: RawShowcaseSourceKind;
  source_tool: string | null;
  source_tool_slug?: string | null;
  review_status?: 'visible' | 'flagged' | 'hidden' | null;
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
  source_kind: RawShowcaseSourceKind;
  source_tool: string | null;
  source_tool_slug?: string | null;
  review_status?: 'visible' | 'flagged' | 'hidden' | null;
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
    unlocks: number;
    totalUnlockSales: number;
    toolsUsed: Array<{ slug: string; label: string; count: number }>;
  };
  items: ShowcaseFeedItem[];
  pageInfo: {
    hasMore: boolean;
    nextLimit: number | null;
    limit: number;
  };
}

function resolveItemCategory(category: ShowcaseItemCategory | null): ShowcaseItemCategory {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad' || category === 'text') {
    return category;
  }

  return 'image';
}

async function attachLocalizedAssetPrices(
  assetMap: Map<string, NonNullable<ShowcaseFeedItem['asset']>>,
  countryCode?: string | null
) {
  if (assetMap.size === 0) {
    return;
  }

  await Promise.all(
    Array.from(assetMap.values()).map(async (asset) => {
      asset.priceQuote = await getPostResourceBundlePriceQuote(asset.priceUsdCents, countryCode);
    })
  );
}

export const getCreatorProfilePageData = cache(async (
  rawUsername: string,
  options?: { limit?: number; countryCode?: string | null }
): Promise<CreatorProfilePageData | null> => {
  const username = normalizeUsername(rawUsername);
  if (!username) {
    return null;
  }

  const requestedLimit = Number.isFinite(options?.limit) ? Math.round(options?.limit ?? 24) : 24;
  const limit = Math.min(96, Math.max(24, requestedLimit));
  const queryLimit = limit + 1;

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
  let hasMore = false;

  try {
    const result = await adminSupabase
      .from('posts')
      .select('id, output_url, showcase_asset_path, prompt, title, body, category, post_format, save_count, remix_count, created_at, generation_id, source_kind, source_tool, source_tool_slug, review_status')
      .eq('user_id', profile.id)
      .eq('visibility', 'public')
      .is('archived_at', null)
      .neq('review_status', 'hidden')
      .order('created_at', { ascending: false })
      .limit(queryLimit);

    if (isMissingPostSourceToolSlugColumnError(result.error) || isMissingPostReviewStatusColumnError(result.error)) {
      const includeSourceToolSlug = !isMissingPostSourceToolSlugColumnError(result.error);
      const includeReviewStatus = !isMissingPostReviewStatusColumnError(result.error);
      const withoutSourceToolSlugBaseQuery = adminSupabase
        .from('posts')
        .select(
          [
            'id',
            'output_url',
            'showcase_asset_path',
            'prompt',
            'title',
            'body',
            'category',
            'post_format',
            'save_count',
            'remix_count',
            'created_at',
            'generation_id',
            'source_kind',
            'source_tool',
            includeSourceToolSlug ? 'source_tool_slug' : null,
            includeReviewStatus ? 'review_status' : null,
          ].filter(Boolean).join(', ')
        )
        .eq('user_id', profile.id)
        .eq('visibility', 'public')
        .is('archived_at', null);

      const withoutSourceToolSlugResult = includeReviewStatus
        ? await withoutSourceToolSlugBaseQuery
          .neq('review_status', 'hidden')
          .order('created_at', { ascending: false })
          .limit(queryLimit)
        : await withoutSourceToolSlugBaseQuery
          .order('created_at', { ascending: false })
          .limit(queryLimit);

      if (isMissingPostTextColumnsError(withoutSourceToolSlugResult.error)) {
        const legacyBaseQuery = adminSupabase
          .from('posts')
          .select(
            [
              'id',
              'output_url',
              'showcase_asset_path',
              'prompt',
              'title',
              'category',
              'save_count',
              'remix_count',
              'created_at',
              'generation_id',
              'source_kind',
              'source_tool',
              includeSourceToolSlug ? 'source_tool_slug' : null,
              includeReviewStatus ? 'review_status' : null,
            ].filter(Boolean).join(', ')
          )
          .eq('user_id', profile.id)
          .eq('visibility', 'public')
          .is('archived_at', null);

        const legacyResult = includeReviewStatus
          ? await legacyBaseQuery
            .neq('review_status', 'hidden')
            .order('created_at', { ascending: false })
            .limit(queryLimit)
          : await legacyBaseQuery
            .order('created_at', { ascending: false })
            .limit(queryLimit);

        if (legacyResult.error) {
          console.error('Failed to fetch creator posts:', legacyResult.error);
          throw legacyResult.error;
        }

        visibleRows = ((legacyResult.data ?? []) as unknown as LegacyCreatorPostRow[]).map((row) => ({
          ...row,
          body: null,
          post_format: normalizeLegacyPostFormat(row.category),
          source_tool_slug: row.source_tool_slug ?? null,
        }));
      } else {
        if (withoutSourceToolSlugResult.error) {
          console.error('Failed to fetch creator posts:', withoutSourceToolSlugResult.error);
          throw withoutSourceToolSlugResult.error;
        }

        visibleRows = ((withoutSourceToolSlugResult.data ?? []) as unknown as Array<Omit<CreatorPostRow, 'source_tool_slug'>>).map((row) => ({
          ...row,
          source_tool_slug: (row as CreatorPostRow).source_tool_slug ?? null,
        }));
      }
    } else if (isMissingPostTextColumnsError(result.error)) {
      const legacyQuery = adminSupabase
        .from('posts')
        .select('id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, generation_id, source_kind, source_tool, source_tool_slug, review_status')
        .eq('user_id', profile.id)
        .eq('visibility', 'public')
        .is('archived_at', null)
        .neq('review_status', 'hidden');

      let legacyResult: { data: unknown[] | null; error: unknown } = await legacyQuery
        .order('created_at', { ascending: false })
        .limit(queryLimit);

      if (isMissingPostSourceToolSlugColumnError(legacyResult.error) || isMissingPostReviewStatusColumnError(legacyResult.error)) {
        const includeSourceToolSlug = !isMissingPostSourceToolSlugColumnError(legacyResult.error);
        const includeReviewStatus = !isMissingPostReviewStatusColumnError(legacyResult.error);
        const legacyFallbackBaseQuery = adminSupabase
          .from('posts')
          .select(
            [
              'id',
              'output_url',
              'showcase_asset_path',
              'prompt',
              'title',
              'category',
              'save_count',
              'remix_count',
              'created_at',
              'generation_id',
              'source_kind',
              'source_tool',
              includeSourceToolSlug ? 'source_tool_slug' : null,
              includeReviewStatus ? 'review_status' : null,
            ].filter(Boolean).join(', ')
          )
          .eq('user_id', profile.id)
          .eq('visibility', 'public')
          .is('archived_at', null);

        legacyResult = includeReviewStatus
          ? await legacyFallbackBaseQuery
            .neq('review_status', 'hidden')
            .order('created_at', { ascending: false })
            .limit(queryLimit)
          : await legacyFallbackBaseQuery
            .order('created_at', { ascending: false })
            .limit(queryLimit);
      }

      if (legacyResult.error) {
        console.error('Failed to fetch creator posts:', legacyResult.error);
        throw legacyResult.error;
      }

      visibleRows = ((legacyResult.data ?? []) as unknown as LegacyCreatorPostRow[]).map((row) => ({
        ...row,
        body: null,
        post_format: normalizeLegacyPostFormat(row.category),
      }));
    } else {
      if (result.error) {
        console.error('Failed to fetch creator posts:', result.error);
        throw result.error;
      }

      visibleRows = (result.data ?? []) as unknown as CreatorPostRow[];
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
      .limit(queryLimit);

    const legacyResult = legacyWithAssetResult.error?.code === '42703'
      ? await adminSupabase
        .from('generations')
        .select(selectWithoutAsset)
        .eq('user_id', profile.id)
        .eq('is_public', true)
        .eq('status', 'succeeded')
        .order('created_at', { ascending: false })
        .limit(queryLimit)
      : legacyWithAssetResult;

    if (legacyResult.error) {
      console.error('Failed to fetch legacy creator generations:', legacyResult.error);
      throw legacyResult.error;
    }

    const allRows = (legacyResult.data ?? []) as LegacyCreatorGenerationRow[];
    hasMore = allRows.length > limit;
    const rows = allRows.slice(0, limit);
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
          sourceKind: MAGICBOOKLET_SOURCE_KIND,
          sourceTool: null,
          sourceToolSlug: 'magicbooklet',
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
        unlocks: 0,
        totalUnlockSales: 0,
        toolsUsed: [],
      },
      items: legacyItems,
      pageInfo: {
        hasMore,
        nextLimit: hasMore ? Math.min(96, limit + 24) : null,
        limit,
      },
    };
  }

  hasMore = visibleRows.length > limit;
  visibleRows = visibleRows.slice(0, limit);

  const assetMap = await getMarketplaceAssetSummaryMap(
    visibleRows.map((post) => post.id),
    adminSupabase
  );
  await attachLocalizedAssetPrices(assetMap, options?.countryCode);
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
        ? modelMap.get(post.generation_id) ?? MAGICBOOKLET_SOURCE_KIND
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
        sourceKind: normalizeShowcaseSourceKind(post.source_kind),
        sourceTool: post.source_tool,
        sourceToolSlug: post.source_tool_slug ?? slugifySourceTool(post.source_tool),
        generationId: post.generation_id,
        asset,
        canRemix: canRemixPost(post.generation_id) && !asset?.allowRemix,
      };
    })
  );

  const items = resolvedItems.filter((item): item is ShowcaseFeedItem => item !== null);
  const toolCounts = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    if (!item.sourceToolSlug) {
      continue;
    }

    const existing = toolCounts.get(item.sourceToolSlug);
    toolCounts.set(item.sourceToolSlug, {
      label: existing?.label ?? item.sourceTool ?? item.sourceToolSlug,
      count: (existing?.count ?? 0) + 1,
    });
  }

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
      unlocks: items.filter((item) => item.asset).length,
      totalUnlockSales: items.reduce((sum, item) => sum + (item.asset?.salesCount ?? 0), 0),
      toolsUsed: Array.from(toolCounts.entries()).map(([slug, value]) => ({ slug, ...value })),
    },
    items,
    pageInfo: {
      hasMore,
      nextLimit: hasMore ? Math.min(96, limit + 24) : null,
      limit,
    },
  };
});
