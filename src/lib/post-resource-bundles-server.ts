import 'server-only';

import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import { convertFromUsd, formatMoney } from '@/lib/currency';
import {
  deriveTitleFromBody,
  getPostMediaKind,
  isMissingMarketplaceSchemaError,
  isMissingPostResourceBundlesSchemaError,
  isMissingPostResourceItemsColumnError,
  isMissingPostReviewStatusColumnError,
  isMissingPostTextColumnsError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
  resolvePostMediaUrl,
  type PostMediaRow,
} from '@/lib/posts-server';
import { getCreatorDisplayName } from '@/lib/profile';
import {
  createServiceClient,
} from '@/lib/server-helpers';
import {
  buildPostResourceBundleLockedPreview,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  resolvePostRemixCapability,
  validatePostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import {
  assessMarketplaceListingQuality,
  getMarketplaceQualityError,
  type MarketplaceQualityAssessment,
} from '@/lib/marketplace-trust';
import type {
  MarketplaceCheckoutCurrency,
  MarketplacePriceQuote,
  MarketplaceResourceFilter,
  MarketplaceResourceKindFilter,
  MarketplaceResourceSort,
  PersistedPostResourceBundleAccessMode,
  PostRemixCapability,
  PostRemixTarget,
  PostResourceAttachment,
  PostResourceBundleInput,
  PostResourceBundleLockedPreview,
  PostResourceBundleResources,
  PostResourceBundleStatus,
  PostResourceKind,
} from '@/lib/post-resource-bundles';
import { slugifySourceTool } from '@/lib/source-tools';
import {
  normalizeShowcaseSourceKind,
  type RawShowcaseSourceKind,
  type ShowcaseItemCategory,
  type ShowcaseMediaKind,
  type ShowcasePostFormat,
  type ShowcaseSourceKind,
  type ShowcaseVisibility,
} from '@/lib/showcase';
import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

type LinkedPostScope = 'public' | 'owner';

const BUNDLE_ROW_SELECT =
  'id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, resource_sections, resource_items, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at';
const BUNDLE_ROW_SELECT_LEGACY =
  'id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at';

type LinkedPostQueryResult = {
  data: unknown[] | null;
  error: unknown;
};

interface ProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface BundleRow {
  id: string;
  post_id: string;
  owner_user_id: string;
  legacy_asset_id: string | null;
  access_mode: PersistedPostResourceBundleAccessMode;
  status: PostResourceBundleStatus;
  title: string;
  summary: string;
  preview_text: string;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: Partial<WorkflowCanvasGraph> | null;
  attachments: unknown;
  allow_remix: boolean;
  resource_sections?: unknown;
  resource_items?: unknown;
  price_usd_cents: number;
  sales_count: number;
  earnings_usd_cents: number;
  created_at: string;
  updated_at: string;
}

interface LinkedPostRow extends PostMediaRow {
  id: string;
  generation_id: string | null;
  title: string | null;
  body: string | null;
  category: ShowcaseItemCategory;
  post_format: ShowcasePostFormat;
  visibility: ShowcaseVisibility;
  archived_at: string | null;
  review_status?: 'visible' | 'flagged' | 'hidden' | null;
  source_kind: RawShowcaseSourceKind;
  source_tool: string | null;
  source_tool_slug: string | null;
  save_count?: number | null;
  remix_count?: number | null;
  share_visit_count?: number | null;
}

interface OrderRow {
  bundle_id: string;
  buyer_user_id: string;
  legacy_order_id: string | null;
  id: string;
  generationId: string | null;
  amount_subunits: number;
  currency: MarketplaceCheckoutCurrency;
  created_at: string;
}

interface PostResourceBundleSellerSummary {
  id: string;
  username: string | null;
  name: string;
  avatar: string | null;
}

interface PostResourceBundleLinkedPost {
  id: string;
  generationId: string | null;
  title: string;
  category: ShowcaseItemCategory;
  body: string;
  postFormat: ShowcasePostFormat;
  visibility: ShowcaseVisibility;
  archivedAt: string | null;
  reviewStatus: 'visible' | 'flagged' | 'hidden';
  sourceKind: ShowcaseSourceKind;
  sourceTool: string | null;
  sourceToolSlug: string | null;
  mediaUrl: string | null;
  mediaKind: ShowcaseMediaKind | null;
  saveCount: number;
  remixCount: number;
  shareVisitCount: number;
}

export interface MarketplaceResourceListItem {
  id: string;
  postId: string;
  legacyAssetId: string | null;
  title: string;
  summary: string;
  previewText: string;
  accessMode: PersistedPostResourceBundleAccessMode;
  priceUsdCents: number;
  salesCount: number;
  earningsUsdCents: number;
  allowRemix: boolean;
  resourceKinds: PostResourceKind[];
  lockedPreview: PostResourceBundleLockedPreview;
  createdAt: string;
  updatedAt: string;
  seller: PostResourceBundleSellerSummary;
  post: PostResourceBundleLinkedPost | null;
  priceQuote: MarketplacePriceQuote;
  remixCapability: PostRemixCapability;
  remixTarget: PostRemixTarget;
}

export interface PostResourceBundleDetail extends MarketplaceResourceListItem {
  status: PostResourceBundleStatus;
  resources: PostResourceBundleResources | null;
  viewerIsOwner: boolean;
  viewerHasPurchased: boolean;
  viewerCanAccess: boolean;
}

interface SellerResourceDashboardBundle extends MarketplaceResourceListItem {
  status: PostResourceBundleStatus;
  post: PostResourceBundleLinkedPost | null;
  quality: MarketplaceQualityAssessment;
}

export interface PostResourceBundleMutationResult {
  postId: string;
  visibility: ShowcaseVisibility;
  bundleId: string | null;
  bundleStatus: PostResourceBundleStatus | null;
}

interface DeletedPostResourceSnapshot {
  id: string;
  title: string;
  visibility: ShowcaseVisibility;
  sourceKind: ShowcaseSourceKind;
  bundleAccessMode: PersistedPostResourceBundleAccessMode | null;
  bundleStatus: PostResourceBundleStatus | null;
  bundlePriceUsdCents: number | null;
  resourceKinds: PostResourceKind[];
  salesCount: number;
  earningsUsdCents: number;
  hadPaidOrders: boolean;
  deletedAt: string;
}

export interface SellerPostResourceBundleDashboard {
  bundles: SellerResourceDashboardBundle[];
  deletedSnapshots: DeletedPostResourceSnapshot[];
  sales: Array<{
    id: string;
    bundleId: string;
    bundleTitle: string;
    buyerUserId: string;
    buyerLabel: string;
    amountSubunits: number;
    currency: MarketplaceCheckoutCurrency;
    createdAt: string;
  }>;
  totalSalesCount: number;
  totalEarningsUsdCents: number;
  generatedAt: string;
}

type ExchangeRateApiResponse = {
  result?: string;
  base_code?: string;
  rates?: Record<string, unknown>;
};

const FX_UPSTREAM_URL = 'https://open.er-api.com/v6/latest/INR';

const getInrFxRates = cache(async (): Promise<Record<string, number> | null> => {
  try {
    const response = await fetch(FX_UPSTREAM_URL, {
      headers: {
        Accept: 'application/json',
      },
      next: {
        revalidate: 3600,
      },
    });

    if (!response.ok) {
      throw new Error(`FX upstream error: ${response.status}`);
    }

    const payload = (await response.json()) as ExchangeRateApiResponse;
    if (
      payload?.result !== 'success' ||
      payload?.base_code !== 'INR' ||
      !payload?.rates ||
      typeof payload.rates !== 'object'
    ) {
      throw new Error('FX upstream returned unexpected payload');
    }

    const rates: Record<string, number> = {};
    for (const [currency, value] of Object.entries(payload.rates)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        rates[currency] = value;
      }
    }

    return rates;
  } catch (error) {
    console.error('Failed to load post resource FX rates:', error);
    return null;
  }
});

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeMarketplaceSearchQuery(value: string | null | undefined): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80)
    : '';
}

function marketplaceItemMatchesQuery(item: MarketplaceResourceListItem, normalizedQuery: string): boolean {
  const searchableText = [
    item.title,
    item.summary,
    item.previewText,
    item.seller.username,
    item.seller.name,
    item.post?.title,
    item.post?.body,
    item.post?.sourceTool,
    item.resourceKinds.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchableText.includes(normalizedQuery);
}

function normalizeAttachments(value: unknown): PostResourceAttachment[] {
  return normalizePostResourceAttachments(value);
}

function isMissingSourceToolSlugColumn(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string } | null;
  return candidate?.code === '42703' && Boolean(candidate.message?.includes('source_tool_slug'));
}

async function buildPriceQuote(
  priceUsdCents: number,
  countryCode?: string | null
): Promise<MarketplacePriceQuote> {
  if (countryCode?.toUpperCase() === 'IN') {
    const rates = await getInrFxRates();
    if (rates) {
      const amountInr = convertFromUsd(priceUsdCents / 100, 'INR', rates);
      if (Number.isFinite(amountInr)) {
        const amountSubunits = Math.max(0, Math.round(amountInr * 100));

        return {
          currency: 'INR',
          amountSubunits,
          formatted: formatMoney(amountInr, 'INR', 'en-IN'),
          note: 'Charged in INR for buyers in India.',
        };
      }
    }
  }

  return {
    currency: 'USD',
    amountSubunits: priceUsdCents,
    formatted: formatMoney(priceUsdCents / 100, 'USD', 'en-US'),
    note: countryCode?.toUpperCase() === 'IN' ? 'INR conversion unavailable right now. Checkout falls back to USD.' : null,
  };
}

export async function getPostResourceBundlePriceQuote(
  priceUsdCents: number,
  countryCode?: string | null
): Promise<MarketplacePriceQuote> {
  return buildPriceQuote(priceUsdCents, countryCode);
}

async function loadProfileMap(userIds: string[]) {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueUserIds.length === 0) {
    return new Map<string, ProfileRow>();
  }

  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', uniqueUserIds);

  if (error) {
    console.error('Failed to load post resource profiles:', error);
    return new Map();
  }

  return new Map(
    (data ?? [])
      .filter((row): row is ProfileRow => typeof row.id === 'string')
      .map((row) => [row.id, row])
  );
}

function toSellerSummary(
  userId: string,
  profilesMap: Map<string, ProfileRow>
): PostResourceBundleSellerSummary {
  const profile = profilesMap.get(userId);

  return {
    id: userId,
    username: profile?.username ?? null,
    name: getCreatorDisplayName({
      displayName: profile?.display_name ?? null,
      username: profile?.username ?? null,
    }),
    avatar: profile?.avatar_url ?? null,
  };
}

async function loadLinkedPostMap(
  postIds: string[],
  scope: LinkedPostScope = 'public'
) {
  const uniquePostIds = Array.from(new Set(postIds.filter(Boolean)));
  if (uniquePostIds.length === 0) {
    return new Map<string, PostResourceBundleLinkedPost>();
  }

  const adminSupabase = createServiceClient();
  let resultQuery = adminSupabase
    .from('posts')
    .select('id, generation_id, title, body, category, post_format, visibility, archived_at, review_status, showcase_asset_path, output_url, source_kind, source_tool, source_tool_slug, save_count, remix_count, share_visit_count')
    .in('id', uniquePostIds);

  if (scope === 'public') {
    resultQuery = resultQuery.eq('visibility', 'public').is('archived_at', null).neq('review_status', 'hidden');
  }

  let result: LinkedPostQueryResult = await resultQuery;
  if (isMissingSourceToolSlugColumn(result.error) || isMissingPostReviewStatusColumnError(result.error)) {
    const includeSourceToolSlug = !isMissingSourceToolSlugColumn(result.error);
    const includeReviewStatus = !isMissingPostReviewStatusColumnError(result.error);
    let fallbackQuery = adminSupabase
      .from('posts')
      .select(
        [
          'id',
          'generation_id',
          'title',
          'body',
          'category',
          'post_format',
          'visibility',
          'archived_at',
          includeReviewStatus ? 'review_status' : null,
          'showcase_asset_path',
          'output_url',
          'source_kind',
          'source_tool',
          includeSourceToolSlug ? 'source_tool_slug' : null,
          'save_count',
          'remix_count',
          'share_visit_count',
        ].filter(Boolean).join(', ')
      )
      .in('id', uniquePostIds);

    if (scope === 'public') {
      fallbackQuery = fallbackQuery.eq('visibility', 'public').is('archived_at', null);
      if (includeReviewStatus) {
        fallbackQuery = fallbackQuery.neq('review_status', 'hidden');
      }
    }

    result = await fallbackQuery;
  }

  let rows: LinkedPostRow[] = [];

  if (isMissingPostTextColumnsError(result.error)) {
    let legacyQuery = adminSupabase
      .from('posts')
      .select('id, generation_id, title, category, visibility, archived_at, review_status, showcase_asset_path, output_url, source_kind, source_tool, source_tool_slug, save_count, remix_count, share_visit_count')
      .in('id', uniquePostIds);

    if (scope === 'public') {
      legacyQuery = legacyQuery.eq('visibility', 'public').is('archived_at', null).neq('review_status', 'hidden');
    }

    let legacyResult: LinkedPostQueryResult = await legacyQuery;
    if (isMissingSourceToolSlugColumn(legacyResult.error) || isMissingPostReviewStatusColumnError(legacyResult.error)) {
      const includeSourceToolSlug = !isMissingSourceToolSlugColumn(legacyResult.error);
      const includeReviewStatus = !isMissingPostReviewStatusColumnError(legacyResult.error);
      let fallbackLegacyQuery = adminSupabase
        .from('posts')
        .select(
          [
          'id',
          'generation_id',
            'title',
            'category',
            'visibility',
            'archived_at',
            includeReviewStatus ? 'review_status' : null,
            'showcase_asset_path',
            'output_url',
            'source_kind',
          'source_tool',
          includeSourceToolSlug ? 'source_tool_slug' : null,
          'save_count',
          'remix_count',
          'share_visit_count',
          ].filter(Boolean).join(', ')
        )
        .in('id', uniquePostIds);

      if (scope === 'public') {
        fallbackLegacyQuery = fallbackLegacyQuery.eq('visibility', 'public').is('archived_at', null);
        if (includeReviewStatus) {
          fallbackLegacyQuery = fallbackLegacyQuery.neq('review_status', 'hidden');
        }
      }

      legacyResult = await fallbackLegacyQuery;
    }

    if (legacyResult.error) {
      if (!isMissingPostsSchemaError(legacyResult.error)) {
        console.error('Failed to load linked posts for resource bundles:', legacyResult.error);
      }
      return new Map();
    }

    rows = ((legacyResult.data ?? []) as Array<Omit<LinkedPostRow, 'body' | 'post_format'>>).map((row) => ({
      ...row,
      body: null,
      post_format: normalizeLegacyPostFormat(row.category),
    }));
  } else if (result.error) {
    if (!isMissingPostsSchemaError(result.error)) {
      console.error('Failed to load linked posts for resource bundles:', result.error);
    }
    return new Map();
  } else {
    rows = (result.data ?? []) as LinkedPostRow[];
  }

  const linkedPosts = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      generationId: row.generation_id,
      title: row.title?.trim() || deriveTitleFromBody(row.body) || (row.post_format === 'text' ? 'Untitled note' : 'Untitled creation'),
      category: row.category,
      body: row.body?.trim() || '',
      postFormat: row.post_format,
      visibility: row.visibility,
      archivedAt: row.archived_at,
      reviewStatus: row.review_status ?? 'visible',
      sourceKind: normalizeShowcaseSourceKind(row.source_kind),
      sourceTool: row.source_tool,
      sourceToolSlug: row.source_tool_slug ?? slugifySourceTool(row.source_tool),
      mediaUrl: await resolvePostMediaUrl(adminSupabase, row),
      mediaKind: getPostMediaKind(row.category, row.post_format),
      saveCount: row.save_count ?? 0,
      remixCount: row.remix_count ?? 0,
      shareVisitCount: row.share_visit_count ?? 0,
    }))
  );

  return new Map(linkedPosts.map((row) => [row.id, row]));
}

async function hydrateBundleRows(
  rows: BundleRow[],
  countryCode?: string | null,
  scope: LinkedPostScope = 'public'
): Promise<MarketplaceResourceListItem[]> {
  const profilesMap = await loadProfileMap(rows.map((row) => row.owner_user_id));
  const postMap = await loadLinkedPostMap(rows.map((row) => row.post_id), scope);

  return Promise.all(
    rows.map(async (row) => {
      const normalizedResources = normalizeResources(row);
      const lockedPreview = buildPostResourceBundleLockedPreview(normalizedResources, row.updated_at);
      const post = postMap.get(row.post_id) ?? null;
      const remix = resolvePostRemixCapability({
        generationId: post?.generationId ?? null,
        postFormat: post?.postFormat ?? null,
        category: post?.category ?? null,
        sourceKind: post?.sourceKind ?? null,
        resourceBundle: {
          viewerCanAccess: scope === 'owner',
          allowRemix: row.allow_remix,
          items: normalizedResources.items ?? [],
        },
      });

      return {
        id: row.id,
        postId: row.post_id,
        legacyAssetId: row.legacy_asset_id,
        title: row.title,
        summary: row.summary,
        previewText: row.preview_text,
        accessMode: row.access_mode,
        priceUsdCents: row.price_usd_cents,
        salesCount: row.sales_count,
        earningsUsdCents: row.earnings_usd_cents,
        allowRemix: row.allow_remix,
        resourceKinds: lockedPreview.resourceKinds,
        lockedPreview,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        seller: toSellerSummary(row.owner_user_id, profilesMap),
        post,
        priceQuote: await buildPriceQuote(row.price_usd_cents, countryCode),
        remixCapability: remix.capability,
        remixTarget: remix.target,
      };
    })
  );
}

function normalizeResources(row: BundleRow): PostResourceBundleResources {
  const sections = normalizePostResourceSections(row.resource_sections);
  const legacyResources: PostResourceBundleResources = {
    promptText: normalizeText(row.prompt_text),
    notesMarkdown: normalizeText(row.notes_markdown),
    workflowShareUrl: normalizeText(row.workflow_share_url),
    workflowSnapshot: row.workflow_snapshot
      ? serializeWorkflowGraph(normalizeWorkflowGraph(row.workflow_snapshot))
      : null,
    attachments: normalizeAttachments(row.attachments),
    allowRemix: Boolean(row.allow_remix),
    sections,
  };

  return {
    ...legacyResources,
    items: normalizePostResourceItems(row.resource_items, legacyResources),
  };
}

function buildBundleMutationPayload(bundle: PostResourceBundleInput | null | undefined, ownerUserId?: string | null) {
  const accessMode = bundle?.accessMode ?? 'none';

  if (accessMode === 'none') {
    return {
      accessMode: 'none',
    };
  }

  const validationError = validatePostResourceBundleInput(bundle, { ownerUserId });
  if (validationError) {
    throw new Error(validationError);
  }

  const resources = bundle?.resources ?? {};
  const sections = normalizePostResourceSections(resources.sections);
  const attachments = normalizePostResourceAttachments(resources.attachments);

  return {
    accessMode,
    summary: normalizeText(bundle?.summary ?? null) ?? '',
    previewText: normalizeText(bundle?.previewText ?? null) ?? '',
    priceUsdCents: accessMode === 'paid'
      ? Math.max(100, Number.isFinite(bundle?.priceUsdCents) ? Math.round(bundle?.priceUsdCents ?? 0) : 0)
      : 0,
    resources: {
      promptText: normalizeText(resources.promptText ?? null),
      notesMarkdown: normalizeText(resources.notesMarkdown ?? null),
      workflowShareUrl: normalizeText(resources.workflowShareUrl ?? null),
      workflowSnapshot: resources.workflowSnapshot ?? null,
      attachments,
      allowRemix: Boolean(resources.allowRemix),
      sections,
      items: normalizePostResourceItems(resources.items, {
        promptText: normalizeText(resources.promptText ?? null),
        notesMarkdown: normalizeText(resources.notesMarkdown ?? null),
        workflowShareUrl: normalizeText(resources.workflowShareUrl ?? null),
        workflowSnapshot: resources.workflowSnapshot ?? null,
        attachments,
        allowRemix: Boolean(resources.allowRemix),
        sections,
      }),
    },
  };
}

export async function getMarketplaceQualityErrorForPostBundle(params: {
  supabase: SupabaseClient;
  ownerUserId: string;
  post: {
    title?: string | null;
    body?: string | null;
    visibility?: ShowcaseVisibility | string | null;
    archivedAt?: string | null;
    reviewStatus?: string | null;
    showcaseAssetPath?: string | null;
    outputUrl?: string | null;
    mediaUrl?: string | null;
    hasMedia?: boolean | null;
  };
  bundle: PostResourceBundleInput | null | undefined;
}): Promise<string | null> {
  const accessMode = params.bundle?.accessMode ?? 'none';
  if (accessMode === 'none') {
    return null;
  }

  const { data: profile, error } = await params.supabase
    .from('profiles')
    .select('username, display_name')
    .eq('id', params.ownerUserId)
    .maybeSingle();

  if (error) {
    console.error('Failed to load creator profile for marketplace quality gate:', error);
  }

  const postHasMedia = Boolean(
    params.post.hasMedia ||
    params.post.mediaUrl ||
    params.post.showcaseAssetPath ||
    params.post.outputUrl
  );

  return getMarketplaceQualityError({
    title: params.post.title ?? 'Attached unlock',
    summary: params.bundle?.summary ?? null,
    previewText: params.bundle?.previewText ?? null,
    accessMode,
    priceUsdCents: params.bundle?.priceUsdCents ?? null,
    resources: params.bundle?.resources ?? null,
    post: {
      title: params.post.title ?? null,
      body: params.post.body ?? null,
      visibility: params.post.visibility ?? null,
      archivedAt: params.post.archivedAt ?? null,
      reviewStatus: params.post.reviewStatus ?? 'visible',
      hasMedia: postHasMedia,
    },
    seller: {
      username: typeof profile?.username === 'string' ? profile.username : null,
      displayName: typeof profile?.display_name === 'string' ? profile.display_name : null,
    },
  });
}

function normalizeMutationResult(row: unknown): PostResourceBundleMutationResult {
  const record = row as {
    post_id?: unknown;
    visibility?: unknown;
    bundle_id?: unknown;
    bundle_status?: unknown;
  } | null;

  if (!record || typeof record.post_id !== 'string') {
    throw new Error('Post publish transaction did not return a post id.');
  }

  const visibility = record.visibility === 'public' || record.visibility === 'unlisted' || record.visibility === 'private'
    ? record.visibility
    : 'private';
  const bundleStatus = record.bundle_status === 'draft' || record.bundle_status === 'published'
    ? record.bundle_status
    : null;

  return {
    postId: record.post_id,
    visibility,
    bundleId: typeof record.bundle_id === 'string' ? record.bundle_id : null,
    bundleStatus,
  };
}

export async function createPostWithResourceBundleAtomically(params: {
  supabase: SupabaseClient;
  post: Record<string, unknown>;
  bundle: PostResourceBundleInput | null | undefined;
}): Promise<PostResourceBundleMutationResult> {
  const ownerUserId = typeof params.post.user_id === 'string' ? params.post.user_id : null;
  const { data, error } = await params.supabase.rpc('upsert_post_with_resource_bundle', {
    p_post: params.post,
    p_bundle: buildBundleMutationPayload(params.bundle, ownerUserId),
    p_has_bundle: true,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return normalizeMutationResult(row);
}

export async function updatePostWithResourceBundleAtomically(params: {
  supabase: SupabaseClient;
  postId: string;
  ownerUserId: string;
  patch: Record<string, unknown>;
  hasBundlePayload: boolean;
  bundle: PostResourceBundleInput | null | undefined;
}): Promise<PostResourceBundleMutationResult> {
  const { data, error } = await params.supabase.rpc('update_post_with_resource_bundle', {
    p_post_id: params.postId,
    p_owner_user_id: params.ownerUserId,
    p_post_patch: params.patch,
    p_has_bundle: params.hasBundlePayload,
    p_bundle: params.hasBundlePayload ? buildBundleMutationPayload(params.bundle, params.ownerUserId) : null,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return normalizeMutationResult(row);
}

export async function publishGenerationPostWithResourceBundleAtomically(params: {
  supabase: SupabaseClient;
  generationId: string;
  ownerUserId: string;
  generationUpdate: Record<string, unknown>;
  post: Record<string, unknown>;
  bundle: PostResourceBundleInput | null | undefined;
  hasBundlePayload: boolean;
}): Promise<PostResourceBundleMutationResult> {
  const { data, error } = await params.supabase.rpc('publish_generation_post_with_resource_bundle', {
    p_generation_id: params.generationId,
    p_owner_user_id: params.ownerUserId,
    p_generation_update: params.generationUpdate,
    p_post: params.post,
    p_bundle: params.hasBundlePayload ? buildBundleMutationPayload(params.bundle, params.ownerUserId) : null,
    p_has_bundle: params.hasBundlePayload,
  });

  if (error) {
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return normalizeMutationResult(row);
}

function isBundlePublishedForMarketplace(row: BundleRow): boolean {
  return row.status === 'published';
}

function canViewerAccessBundle(row: BundleRow, viewerUserId?: string | null, viewerHasPurchased = false): boolean {
  return Boolean(viewerUserId && viewerUserId === row.owner_user_id) || viewerHasPurchased;
}

export async function savePostResourceBundle(params: {
  supabase: SupabaseClient;
  postId: string;
  ownerUserId: string;
  postTitle: string | null;
  postVisibility: ShowcaseVisibility;
  bundle: PostResourceBundleInput | null | undefined;
}) {
  const { supabase, postId, ownerUserId, postTitle, postVisibility, bundle } = params;
  const accessMode = bundle?.accessMode ?? 'none';

  if (accessMode === 'none') {
    const { error } = await supabase
      .from('post_resource_bundles')
      .delete()
      .eq('post_id', postId)
      .eq('owner_user_id', ownerUserId);

    if (error && !isMissingPostResourceBundlesSchemaError(error)) {
      throw error;
    }

    return null;
  }

  const resources = bundle?.resources ?? {};
  const sections = normalizePostResourceSections(resources.sections);
  const attachments = normalizePostResourceAttachments(resources.attachments);
  const validationError = validatePostResourceBundleInput(bundle, { ownerUserId });
  if (validationError) {
    throw new Error(validationError);
  }

  const status: PostResourceBundleStatus = postVisibility === 'public' ? 'published' : 'draft';
  const normalizedTitle = normalizeText(postTitle) ?? 'Attached unlock';
  const priceUsdCents = accessMode === 'free'
    ? 0
    : Math.max(100, Number.isFinite(bundle?.priceUsdCents) ? Math.round(bundle?.priceUsdCents ?? 0) : 0);

  const payload = {
    post_id: postId,
    owner_user_id: ownerUserId,
    access_mode: accessMode,
    status,
    title: normalizedTitle,
    summary: normalizeText(bundle?.summary ?? null) ?? '',
    preview_text: normalizeText(bundle?.previewText ?? null) ?? '',
    prompt_text: normalizeText(resources.promptText ?? null),
    notes_markdown: normalizeText(resources.notesMarkdown ?? null),
    workflow_share_url: normalizeText(resources.workflowShareUrl ?? null),
    workflow_snapshot: resources.workflowSnapshot ?? null,
    attachments,
    allow_remix: Boolean(resources.allowRemix),
    resource_sections: sections,
    resource_items: normalizePostResourceItems(resources.items, {
      promptText: normalizeText(resources.promptText ?? null),
      notesMarkdown: normalizeText(resources.notesMarkdown ?? null),
      workflowShareUrl: normalizeText(resources.workflowShareUrl ?? null),
      workflowSnapshot: resources.workflowSnapshot ?? null,
      attachments,
      allowRemix: Boolean(resources.allowRemix),
      sections,
    }),
    price_usd_cents: priceUsdCents,
  };

  const { data, error } = await supabase
    .from('post_resource_bundles')
    .upsert(payload, {
      onConflict: 'post_id',
    })
    .select('id, post_id, status')
    .single();

  if (error) {
    throw error;
  }

  return {
    id: data.id as string,
    postId: data.post_id as string,
    status: data.status as PostResourceBundleStatus,
  };
}

function isMissingMarketplaceListRpcError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string } | null;
  const message = candidate?.message ?? '';

  return (
    candidate?.code === 'PGRST202' ||
    message.includes('list_marketplace_resource_bundles') ||
    isMissingPostResourceBundlesSchemaError(error)
  );
}

async function getMarketplaceResourceListFallback(options: {
  filter: MarketplaceResourceFilter;
  resource: MarketplaceResourceKindFilter;
  tool: string | null;
  q: string | null;
  sort: MarketplaceResourceSort;
  offset: number;
  limit: number;
  countryCode: string | null;
}) {
  const { filter, resource, tool, q, sort, offset, limit, countryCode } = options;
  const normalizedToolFilter = tool ? slugifySourceTool(tool) : '';
  const normalizedQuery = normalizeMarketplaceSearchQuery(q);
  const adminSupabase = createServiceClient();
  const buildQuery = (selectColumns: string) => {
    let query = adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .eq('status', 'published');

    if (filter === 'free') {
      query = query.eq('access_mode', 'free');
    } else if (filter === 'paid') {
      query = query.eq('access_mode', 'paid');
    }

    if (sort === 'top-sales') {
      query = query
        .order('sales_count', { ascending: false })
        .order('created_at', { ascending: false });
    } else if (sort === 'price-low') {
      query = query
        .order('price_usd_cents', { ascending: true })
        .order('created_at', { ascending: false });
    } else if (sort === 'price-high') {
      query = query
        .order('price_usd_cents', { ascending: false })
        .order('created_at', { ascending: false });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    return query;
  };

  let { data, error } = await buildQuery(BUNDLE_ROW_SELECT);
  if (isMissingPostResourceItemsColumnError(error)) {
    ({ data, error } = await buildQuery(BUNDLE_ROW_SELECT_LEGACY));
  }
  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return {
        items: [],
        pageInfo: {
          hasMore: false,
          nextOffset: null,
          offset,
          limit,
        },
      };
    }

    console.error('Failed to load marketplace resource list:', error);
    throw error;
  }

  const rows = (data ?? []) as unknown as BundleRow[];
  const hydratedItems = await hydrateBundleRows(rows, countryCode);
  const filteredItems = hydratedItems.filter((item) => {
    if (!item.post) {
      return false;
    }

    const matchesResource = resource === 'all' || item.resourceKinds.includes(resource);
    const itemToolSlug = item.post.sourceToolSlug ?? slugifySourceTool(item.post.sourceTool);
    const matchesTool = !normalizedToolFilter || itemToolSlug === normalizedToolFilter;
    const matchesQuery = !normalizedQuery || marketplaceItemMatchesQuery(item, normalizedQuery);
    const quality = assessMarketplaceListingQuality({
      title: item.title,
      summary: item.summary,
      previewText: item.previewText,
      accessMode: item.accessMode,
      priceUsdCents: item.priceUsdCents,
      resourceKinds: item.resourceKinds,
      post: item.post,
      seller: item.seller,
    });

    return quality.eligible && matchesResource && matchesTool && matchesQuery;
  });
  const pageItems = filteredItems.slice(offset, offset + limit);
  const hasMore = filteredItems.length > offset + limit;

  return {
    items: pageItems,
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      offset,
      limit,
    },
  };
}

export async function getMarketplaceResourceList(options?: {
  filter?: MarketplaceResourceFilter;
  resource?: MarketplaceResourceKindFilter;
  tool?: string | null;
  q?: string | null;
  sort?: MarketplaceResourceSort;
  offset?: number;
  limit?: number;
  countryCode?: string | null;
}) {
  const {
    filter = 'all',
    resource = 'all',
    tool = null,
    q = null,
    sort = 'recent',
    offset = 0,
    limit = 24,
    countryCode = null,
  } = options ?? {};
  const normalizedToolFilter = tool ? slugifySourceTool(tool) : '';
  const normalizedQuery = normalizeMarketplaceSearchQuery(q);

  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase.rpc('list_marketplace_resource_bundles', {
    p_access_filter: filter,
    p_resource_filter: resource,
    p_tool_slug: normalizedToolFilter || null,
    p_query: normalizedQuery || null,
    p_sort: sort,
    p_offset: offset,
    p_limit: limit + 1,
  });

  if (error) {
    if (isMissingMarketplaceListRpcError(error)) {
      return getMarketplaceResourceListFallback({
        filter,
        resource,
        tool,
        q,
        sort,
        offset,
        limit,
        countryCode,
      });
    }

    console.error('Failed to load marketplace resource list:', error);
    throw error;
  }

  const rows = ((data ?? []) as BundleRow[]).slice(0, limit + 1);
  const hasMore = rows.length > limit;
  const hydratedItems = await hydrateBundleRows(rows, countryCode);
  const pageItems = hydratedItems.filter((item) => {
    if (!item.post) {
      return false;
    }

    const quality = assessMarketplaceListingQuality({
      title: item.title,
      summary: item.summary,
      previewText: item.previewText,
      accessMode: item.accessMode,
      priceUsdCents: item.priceUsdCents,
      resourceKinds: item.resourceKinds,
      post: item.post,
      seller: item.seller,
    });

    return quality.eligible && (!normalizedQuery || marketplaceItemMatchesQuery(item, normalizedQuery));
  }).slice(0, limit);
  const hasDroppedItems = hydratedItems.length > pageItems.length;

  return {
    items: pageItems,
    pageInfo: {
      hasMore: hasMore || hasDroppedItems,
      nextOffset: hasMore || hasDroppedItems ? offset + limit : null,
      offset,
      limit,
    },
  };
}

export async function getPostResourceBundleDetailByPostId(
  postId: string,
  options?: {
    viewerUserId?: string | null;
    countryCode?: string | null;
  }
): Promise<PostResourceBundleDetail | null> {
  const { viewerUserId = null, countryCode = null } = options ?? {};
  const adminSupabase = createServiceClient();
  const selectBundle = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .eq('post_id', postId)
      .maybeSingle();
  let { data, error } = await selectBundle(BUNDLE_ROW_SELECT);
  if (isMissingPostResourceItemsColumnError(error)) {
    ({ data, error } = await selectBundle(BUNDLE_ROW_SELECT_LEGACY));
  }

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return null;
    }

    console.error('Failed to load post resource bundle:', error);
    throw error;
  }

  const row = (data as BundleRow | null) ?? null;
  if (!row) {
    return null;
  }

  if (!isBundlePublishedForMarketplace(row) && row.owner_user_id !== viewerUserId) {
    return null;
  }

  let viewerHasPurchased = false;
  if (viewerUserId && viewerUserId !== row.owner_user_id) {
    const { data: purchaseData, error: purchaseError } = await adminSupabase
      .from('post_resource_bundle_purchases')
      .select('bundle_id, buyer_user_id')
      .eq('bundle_id', row.id)
      .eq('buyer_user_id', viewerUserId)
      .maybeSingle();

    if (purchaseError && !isMissingPostResourceBundlesSchemaError(purchaseError)) {
      console.error('Failed to load resource bundle purchase state:', purchaseError);
    } else {
      viewerHasPurchased = Boolean(purchaseData);
    }
  }

  const viewerIsOwner = Boolean(viewerUserId && viewerUserId === row.owner_user_id);
  const viewerCanAccess = canViewerAccessBundle(row, viewerUserId, viewerHasPurchased);
  const [hydrated] = await hydrateBundleRows([row], countryCode, viewerIsOwner ? 'owner' : 'public');
  const normalizedResources = normalizeResources(row);
  const remix = resolvePostRemixCapability({
    generationId: hydrated.post?.generationId ?? null,
    postFormat: hydrated.post?.postFormat ?? null,
    category: hydrated.post?.category ?? null,
    sourceKind: hydrated.post?.sourceKind ?? null,
    resourceBundle: {
      viewerCanAccess,
      allowRemix: row.allow_remix,
      items: normalizedResources.items ?? [],
    },
  });

  return {
    ...hydrated,
    status: row.status,
    resources: viewerCanAccess ? normalizedResources : null,
    viewerHasPurchased,
    viewerIsOwner,
    viewerCanAccess,
    remixCapability: remix.capability,
    remixTarget: remix.target,
  };
}

export async function getSellerPostResourceBundleDashboard(
  userId: string,
  options?: {
    countryCode?: string | null;
  }
): Promise<SellerPostResourceBundleDashboard> {
  const countryCode = options?.countryCode ?? null;
  const adminSupabase = createServiceClient();
  const selectBundles = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .eq('owner_user_id', userId)
      .order('created_at', { ascending: false });
  let { data, error } = await selectBundles(BUNDLE_ROW_SELECT);
  if (isMissingPostResourceItemsColumnError(error)) {
    ({ data, error } = await selectBundles(BUNDLE_ROW_SELECT_LEGACY));
  }

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return {
        bundles: [],
        deletedSnapshots: [],
        sales: [],
        totalSalesCount: 0,
        totalEarningsUsdCents: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    console.error('Failed to load seller resource bundles:', error);
    throw error;
  }

  const rows = (data ?? []) as unknown as BundleRow[];
  const hydratedBundles = await hydrateBundleRows(rows, countryCode, 'owner');
  const bundles = hydratedBundles.map((bundle, index) => ({
    ...bundle,
    status: rows[index]?.status ?? 'draft',
    quality: assessMarketplaceListingQuality({
      title: bundle.title,
      summary: bundle.summary,
      previewText: bundle.previewText,
      accessMode: bundle.accessMode,
      priceUsdCents: bundle.priceUsdCents,
      resourceKinds: bundle.resourceKinds,
      post: bundle.post,
      seller: bundle.seller,
    }),
  }));
  const bundleIdToTitle = new Map(rows.map((row) => [row.id, row.title]));

  let sales: SellerPostResourceBundleDashboard['sales'] = [];
  if (rows.length > 0) {
    const bundleIds = rows.map((row) => row.id);
    const { data: orderData, error: orderError } = await adminSupabase
      .from('post_resource_bundle_orders')
      .select('id, bundle_id, buyer_user_id, legacy_order_id, amount_subunits, currency, created_at')
      .in('bundle_id', bundleIds)
      .eq('status', 'paid')
      .order('created_at', { ascending: false });

    if (orderError) {
      console.error('Failed to load seller bundle sales:', orderError);
      throw orderError;
    }

    const orders = (orderData ?? []) as OrderRow[];
    const buyerProfiles = await loadProfileMap(orders.map((row) => row.buyer_user_id));
    sales = orders.map((row) => {
      const buyerProfile = buyerProfiles.get(row.buyer_user_id);
      const buyerLabel = buyerProfile?.username
        ? `@${buyerProfile.username}`
        : getCreatorDisplayName({
            displayName: buyerProfile?.display_name ?? null,
            username: buyerProfile?.username ?? null,
            email: row.buyer_user_id,
          });

      return {
        id: row.id,
        bundleId: row.bundle_id,
        bundleTitle: bundleIdToTitle.get(row.bundle_id) ?? 'Attached unlock',
        buyerUserId: row.buyer_user_id,
        buyerLabel,
        amountSubunits: row.amount_subunits,
        currency: row.currency,
        createdAt: row.created_at,
      };
    });
  }

  const { data: deletedAuditData, error: deletedAuditError } = await adminSupabase
    .from('post_deletion_audits')
    .select('id, title, visibility, source_kind, bundle_access_mode, bundle_status, bundle_price_usd_cents, bundle_resource_kinds, sales_count, earnings_usd_cents, had_paid_orders, deleted_at')
    .eq('owner_user_id', userId)
    .order('deleted_at', { ascending: false });

  if (deletedAuditError) {
    console.error('Failed to load deleted post resource snapshots:', deletedAuditError);
    throw deletedAuditError;
  }

  const deletedSnapshots = ((deletedAuditData ?? []) as Array<{
    id: string;
    title: string;
    visibility: ShowcaseVisibility;
    source_kind: RawShowcaseSourceKind;
    bundle_access_mode: PersistedPostResourceBundleAccessMode | null;
    bundle_status: PostResourceBundleStatus | null;
    bundle_price_usd_cents: number | null;
    bundle_resource_kinds: unknown;
    sales_count: number;
    earnings_usd_cents: number;
    had_paid_orders: boolean;
    deleted_at: string;
  }>).map((row) => ({
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    sourceKind: normalizeShowcaseSourceKind(row.source_kind),
    bundleAccessMode: row.bundle_access_mode,
    bundleStatus: row.bundle_status,
    bundlePriceUsdCents: row.bundle_price_usd_cents,
    resourceKinds: Array.isArray(row.bundle_resource_kinds)
      ? row.bundle_resource_kinds.filter(
          (kind): kind is PostResourceKind =>
            kind === 'prompt' || kind === 'workflow' || kind === 'files' || kind === 'notes' || kind === 'remix'
        )
      : [],
    salesCount: row.sales_count,
    earningsUsdCents: row.earnings_usd_cents,
    hadPaidOrders: row.had_paid_orders,
    deletedAt: row.deleted_at,
  }));

  return {
    bundles,
    deletedSnapshots,
    sales,
    totalSalesCount: rows.reduce((sum, row) => sum + row.sales_count, 0),
    totalEarningsUsdCents: rows.reduce((sum, row) => sum + row.earnings_usd_cents, 0),
    generatedAt: new Date().toISOString(),
  };
}

export async function resolvePostIdForResourceIdentifier(identifier: string): Promise<string | null> {
  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('post_id, legacy_asset_id')
    .or(`id.eq.${identifier},legacy_asset_id.eq.${identifier}`)
    .maybeSingle();

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      const { data: legacyAsset, error: legacyError } = await adminSupabase
        .from('marketplace_assets')
        .select('post_id')
        .eq('id', identifier)
        .maybeSingle();

      if (legacyError) {
        if (!isMissingMarketplaceSchemaError(legacyError)) {
          console.error('Failed to resolve legacy marketplace post id:', legacyError);
        }
        return null;
      }

      return (legacyAsset?.post_id as string | null) ?? null;
    }

    console.error('Failed to resolve bundle post id:', error);
    return null;
  }

  return (data?.post_id as string | null) ?? null;
}

export async function getBundleForOrderByPostId(postId: string): Promise<BundleRow | null> {
  const adminSupabase = createServiceClient();
  const selectBundle = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .eq('post_id', postId)
      .maybeSingle();
  let { data, error } = await selectBundle(BUNDLE_ROW_SELECT);
  if (isMissingPostResourceItemsColumnError(error)) {
    ({ data, error } = await selectBundle(BUNDLE_ROW_SELECT_LEGACY));
  }

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return null;
    }

    console.error('Failed to load bundle by post id:', error);
    throw error;
  }

  return (data as BundleRow | null) ?? null;
}
