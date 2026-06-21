import 'server-only';

import {
  getPostResourceKinds,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  type PostResourceBundleInput,
  type PostResourceBundleResources,
  type PostResourceBundleStatus,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { getPostResourceBundleDetailByPostId } from '@/lib/post-resource-bundles-server';
import {
  deriveTitleFromBody,
  getPostMediaKind,
  isMissingPostResourceBundlesSchemaError,
  isMissingPostResourceItemsColumnError,
  isMissingPostSourceToolSlugColumnError,
  isMissingPostTextColumnsError,
  normalizeLegacyPostFormat,
  resolvePostMediaUrl,
  type PostMediaRow,
} from '@/lib/posts-server';
import {
  buildLegacyPostMediaItems,
  loadPostMediaItemsMap,
  type PostMediaSummary,
} from '@/lib/post-media';
import { createServiceClient } from '@/lib/server-helpers';
import type { SourceToolSelection } from '@/lib/source-tools';
import {
  normalizeShowcaseSourceKind,
  type RawShowcaseSourceKind,
  type ShowcaseItemCategory,
  type ShowcaseMediaKind,
  type ShowcasePostFormat,
  type ShowcaseSourceKind,
  type ShowcaseVisibility,
} from '@/lib/showcase';

type OwnerPostRow = PostMediaRow & {
  id: string;
  user_id: string;
  generation_id: string | null;
  visibility: ShowcaseVisibility;
  archived_at: string | null;
  archived_by_user_id: string | null;
  prompt: string | null;
  title: string | null;
  description: string | null;
  body: string | null;
  category: ShowcaseItemCategory;
  post_format: ShowcasePostFormat;
  source_kind: RawShowcaseSourceKind;
  source_tool: string | null;
  source_tool_slug: string | null;
  created_at: string;
  updated_at: string;
};

type LegacyOwnerPostRow = Omit<OwnerPostRow, 'body' | 'post_format' | 'archived_at' | 'archived_by_user_id' | 'updated_at'>;

type BundleSummaryRow = {
  id: string;
  post_id: string;
  access_mode: 'free' | 'paid';
  status: PostResourceBundleStatus;
  price_usd_cents: number;
  sales_count: number;
  earnings_usd_cents: number;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: unknown;
  attachments: unknown;
  resource_sections?: unknown;
  resource_items?: unknown;
  allow_remix: boolean;
};

type PostSourceToolRow = {
  post_id: string;
  tool_label: string;
  tool_slug: string | null;
  model_label: string | null;
  model_slug: string | null;
  sort_order: number;
};

interface OwnerPostBundleSummary {
  id: string;
  accessMode: 'free' | 'paid';
  status: PostResourceBundleStatus;
  priceUsdCents: number;
  salesCount: number;
  earningsUsdCents: number;
  resourceKinds: PostResourceKind[];
}

export interface OwnerPostListItem {
  id: string;
  generationId: string | null;
  visibility: ShowcaseVisibility;
  archivedAt: string | null;
  mediaUrl: string | null;
  mediaKind: ShowcaseMediaKind | null;
  mediaItems: PostMediaSummary[];
  title: string;
  description: string;
  prompt: string;
  body: string;
  category: ShowcaseItemCategory;
  postFormat: ShowcasePostFormat;
  sourceKind: ShowcaseSourceKind;
  sourceTool: string | null;
  sourceToolSlug: string | null;
  sourceTools?: SourceToolSelection[];
  sourceLabel: string;
  createdAt: string;
  updatedAt: string;
  publicPath: string | null;
  ownerPath: string;
  resourcePath: string | null;
  canShare: boolean;
  bundle: OwnerPostBundleSummary | null;
}

export interface OwnerPostDetail extends OwnerPostListItem {
  resourceBundleInput: PostResourceBundleInput;
  hasPaidOrders: boolean;
}

export type OwnerPostVisibilityFilter = ShowcaseVisibility | 'archived' | 'all';
type ServiceClient = ReturnType<typeof createServiceClient>;

function getSourceLabel(sourceKind: ShowcaseSourceKind): string {
  if (sourceKind === 'magicbooklet') {
    return 'Created here';
  }

  if (sourceKind === 'external') {
    return 'Uploaded';
  }

  return 'Note only';
}

function isShareablePost(row: { visibility: ShowcaseVisibility; archived_at: string | null }): boolean {
  return row.archived_at === null && (row.visibility === 'public' || row.visibility === 'unlisted');
}

function normalizeBundleResources(row: BundleSummaryRow): PostResourceBundleResources {
  const legacyResources: PostResourceBundleResources = {
    promptText: typeof row.prompt_text === 'string' && row.prompt_text.trim() ? row.prompt_text.trim() : null,
    notesMarkdown: typeof row.notes_markdown === 'string' && row.notes_markdown.trim() ? row.notes_markdown.trim() : null,
    workflowShareUrl:
      typeof row.workflow_share_url === 'string' && row.workflow_share_url.trim()
        ? row.workflow_share_url.trim()
        : null,
    workflowSnapshot: row.workflow_snapshot ? (row.workflow_snapshot as PostResourceBundleResources['workflowSnapshot']) : null,
    attachments: normalizePostResourceAttachments(row.attachments),
    allowRemix: Boolean(row.allow_remix),
    sections: normalizePostResourceSections(row.resource_sections),
  };

  return {
    ...legacyResources,
    items: normalizePostResourceItems(row.resource_items, legacyResources),
  };
}

async function fetchOwnerPostRows(
  adminSupabase: ServiceClient,
  userId: string,
  includeArchived: boolean
): Promise<OwnerPostRow[]> {
  let query = adminSupabase
    .from('posts')
    .select(
      'id, user_id, generation_id, visibility, archived_at, archived_by_user_id, output_url, showcase_asset_path, prompt, title, description, body, category, post_format, source_kind, source_tool, source_tool_slug, created_at, updated_at'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }

  const result = await query;

  if (isMissingPostSourceToolSlugColumnError(result.error)) {
    const withoutSourceToolSlugQuery = adminSupabase
      .from('posts')
      .select(
        'id, user_id, generation_id, visibility, archived_at, archived_by_user_id, output_url, showcase_asset_path, prompt, title, description, body, category, post_format, source_kind, source_tool, created_at, updated_at'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    const withoutSourceToolSlugResult = includeArchived
      ? await withoutSourceToolSlugQuery
      : await withoutSourceToolSlugQuery.is('archived_at', null);

    if (withoutSourceToolSlugResult.error) {
      throw withoutSourceToolSlugResult.error;
    }

    return ((withoutSourceToolSlugResult.data ?? []) as Array<Omit<OwnerPostRow, 'source_tool_slug'>>).map((row) => ({
      ...row,
      source_tool_slug: null,
    }));
  }

  if (isMissingPostTextColumnsError(result.error)) {
    const legacyQuery = adminSupabase
      .from('posts')
      .select(
        'id, user_id, generation_id, visibility, output_url, showcase_asset_path, prompt, title, description, category, source_kind, source_tool, created_at'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    const legacyResult = await legacyQuery;
    if (legacyResult.error) {
      throw legacyResult.error;
    }

    return ((legacyResult.data ?? []) as LegacyOwnerPostRow[]).map((row) => ({
      ...row,
      body: null,
      post_format: normalizeLegacyPostFormat(row.category),
      source_tool_slug: null,
      archived_at: null,
      archived_by_user_id: null,
      updated_at: row.created_at,
    }));
  }

  if (result.error) {
    throw result.error;
  }

  return (result.data ?? []) as OwnerPostRow[];
}

async function fetchOwnerPostRow(
  adminSupabase: ServiceClient,
  postId: string,
  userId: string
): Promise<OwnerPostRow | null> {
  const result = await adminSupabase
    .from('posts')
    .select(
      'id, user_id, generation_id, visibility, archived_at, archived_by_user_id, output_url, showcase_asset_path, prompt, title, description, body, category, post_format, source_kind, source_tool, source_tool_slug, created_at, updated_at'
    )
    .eq('id', postId)
    .eq('user_id', userId)
    .maybeSingle();

  if (isMissingPostSourceToolSlugColumnError(result.error)) {
    const withoutSourceToolSlugResult = await adminSupabase
      .from('posts')
      .select(
        'id, user_id, generation_id, visibility, archived_at, archived_by_user_id, output_url, showcase_asset_path, prompt, title, description, body, category, post_format, source_kind, source_tool, created_at, updated_at'
      )
      .eq('id', postId)
      .eq('user_id', userId)
      .maybeSingle();

    if (withoutSourceToolSlugResult.error) {
      throw withoutSourceToolSlugResult.error;
    }

    return withoutSourceToolSlugResult.data
      ? {
          ...(withoutSourceToolSlugResult.data as Omit<OwnerPostRow, 'source_tool_slug'>),
          source_tool_slug: null,
        }
      : null;
  }

  if (isMissingPostTextColumnsError(result.error)) {
    const legacyResult = await adminSupabase
      .from('posts')
      .select(
        'id, user_id, generation_id, visibility, output_url, showcase_asset_path, prompt, title, description, category, source_kind, source_tool, created_at'
      )
      .eq('id', postId)
      .eq('user_id', userId)
      .maybeSingle();

    if (legacyResult.error) {
      throw legacyResult.error;
    }

    if (!legacyResult.data) {
      return null;
    }

    const row = legacyResult.data as LegacyOwnerPostRow;
    return {
      ...row,
      body: null,
      post_format: normalizeLegacyPostFormat(row.category),
      source_tool_slug: null,
      archived_at: null,
      archived_by_user_id: null,
      updated_at: row.created_at,
    };
  }

  if (result.error) {
    throw result.error;
  }

  return (result.data as OwnerPostRow | null) ?? null;
}

async function loadBundleMap(adminSupabase: ServiceClient, postIds: string[]) {
  if (postIds.length === 0) {
    return new Map<string, BundleSummaryRow>();
  }

  const selectWithItems =
    'id, post_id, access_mode, status, price_usd_cents, sales_count, earnings_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, resource_sections, resource_items, allow_remix';
  const selectLegacy =
    'id, post_id, access_mode, status, price_usd_cents, sales_count, earnings_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix';
  const loadBundles = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .in('post_id', postIds);

  let { data, error } = await loadBundles(selectWithItems);
  if (isMissingPostResourceItemsColumnError(error)) {
    ({ data, error } = await loadBundles(selectLegacy));
  }

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return new Map<string, BundleSummaryRow>();
    }

    throw error;
  }

  return new Map(
    ((data ?? []) as unknown as BundleSummaryRow[]).map((row) => [row.post_id, row])
  );
}

function isMissingPostSourceToolsTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === '42P01' ||
    candidate.code === 'PGRST205' ||
    Boolean(candidate.message?.includes('post_source_tools'))
  );
}

async function loadSourceToolsMap(adminSupabase: ServiceClient, postIds: string[]) {
  if (postIds.length === 0) {
    return new Map<string, SourceToolSelection[]>();
  }

  const { data, error } = await adminSupabase
    .from('post_source_tools')
    .select('post_id, tool_label, tool_slug, model_label, model_slug, sort_order')
    .in('post_id', postIds)
    .order('sort_order', { ascending: true });

  if (error) {
    if (isMissingPostSourceToolsTableError(error)) {
      return new Map<string, SourceToolSelection[]>();
    }

    throw error;
  }

  const sourceToolsMap = new Map<string, SourceToolSelection[]>();
  for (const row of (data ?? []) as PostSourceToolRow[]) {
    const list = sourceToolsMap.get(row.post_id) ?? [];
    list.push({
      toolLabel: row.tool_label,
      toolSlug: row.tool_slug,
      modelLabel: row.model_label,
      modelSlug: row.model_slug,
    });
    sourceToolsMap.set(row.post_id, list);
  }

  return sourceToolsMap;
}

async function toOwnerPostListItem(
  adminSupabase: ServiceClient,
  row: OwnerPostRow,
  bundleMap: Map<string, BundleSummaryRow>,
  sourceToolsMap: Map<string, SourceToolSelection[]>,
  mediaItemsMap: Map<string, PostMediaSummary[]>
) {
  const mediaItems = mediaItemsMap.get(row.id) ?? await buildLegacyPostMediaItems({
    supabase: adminSupabase,
    postId: row.id,
    row,
  });
  const coverMedia = mediaItems[0] ?? null;
  const mediaUrl = coverMedia?.url ?? await resolvePostMediaUrl(adminSupabase, row);
  const mediaKind = coverMedia?.mediaKind ?? getPostMediaKind(row.category, row.post_format);
  const sourceKind = normalizeShowcaseSourceKind(row.source_kind);
  const canShare = isShareablePost(row);
  const bundleRow = bundleMap.get(row.id) ?? null;
  const normalizedBundleResources = bundleRow ? normalizeBundleResources(bundleRow) : null;

  return {
    id: row.id,
    generationId: row.generation_id,
    visibility: row.visibility,
    archivedAt: row.archived_at,
    mediaUrl,
    mediaKind,
    mediaItems,
    title:
      row.title?.trim() ||
      deriveTitleFromBody(row.body) ||
      (row.post_format === 'text' ? 'Untitled note' : 'Untitled post'),
    description: row.description?.trim() || '',
    prompt: row.prompt?.trim() || '',
    body: row.body?.trim() || '',
    category: row.category,
    postFormat: row.post_format,
    sourceKind,
    sourceTool: row.source_tool,
    sourceToolSlug: row.source_tool_slug,
    sourceTools: sourceToolsMap.get(row.id),
    sourceLabel: getSourceLabel(sourceKind),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publicPath: canShare ? `/showcase/${row.id}` : null,
    ownerPath: `/post/${row.id}/edit`,
    resourcePath: bundleRow ? (canShare ? `/showcase/${row.id}#resources` : `/post/${row.id}/edit#resources`) : null,
    canShare,
    bundle: bundleRow
      ? {
          id: bundleRow.id,
          accessMode: bundleRow.access_mode,
          status: bundleRow.status,
          priceUsdCents: bundleRow.price_usd_cents,
          salesCount: bundleRow.sales_count,
          earningsUsdCents: bundleRow.earnings_usd_cents,
          resourceKinds: getPostResourceKinds(normalizedBundleResources),
        }
      : null,
  } satisfies OwnerPostListItem;
}

export async function getOwnerPostList(
  userId: string,
  options?: {
    includeArchived?: boolean;
    visibility?: OwnerPostVisibilityFilter;
  }
): Promise<OwnerPostListItem[]> {
  const includeArchived = options?.includeArchived ?? false;
  const visibility = options?.visibility ?? 'all';
  const adminSupabase = createServiceClient();
  const rows = await fetchOwnerPostRows(adminSupabase, userId, includeArchived);
  const postIds = rows.map((row) => row.id);
  const [bundleMap, sourceToolsMap, mediaItemsMap] = await Promise.all([
    loadBundleMap(adminSupabase, postIds),
    loadSourceToolsMap(adminSupabase, postIds),
    loadPostMediaItemsMap(adminSupabase, postIds),
  ]);
  const filteredRows = rows.filter((row) => {
    if (visibility === 'archived') {
      return Boolean(row.archived_at);
    }

    if (visibility === 'all') {
      return true;
    }

    return row.archived_at === null && row.visibility === visibility;
  });

  return Promise.all(filteredRows.map((row) =>
    toOwnerPostListItem(adminSupabase, row, bundleMap, sourceToolsMap, mediaItemsMap)
  ));
}

export async function getOwnerPostDetail(
  postId: string,
  userId: string,
  options?: {
    countryCode?: string | null;
  }
): Promise<OwnerPostDetail | null> {
  const adminSupabase = createServiceClient();
  const row = await fetchOwnerPostRow(adminSupabase, postId, userId);
  if (!row) {
    return null;
  }

  const [bundleMap, sourceToolsMap, mediaItemsMap] = await Promise.all([
    loadBundleMap(adminSupabase, [row.id]),
    loadSourceToolsMap(adminSupabase, [row.id]),
    loadPostMediaItemsMap(adminSupabase, [row.id]),
  ]);
  const listItem = await toOwnerPostListItem(adminSupabase, row, bundleMap, sourceToolsMap, mediaItemsMap);
  const bundleDetail = await getPostResourceBundleDetailByPostId(postId, {
    viewerUserId: userId,
    countryCode: options?.countryCode ?? null,
  });

  return {
    ...listItem,
    resourceBundleInput: bundleDetail
      ? {
          accessMode: bundleDetail.accessMode,
          summary: bundleDetail.summary,
          previewText: bundleDetail.previewText,
          priceUsdCents: bundleDetail.priceUsdCents,
          resources: bundleDetail.resources,
        }
      : {
          accessMode: 'none',
        },
    hasPaidOrders: Boolean(
      bundleDetail &&
        bundleDetail.accessMode === 'paid' &&
        bundleDetail.salesCount > 0
    ),
  };
}
