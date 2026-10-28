import { mediaLibraryBoundaryFilter, type MediaLibraryBoundary } from '@/lib/media-library-cursor';
import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import {
  getPostResourceKinds,
  resolveRecipeAllowRemix,
  stripDerivedGenerationReferenceItems,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  type PostResourceBundleInput,
  type PostResourceBundleResources,
  type PostResourceBundleStatus,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import {
  assessOwnerListingQuality,
  getPostResourceBundleDetailByPostId,
} from '@/lib/post-resource-bundles-server';
import {
  deriveTitleFromBody,
  getPostMediaKind,
  isMissingPostResourceBundlesSchemaError,
  isMissingPostResourceItemsColumnError,
  isMissingPostResourceRetirementColumnError,
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
import {
  graftGenerationPreviewOntoCover,
  loadGenerationPreviewInfoMap,
  type GenerationPreviewInfo,
} from '@/lib/generation-preview-info';
import { getOwnerPostTitleFallback } from '@/lib/owner-post-title-fallback';
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

type OwnerPostReviewStatus = 'visible' | 'flagged' | 'hidden';

type OwnerPostRow = PostMediaRow & {
  id: string;
  user_id: string;
  generation_id: string | null;
  visibility: ShowcaseVisibility;
  is_nsfw?: boolean;
  archived_at: string | null;
  archived_by_user_id: string | null;
  tombstoned_at: string | null;
  review_status: OwnerPostReviewStatus | null;
  prompt: string | null;
  title: string | null;
  description: string | null;
  body: string | null;
  category: ShowcaseItemCategory;
  post_format: ShowcasePostFormat;
  source_kind: RawShowcaseSourceKind;
  source_tool: string | null;
  source_tool_slug: string | null;
  comment_count: number;
  created_at: string;
  updated_at: string;
};

type LegacyOwnerPostRow = Omit<
  OwnerPostRow,
  'body' | 'post_format' | 'archived_at' | 'archived_by_user_id' | 'tombstoned_at' | 'review_status' | 'updated_at'
>;

type BundleSummaryRow = {
  id: string;
  post_id: string;
  access_mode: 'free' | 'paid';
  status: PostResourceBundleStatus;
  price_usd_cents: number;
  sales_count: number;
  // The compact summary RPC returns it; the select fallback, which serves only
  // a database older than that RPC and this column, does not.
  free_unlock_count?: number;
  earnings_usd_cents: number;
  prompt_text?: string | null;
  notes_markdown?: string | null;
  workflow_share_url?: string | null;
  workflow_snapshot?: unknown;
  attachments?: unknown;
  resource_sections?: unknown;
  resource_items?: unknown;
  allow_remix?: boolean;
  resource_kinds?: PostResourceKind[] | null;
  title?: string | null;
  summary?: string | null;
  preview_text?: string | null;
  retired_at?: string | null;
};

type BundleListingFieldsRow = Pick<BundleSummaryRow, 'post_id' | 'title' | 'summary' | 'preview_text' | 'retired_at'>;

type OwnerSellerProfile = {
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
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
  /** Paid unlocks. A free unlock is not a sale (decision 6, 2026-10-17). */
  salesCount: number;
  freeUnlockCount: number;
  earningsUsdCents: number;
  resourceKinds: PostResourceKind[];
  /** The post's moderation state: anything but 'visible' keeps the recipe off the marketplace. */
  reviewStatus: OwnerPostReviewStatus | null;
  /** The web sell page's listing check and its first issue; null when its inputs could not be read. */
  quality: { eligible: boolean; message: string | null } | null;
  /** Set once the creator removed the recipe after it had buyers; it can no longer be sold. */
  retiredAt: string | null;
}

export interface OwnerPostListItem {
  id: string;
  generationId: string | null;
  visibility: ShowcaseVisibility;
  isNsfw?: boolean;
  archivedAt: string | null;
  /**
   * Set when the owner deleted the post while it had buyers: it is kept for
   * them, and restore and edit answer 409 POST_DELETED.
   */
  tombstonedAt?: string | null;
  mediaUrl: string | null;
  mediaKind: ShowcaseMediaKind | null;
  mediaItems: PostMediaSummary[];
  title: string;
  /** The stored title without the display fallback; '' when the post has none. */
  rawTitle: string;
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
  commentCount: number;
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
  /** Always false since sold recipes became editable; kept for app builds that still read it. */
  hasPaidOrders: boolean;
  /** People who have this recipe: paid sales plus free unlocks. 0 when there is none. */
  resourceBundleBuyerCount?: number;
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

// Inner-joining the bundle keeps only listings (posts with a recipe) in the
// query itself, so a page of listings is a whole page and offsets stay true.
const LISTINGS_ONLY_EMBED = ', post_resource_bundles!inner(id)';

async function fetchOwnerPostRows(
  adminSupabase: ServiceClient,
  userId: string,
  options: {
    includeArchived: boolean;
    limit?: number;
    offset?: number;
    after?: MediaLibraryBoundary;
    visibility: OwnerPostVisibilityFilter;
    listingsOnly?: boolean;
  }
): Promise<OwnerPostRow[]> {
  const { includeArchived, limit, offset = 0, visibility, after, listingsOnly = false } = options;
  const listingsEmbed = listingsOnly ? LISTINGS_ONLY_EMBED : '';
  let query = adminSupabase
    .from('posts')
    .select(
      'id, user_id, generation_id, is_nsfw, visibility, archived_at, archived_by_user_id, tombstoned_at, review_status, output_url, showcase_asset_path, prompt, title, description, body, category, post_format, source_kind, source_tool, source_tool_slug, comment_count, created_at, updated_at'
        + listingsEmbed
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  if (visibility === 'archived') {
    query = query.not('archived_at', 'is', null);
  } else if (visibility !== 'all') {
    query = query.is('archived_at', null).eq('visibility', visibility);
  } else if (!includeArchived) {
    query = query.is('archived_at', null);
  }

  if (after) query = query.lte('created_at', after.createdAt).or(mediaLibraryBoundaryFilter(after, 'id'));
  if (typeof limit === 'number') {
    query = query.range(offset, offset + Math.max(0, limit - 1));
  }

  const result = await query;

  if (isMissingPostSourceToolSlugColumnError(result.error)) {
    const withoutSourceToolSlugQuery = adminSupabase
      .from('posts')
      .select(
        'id, user_id, generation_id, is_nsfw, visibility, archived_at, archived_by_user_id, tombstoned_at, review_status, output_url, showcase_asset_path, prompt, title, description, body, category, post_format, source_kind, source_tool, comment_count, created_at, updated_at'
          + listingsEmbed
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    let compatibleQuery = withoutSourceToolSlugQuery;
    if (visibility === 'archived') {
      compatibleQuery = compatibleQuery.not('archived_at', 'is', null);
    } else if (visibility !== 'all') {
      compatibleQuery = compatibleQuery.is('archived_at', null).eq('visibility', visibility);
    } else if (!includeArchived) {
      compatibleQuery = compatibleQuery.is('archived_at', null);
    }
    if (after) compatibleQuery = compatibleQuery.lte('created_at', after.createdAt).or(mediaLibraryBoundaryFilter(after, 'id'));
    if (typeof limit === 'number') {
      compatibleQuery = compatibleQuery.range(offset, offset + Math.max(0, limit - 1));
    }
    const withoutSourceToolSlugResult = await compatibleQuery;

    if (withoutSourceToolSlugResult.error) {
      throw withoutSourceToolSlugResult.error;
    }

    return ((withoutSourceToolSlugResult.data ?? []) as unknown as Array<Omit<OwnerPostRow, 'source_tool_slug'>>).map((row) => ({
      ...row,
      source_tool_slug: null,
    }));
  }

  if (isMissingPostTextColumnsError(result.error)) {
    const legacyQuery = adminSupabase
      .from('posts')
      .select(
        'id, user_id, generation_id, is_nsfw, visibility, output_url, showcase_asset_path, prompt, title, description, category, source_kind, source_tool, comment_count, created_at'
          + listingsEmbed
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    let compatibleLegacyQuery = legacyQuery;
    if (visibility !== 'all' && visibility !== 'archived') {
      compatibleLegacyQuery = compatibleLegacyQuery.eq('visibility', visibility);
    }
    if (after) compatibleLegacyQuery = compatibleLegacyQuery.lte('created_at', after.createdAt).or(mediaLibraryBoundaryFilter(after, 'id'));
    if (typeof limit === 'number') {
      compatibleLegacyQuery = compatibleLegacyQuery.range(offset, offset + Math.max(0, limit - 1));
    }
    const legacyResult = visibility === 'archived'
      ? { data: [], error: null }
      : await compatibleLegacyQuery;
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
      tombstoned_at: null,
      review_status: null,
      updated_at: row.created_at,
    }));
  }

  if (result.error) {
    throw result.error;
  }

  return (result.data ?? []) as unknown as OwnerPostRow[];
}

async function fetchOwnerPostRow(
  adminSupabase: ServiceClient,
  postId: string,
  userId: string
): Promise<OwnerPostRow | null> {
  const result = await adminSupabase
    .from('posts')
    .select(
      'id, user_id, generation_id, is_nsfw, visibility, archived_at, archived_by_user_id, tombstoned_at, review_status, output_url, showcase_asset_path, prompt, title, description, body, category, post_format, source_kind, source_tool, source_tool_slug, comment_count, created_at, updated_at'
    )
    .eq('id', postId)
    .eq('user_id', userId)
    .maybeSingle();

  if (isMissingPostSourceToolSlugColumnError(result.error)) {
    const withoutSourceToolSlugResult = await adminSupabase
      .from('posts')
      .select(
        'id, user_id, generation_id, is_nsfw, visibility, archived_at, archived_by_user_id, tombstoned_at, review_status, output_url, showcase_asset_path, prompt, title, description, body, category, post_format, source_kind, source_tool, comment_count, created_at, updated_at'
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
        'id, user_id, generation_id, is_nsfw, visibility, output_url, showcase_asset_path, prompt, title, description, category, source_kind, source_tool, comment_count, created_at'
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
      tombstoned_at: null,
      review_status: null,
      updated_at: row.created_at,
    };
  }

  if (result.error) {
    throw result.error;
  }

  return (result.data as OwnerPostRow | null) ?? null;
}

// What the listing check grades a bundle on, beside the summary columns.
const BUNDLE_LISTING_COLUMNS = 'title, summary, preview_text';

// The compact summary RPC predates the listing check: the text it grades and
// `retired_at` are read beside it, a few short columns per bundle.
async function loadBundleListingFields(adminSupabase: ServiceClient, postIds: string[]) {
  const loadFields = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .in('post_id', postIds);

  let { data, error } = await loadFields(`post_id, ${BUNDLE_LISTING_COLUMNS}, retired_at`);
  // A database that predates the bundle-revisions migration has no retired_at.
  if (isMissingPostResourceRetirementColumnError(error)) {
    ({ data, error } = await loadFields(`post_id, ${BUNDLE_LISTING_COLUMNS}`));
  }

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return new Map<string, BundleListingFieldsRow>();
    }

    throw error;
  }

  return new Map(
    ((data ?? []) as unknown as BundleListingFieldsRow[]).map((row) => [row.post_id, row])
  );
}

async function loadBundleMap(adminSupabase: ServiceClient, postIds: string[]) {
  if (postIds.length === 0) {
    return new Map<string, BundleSummaryRow>();
  }

  if (typeof (adminSupabase as unknown as { rpc?: unknown }).rpc === 'function') {
    const [compactResult, listingFields] = await Promise.all([
      adminSupabase.rpc('get_owner_post_bundle_summaries', {
        p_post_ids: postIds,
      }),
      loadBundleListingFields(adminSupabase, postIds),
    ]);
    if (!compactResult.error) {
      return new Map(
        ((compactResult.data ?? []) as unknown as BundleSummaryRow[]).map((row) => [
          row.post_id,
          { ...listingFields.get(row.post_id), ...row },
        ])
      );
    }

    const compactError = compactResult.error as { code?: string; message?: string };
    const isMissingCompactRpc = compactError.code === '42883'
      || compactError.code === 'PGRST202'
      || Boolean(compactError.message?.includes('get_owner_post_bundle_summaries'));
    if (!isMissingCompactRpc) {
      throw compactResult.error;
    }
  }

  const selectWithItems =
    `id, post_id, access_mode, status, price_usd_cents, sales_count, earnings_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, resource_sections, resource_items, allow_remix, ${BUNDLE_LISTING_COLUMNS}`;
  const selectLegacy =
    `id, post_id, access_mode, status, price_usd_cents, sales_count, earnings_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, ${BUNDLE_LISTING_COLUMNS}`;
  const loadBundles = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .in('post_id', postIds);

  let { data, error } = await loadBundles(`${selectWithItems}, retired_at`);
  if (isMissingPostResourceRetirementColumnError(error)) {
    ({ data, error } = await loadBundles(selectWithItems));
  }
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

// The seller half of the listing check; null when the read fails, so the check
// reads as unknown instead of blaming a handle it never saw.
async function loadOwnerSellerProfile(
  adminSupabase: ServiceClient,
  userId: string
): Promise<OwnerSellerProfile | null> {
  const { data, error } = await adminSupabase
    .from('profiles')
    .select('username, display_name, avatar_url')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logBackendError('owner_post_seller_profile_load_failed', { error });
    return null;
  }

  const profile = data as Partial<OwnerSellerProfile> | null;
  return {
    username: profile?.username ?? null,
    display_name: profile?.display_name ?? null,
    avatar_url: profile?.avatar_url ?? null,
  };
}

function toOwnerListingQuality(
  row: OwnerPostRow,
  bundleRow: BundleSummaryRow,
  resourceKinds: PostResourceKind[],
  post: { title: string; mediaUrl: string | null; mediaKind: ShowcaseMediaKind | null },
  sellerProfile: OwnerSellerProfile | null
): OwnerPostBundleSummary['quality'] {
  if (!sellerProfile || typeof bundleRow.title !== 'string') {
    return null;
  }

  const assessment = assessOwnerListingQuality({
    ownerUserId: row.user_id,
    ownerProfile: sellerProfile,
    bundle: {
      title: bundleRow.title,
      summary: bundleRow.summary,
      previewText: bundleRow.preview_text,
      accessMode: bundleRow.access_mode,
      priceUsdCents: bundleRow.price_usd_cents,
      resourceKinds,
    },
    post: {
      title: post.title,
      body: row.body,
      postFormat: row.post_format,
      visibility: row.visibility,
      archivedAt: row.archived_at,
      reviewStatus: row.review_status,
      mediaUrl: post.mediaUrl,
      mediaKind: post.mediaKind,
    },
  });

  return {
    eligible: assessment.eligible,
    message: assessment.issues[0]?.message ?? null,
  };
}

async function toOwnerPostListItem(
  adminSupabase: ServiceClient,
  row: OwnerPostRow,
  bundleMap: Map<string, BundleSummaryRow>,
  sourceToolsMap: Map<string, SourceToolSelection[]>,
  mediaItemsMap: Map<string, PostMediaSummary[]>,
  generationPreviewMap: Map<string, GenerationPreviewInfo>,
  sellerProfile: OwnerSellerProfile | null
) {
  const rawMediaItems = mediaItemsMap.get(row.id) ?? await buildLegacyPostMediaItems({
    supabase: adminSupabase,
    postId: row.id,
    row,
  });
  // A post without `post_media` rows gets a synthesised cover with no poster,
  // which clients render as a blank plate. The showcase feed grafts the linked
  // generation's preview onto that cover; the owner surface must do the same —
  // it also serves private creation posts, whose derivative rows are removed.
  const mediaItems = graftGenerationPreviewOntoCover(
    rawMediaItems,
    row.generation_id ? generationPreviewMap.get(row.generation_id) : null,
  );
  const coverMedia = mediaItems[0] ?? null;
  const mediaUrl = coverMedia?.url ?? await resolvePostMediaUrl(adminSupabase, row);
  const mediaKind = coverMedia?.mediaKind ?? getPostMediaKind(row.category, row.post_format);
  const sourceKind = normalizeShowcaseSourceKind(row.source_kind);
  const canShare = isShareablePost(row);
  const bundleRow = bundleMap.get(row.id) ?? null;
  const normalizedBundleResources = bundleRow && !bundleRow.resource_kinds
    ? normalizeBundleResources(bundleRow)
    : null;
  const storedResourceKinds = bundleRow?.resource_kinds ?? getPostResourceKinds(normalizedBundleResources);
  // A creation post's published recipe includes its Remix whatever its stored
  // switch says (2026-10-27), which the summary RPC's kinds do not know.
  const resourceKinds: PostResourceKind[] = bundleRow
    && !storedResourceKinds.includes('remix')
    && resolveRecipeAllowRemix({
      storedAllowRemix: bundleRow.allow_remix,
      status: bundleRow.status,
      generationId: row.generation_id,
    })
    ? [...storedResourceKinds, 'remix']
    : storedResourceKinds;
  const title =
    row.title?.trim() ||
    deriveTitleFromBody(row.body) ||
    getOwnerPostTitleFallback(row.post_format);

  return {
    id: row.id,
    generationId: row.generation_id,
    visibility: row.visibility,
    isNsfw: row.is_nsfw === true,
    archivedAt: row.archived_at,
    tombstonedAt: row.tombstoned_at ?? null,
    mediaUrl,
    mediaKind,
    mediaItems,
    title,
    // Editors must hydrate from this, never from `title`: PATCHing the display
    // fallback back turns it into a stored title the marketplace placeholder
    // gate rejects, leaving the post unsavable.
    rawTitle: row.title?.trim() || '',
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
    commentCount: Math.max(0, row.comment_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publicPath: canShare ? `/showcase/${row.id}` : null,
    ownerPath: `/post/${row.id}/edit`,
    resourcePath: bundleRow ? (canShare ? `/showcase/${row.id}#recipe` : `/post/${row.id}/edit#recipe`) : null,
    canShare,
    bundle: bundleRow
      ? {
          id: bundleRow.id,
          accessMode: bundleRow.access_mode,
          status: bundleRow.status,
          priceUsdCents: bundleRow.price_usd_cents,
          salesCount: bundleRow.sales_count,
          freeUnlockCount: bundleRow.free_unlock_count ?? 0,
          earningsUsdCents: bundleRow.earnings_usd_cents,
          resourceKinds,
          reviewStatus: row.review_status ?? null,
          quality: toOwnerListingQuality(row, bundleRow, resourceKinds, { title, mediaUrl, mediaKind }, sellerProfile),
          retiredAt: bundleRow.retired_at ?? null,
        }
      : null,
  } satisfies OwnerPostListItem;
}

export async function getOwnerPostList(
  userId: string,
  options?: {
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
    after?: MediaLibraryBoundary;
    visibility?: OwnerPostVisibilityFilter;
    /** Only posts with a recipe: the seller dashboard's listings. */
    listingsOnly?: boolean;
  }
): Promise<OwnerPostListItem[]> {
  const includeArchived = options?.includeArchived ?? false;
  const visibility = options?.visibility ?? 'all';
  const adminSupabase = createServiceClient();
  const rows = await fetchOwnerPostRows(adminSupabase, userId, {
    includeArchived,
    limit: options?.limit,
    offset: options?.offset,
    after: options?.after,
    visibility,
    listingsOnly: options?.listingsOnly === true,
  });
  const postIds = rows.map((row) => row.id);
  // Signed only for the covers that will actually be grafted onto, without
  // moving the generation read off the parallel path — see
  // `loadGenerationPreviewInfoMap`.
  const mediaItemsPromise = loadPostMediaItemsMap(adminSupabase, postIds);
  const bundleMapPromise = loadBundleMap(adminSupabase, postIds);
  // Only a page with a recipe on it asks for the seller's identity.
  const sellerProfilePromise = bundleMapPromise.then((bundles) => (
    bundles.size > 0 ? loadOwnerSellerProfile(adminSupabase, userId) : null
  ));
  const [bundleMap, sourceToolsMap, mediaItemsMap, generationPreviewMap, sellerProfile] = await Promise.all([
    bundleMapPromise,
    loadSourceToolsMap(adminSupabase, postIds),
    mediaItemsPromise,
    loadGenerationPreviewInfoMap(
      adminSupabase,
      rows.flatMap((row) => (row.generation_id ? [row.generation_id] : [])),
      {
        signPreviewFor: mediaItemsPromise.then((mediaItems) => new Set(
          rows
            .filter((row) => row.generation_id && !mediaItems.get(row.id)?.[0]?.previewUrl)
            .map((row) => row.generation_id as string),
        )),
      },
    ),
    sellerProfilePromise,
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
    toOwnerPostListItem(adminSupabase, row, bundleMap, sourceToolsMap, mediaItemsMap, generationPreviewMap, sellerProfile)
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

  const mediaItemsPromise = loadPostMediaItemsMap(adminSupabase, [row.id]);
  const bundleMapPromise = loadBundleMap(adminSupabase, [row.id]);
  const sellerProfilePromise = bundleMapPromise.then((bundles) => (
    bundles.size > 0 ? loadOwnerSellerProfile(adminSupabase, userId) : null
  ));
  const [bundleMap, sourceToolsMap, mediaItemsMap, generationPreviewMap, sellerProfile] = await Promise.all([
    bundleMapPromise,
    loadSourceToolsMap(adminSupabase, [row.id]),
    mediaItemsPromise,
    loadGenerationPreviewInfoMap(
      adminSupabase,
      row.generation_id ? [row.generation_id] : [],
      {
        signPreviewFor: mediaItemsPromise.then((mediaItems) => new Set(
          row.generation_id && !mediaItems.get(row.id)?.[0]?.previewUrl ? [row.generation_id] : [],
        )),
      },
    ),
    sellerProfilePromise,
  ]);
  const listItem = await toOwnerPostListItem(
    adminSupabase,
    row,
    bundleMap,
    sourceToolsMap,
    mediaItemsMap,
    generationPreviewMap,
    sellerProfile,
  );
  const bundleDetail = await getPostResourceBundleDetailByPostId(postId, {
    viewerUserId: userId,
    countryCode: options?.countryCode ?? null,
  });

  // A recipe removed while people had it is retired: its row stays for them,
  // but the post has no recipe, so the editor opens on "No recipe".
  const liveBundle = bundleDetail && !bundleDetail.retiredAt ? bundleDetail : null;

  return {
    ...listItem,
    // The recipe as stored: the read merges the creation's references into a
    // recipe that includes its Remix (every published creation recipe since
    // 2026-10-27), and every save drops them again, so they are not offered to
    // the editor as items the creator could change.
    resourceBundleInput: liveBundle
      ? stripDerivedGenerationReferenceItems({
          accessMode: liveBundle.accessMode,
          summary: liveBundle.summary,
          previewText: liveBundle.previewText,
          priceUsdCents: liveBundle.priceUsdCents,
          resources: liveBundle.resources,
        })
      : {
          accessMode: 'none',
        },
    // A recipe people have can be corrected since 2026-10-27 (owner decision
    // D1), so nothing locks the editor. Kept, always false, for app builds
    // that still read it.
    hasPaidOrders: false,
    // Everyone who has it, paid or free: the composers say they keep the
    // version they got and see the changes, and confirm before a removal.
    resourceBundleBuyerCount: liveBundle
      ? Math.max(0, liveBundle.salesCount) + Math.max(0, liveBundle.freeUnlockCount ?? 0)
      : 0,
  };
}
