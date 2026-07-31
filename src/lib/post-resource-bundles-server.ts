import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { unstable_cache } from 'next/cache';
import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  convertFromUsd,
  formatMoney,
  hasPlausibleUsdInrRate,
} from '@/lib/currency';
import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';
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
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  resolvePostRemixCapability,
  sanitizePostResourceBundleLockedPreview,
  validatePostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import {
  assessMarketplaceListingQuality,
  CREATOR_PROFILE_CHECK_ERROR,
  getCreatorPublishReadinessError,
  getMarketplaceQualityError,
  getPublicPostQualityError,
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
  PostResourceItem,
  PostResourceItemRole,
  PostResourceItemType,
  PostResourceRemixUse,
  PostResourceKind,
} from '@/lib/post-resource-bundles';
import { buildGenerationRecipeResourceItems } from '@/lib/generation-paywall';
import {
  buildLegacyGenerationInputMedia,
  loadGenerationInputMediaMap,
  type GenerationInputMediaItem,
} from '@/lib/generation-input-media';
import { slugifySourceTool } from '@/lib/source-tools';
import { getStoredMediaLocation } from '@/lib/media-urls';
import { loadPostMediaItemsMap } from '@/lib/post-media';
import {
  MARKETPLACE_DEFAULT_PAGE_SIZE,
  shouldCacheMarketplaceResourceListBasePage,
} from '@/lib/marketplace-resource-list-cache-policy';
import { MARKETPLACE_RESOURCE_LIST_CACHE_TAG } from '@/lib/marketplace-resource-list-cache';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';
import {
  isGenerationRecipeAssetId,
  MAGICBOOKLET_SOURCE_KIND,
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
const POST_RESOURCE_FILES_BUCKET = 'post_resource_files';
const MARKETPLACE_FALLBACK_MIN_BATCH_SIZE = 24;
const MARKETPLACE_FALLBACK_MAX_BATCH_SIZE = 96;
// The missing-RPC path is only a rolling-deploy compatibility bridge. Keep its
// worst-case database and hydration work bounded even for highly selective
// public filters. The normal RPC remains responsible for deep catalog reads.
const MARKETPLACE_FALLBACK_MAX_SCANNED_ROWS = 1_009;

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

interface GenerationInputMediaRow {
  id: string;
  generation_id: string;
  user_id: string;
  media_type: 'image' | 'video' | 'audio';
  role: string;
  label: string | null;
  storage_path: string;
  source_generation_id: string | null;
  sort_order: number | null;
  metadata: Record<string, unknown> | null;
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
  created_at: string;
}

interface GenerationRecipePostRow extends LinkedPostRow {
  user_id: string | null;
  prompt: string | null;
}

interface GenerationRecipeRow {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  share_input_media_for_remix: boolean | null;
  model: string | null;
  category: string | null;
  prompt: string | null;
  workflow_settings: Record<string, unknown> | null;
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
  mediaPreviewUrl: string | null;
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

type MarketplaceResourceListPage = {
  items: MarketplaceResourceListItem[];
  pageInfo: {
    hasMore: boolean;
    nextOffset: number | null;
    offset: number;
    limit: number;
  };
};

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
    const response = await fetchWithProviderTimeout(FX_UPSTREAM_URL, {
      headers: {
        Accept: 'application/json',
      },
      next: {
        revalidate: 3600,
      },
    }, EXTERNAL_API_REQUEST_TIMEOUT_MS, fetch, 'FX rates');

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
    if (!hasPlausibleUsdInrRate(rates)) {
      throw new Error('FX upstream USD/INR rate is outside the accepted safety band');
    }

    return rates;
  } catch (error) {
    logBackendError('post_resource_fx_rates_load_failed', { error: error });
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

function normalizeBundleDisplayTitle(value: string | null | undefined): string {
  const title = value?.trim();
  return !title || /^attached unlock$/i.test(title) ? 'Recipe' : title;
}

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const sanitized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || fallback;
}

function inferExtensionFromPath(storagePath: string, mediaType: GenerationInputMediaRow['media_type']): string {
  const candidate = storagePath.split('?')[0]?.split('.').pop()?.toLowerCase();
  if (candidate && /^[a-z0-9]{2,5}$/.test(candidate)) {
    return candidate;
  }

  if (mediaType === 'image') return 'jpg';
  if (mediaType === 'audio') return 'mp3';
  return 'mp4';
}

function inferReferenceContentType(
  storagePath: string,
  mediaType: GenerationInputMediaRow['media_type'],
  blobType: string | null | undefined
): string {
  if (blobType?.trim()) {
    return blobType;
  }

  const extension = inferExtensionFromPath(storagePath, mediaType);
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'mov') return 'video/quicktime';
  if (extension === 'webm') return 'video/webm';
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'ogg') return 'audio/ogg';
  if (extension === 'flac') return 'audio/flac';
  if (extension === 'mp3') return 'audio/mpeg';
  if (mediaType === 'image') return 'image/jpeg';
  if (mediaType === 'audio') return 'audio/mpeg';
  return 'video/mp4';
}

function mapGenerationInputResourceType(row: GenerationInputMediaRow): PostResourceItemType {
  if (row.media_type === 'image') return 'reference_image';
  if (row.media_type === 'audio') return 'reference_audio';
  return 'reference_video';
}

function mapGenerationInputResourceRole(role: string): PostResourceItemRole {
  if (role === 'character_image') return 'character_reference';
  if (role === 'start_frame' || role === 'end_frame') return 'before_input';
  if (role === 'reference_video' || role === 'reference_audio' || role === 'motion_reference_video') {
    return 'supporting_workflow';
  }
  return 'style_reference';
}

function mapGenerationInputRemixUse(row: GenerationInputMediaRow): PostResourceRemixUse {
  return row.media_type === 'image' || row.media_type === 'video' || row.media_type === 'audio'
    ? 'reference_only'
    : 'none';
}

function buildReferenceResourceStoragePath(ownerUserId: string, generationId: string, row: GenerationInputMediaRow): string {
  const sortOrder = Math.max(0, row.sort_order ?? 0).toString().padStart(2, '0');
  const role = sanitizePathSegment(row.role, 'reference');
  const id = sanitizePathSegment(row.id, 'input');
  const extension = inferExtensionFromPath(row.storage_path, row.media_type);
  return `${ownerUserId}/generation-references/${generationId}/${sortOrder}-${role}-${id}.${extension}`;
}

function buildReferenceSummary(count: number): string {
  return count === 1 ? '1 saved reference from this creation' : `${count} saved references from this creation`;
}

function mergeResourceItems(
  existingItems: PostResourceItem[] | undefined,
  referenceItems: PostResourceItem[]
): PostResourceItem[] {
  const merged = [...(existingItems ?? [])];
  const seenStoragePaths = new Set(
    merged
      .map((item) => item.storagePath)
      .filter((value): value is string => Boolean(value))
  );

  for (const referenceItem of referenceItems) {
    if (referenceItem.storagePath && seenStoragePaths.has(referenceItem.storagePath)) {
      continue;
    }

    merged.push({
      ...referenceItem,
      isPrimary: referenceItem.isPrimary && merged.length === 0,
      sortOrder: merged.length,
    });
    if (referenceItem.storagePath) {
      seenStoragePaths.add(referenceItem.storagePath);
    }
  }

  return merged.map((item, index) => ({
    ...item,
    sortOrder: item.sortOrder ?? index,
  }));
}

export function mergeGenerationReferenceItemsIntoBundle(
  bundle: PostResourceBundleInput,
  referenceItems: PostResourceItem[]
): PostResourceBundleInput {
  if (referenceItems.length === 0 || bundle.accessMode === 'none') {
    return bundle;
  }

  const resources = bundle.resources ?? {};
  return {
    ...bundle,
    previewText: normalizeText(bundle.previewText ?? null) ?? `Includes ${buildReferenceSummary(referenceItems.length)}.`,
    resources: {
      ...resources,
      promptText: resources.promptText ?? null,
      notesMarkdown: resources.notesMarkdown ?? null,
      workflowShareUrl: resources.workflowShareUrl ?? null,
      attachments: normalizePostResourceAttachments(resources.attachments),
      allowRemix: Boolean(resources.allowRemix),
      items: mergeResourceItems(normalizePostResourceItems(resources.items, resources), referenceItems),
    },
  };
}

export function buildFreeGenerationReferenceBundle(referenceItems: PostResourceItem[]): PostResourceBundleInput {
  const summary = buildReferenceSummary(referenceItems.length);

  return {
    accessMode: 'free',
    summary,
    previewText: `Open ${summary}.`,
    resources: {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      attachments: [],
      allowRemix: false,
      items: mergeResourceItems([], referenceItems),
    },
  };
}

export async function buildGenerationReferenceResourceItems(params: {
  supabase: SupabaseClient;
  ownerUserId: string;
  generationId: string;
}): Promise<PostResourceItem[]> {
  const { data, error } = await params.supabase
    .from('generation_input_media')
    .select('id, generation_id, user_id, media_type, role, label, storage_path, source_generation_id, sort_order, metadata')
    .eq('generation_id', params.generationId)
    .eq('user_id', params.ownerUserId)
    .order('sort_order', { ascending: true });

  if (error) {
    logBackendError('post_resource_generation_refs_load_failed', { error: error });
    return [];
  }

  const rows = (data ?? []) as GenerationInputMediaRow[];
  const items: PostResourceItem[] = [];

  for (const [index, row] of rows.entries()) {
    const sourceLocation = getStoredMediaLocation(row.storage_path);
    if (!sourceLocation) {
      continue;
    }

    const targetPath = buildReferenceResourceStoragePath(params.ownerUserId, params.generationId, row);

    try {
      const { data: blob, error: downloadError } = await params.supabase.storage
        .from(sourceLocation.bucket)
        .download(sourceLocation.filePath);

      if (downloadError || !blob) {
        logBackendError('post_resource_generation_ref_download_failed', { error: downloadError });
        continue;
      }

      const contentType = inferReferenceContentType(row.storage_path, row.media_type, blob.type);
      const { error: uploadError } = await params.supabase.storage
        .from(POST_RESOURCE_FILES_BUCKET)
        .upload(targetPath, blob, {
          cacheControl: '3600',
          contentType,
          upsert: true,
        });

      if (uploadError) {
        logBackendError('post_resource_generation_ref_copy_failed', { error: uploadError });
        continue;
      }

      items.push({
        id: `reference-${sanitizePathSegment(row.id, String(index + 1))}`,
        scope: { kind: 'all' },
        type: mapGenerationInputResourceType(row),
        role: mapGenerationInputResourceRole(row.role),
        sectionId: null,
        title: normalizeText(row.label) ?? `Reference ${index + 1}`,
        description: null,
        textContent: null,
        externalUrl: null,
        storagePath: targetPath,
        contentType,
        sizeBytes: typeof blob.size === 'number' ? blob.size : null,
        workflowSnapshot: null,
        sortOrder: items.length,
        isPrimary: index === 0,
        remixUse: mapGenerationInputRemixUse(row),
      });
    } catch (copyError) {
      logBackendError('post_resource_generation_ref_package_failed', { error: copyError });
    }
  }

  return items;
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

function normalizeWorkflowSettings(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function isGenerationRecipePostEligible(row: GenerationRecipePostRow): boolean {
  return Boolean(
    row.user_id &&
    row.generation_id &&
    (row.visibility === 'public' || row.visibility === 'unlisted') &&
    row.archived_at === null &&
    row.review_status === 'visible' &&
    normalizeShowcaseSourceKind(row.source_kind) === MAGICBOOKLET_SOURCE_KIND
  );
}

async function loadGenerationRecipePostRow(
  adminSupabase: SupabaseClient,
  postId: string
): Promise<GenerationRecipePostRow | null> {
  const selectWithModernColumns =
    'id, user_id, generation_id, title, body, prompt, category, post_format, visibility, archived_at, review_status, showcase_asset_path, output_url, source_kind, source_tool, source_tool_slug, save_count, remix_count, share_visit_count, created_at';
  const selectLegacyColumns =
    'id, user_id, generation_id, title, prompt, category, visibility, archived_at, showcase_asset_path, output_url, source_kind, source_tool, save_count, remix_count, created_at';
  const loadPost = (selectColumns: string) =>
    adminSupabase
      .from('posts')
      .select(selectColumns)
      .eq('id', postId)
      .maybeSingle();

  let { data, error } = await loadPost(selectWithModernColumns);
  if (isMissingPostTextColumnsError(error) || isMissingSourceToolSlugColumn(error)) {
    ({ data, error } = await loadPost(selectLegacyColumns));
    if (!error && data) {
      const legacyRow = data as unknown as Omit<GenerationRecipePostRow, 'body' | 'post_format' | 'review_status' | 'source_tool_slug' | 'share_visit_count'>;
      return {
        ...legacyRow,
        body: null,
        post_format: normalizeLegacyPostFormat(legacyRow.category),
        review_status: 'visible',
        source_tool_slug: slugifySourceTool(legacyRow.source_tool),
        share_visit_count: 0,
      };
    }
  }

  if (error) {
    if (!isMissingPostsSchemaError(error)) {
      logBackendError('post_resource_recipe_post_load_failed', { error: error });
    }
    return null;
  }

  return (data as GenerationRecipePostRow | null) ?? null;
}

async function loadGenerationRecipeRow(
  adminSupabase: SupabaseClient,
  generationId: string
): Promise<GenerationRecipeRow | null> {
  const { data, error } = await adminSupabase
    .from('generations')
    .select('id, user_id, is_public, share_input_media_for_remix, model, category, prompt, workflow_settings')
    .eq('id', generationId)
    .maybeSingle();

  if (error) {
    logBackendError('post_resource_recipe_source_load_failed', { error: error });
    return null;
  }

  return (data as GenerationRecipeRow | null) ?? null;
}

async function loadEligibleGenerationRecipeInputMedia(params: {
  adminSupabase: SupabaseClient;
  postId: string;
  generationId: string;
  urlMode: 'signed' | 'none';
}): Promise<{ generation: GenerationRecipeRow; inputMedia: GenerationInputMediaItem[] } | null> {
  const { adminSupabase } = params;
  const post = await loadGenerationRecipePostRow(adminSupabase, params.postId);
  if (!post || !isGenerationRecipePostEligible(post) || !post.user_id || post.generation_id !== params.generationId) {
    return null;
  }

  const generation = await loadGenerationRecipeRow(adminSupabase, params.generationId);
  if (!generation) {
    return null;
  }

  // A post must not surface a third party's inputs: the linked generation has
  // to belong to the post creator.
  if (generation.user_id && generation.user_id !== post.user_id) {
    return null;
  }

  const inputMediaMap = await loadGenerationInputMediaMap({
    supabase: adminSupabase,
    generationIds: [params.generationId],
    urlMode: params.urlMode,
  });
  const durableInputMedia = inputMediaMap.get(params.generationId) ?? [];

  if (durableInputMedia.length > 0) {
    return { generation, inputMedia: durableInputMedia };
  }

  const legacyInputMedia = await buildLegacyGenerationInputMedia({
    supabase: adminSupabase,
    generationId: generation.id,
    ownerUserId: post.user_id,
    category: generation.category ?? post.category,
    workflowSettings: normalizeWorkflowSettings(generation.workflow_settings) ?? {},
  });

  return { generation, inputMedia: legacyInputMedia };
}

export async function loadGenerationRecipeRemixInputMediaByPostId(params: {
  postId: string;
  generationId: string;
  viewerUserId: string;
  adminSupabase?: SupabaseClient;
}): Promise<GenerationInputMediaItem[]> {
  const adminSupabase = params.adminSupabase ?? createServiceClient();
  const entitlement = await getPostResourceBundleDetailByPostId(params.postId, {
    viewerUserId: params.viewerUserId,
    adminSupabase,
  });
  if (
    !entitlement
    || !entitlement.viewerCanAccess
    || !entitlement.allowRemix
    || entitlement.post?.generationId !== params.generationId
  ) {
    return [];
  }

  const eligible = await loadEligibleGenerationRecipeInputMedia({
    adminSupabase,
    postId: params.postId,
    generationId: params.generationId,
    urlMode: 'signed',
  });

  return eligible?.inputMedia ?? [];
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
    logBackendError('post_resource_profiles_load_failed', { error: error });
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
  scope: LinkedPostScope = 'public',
  includeMediaPreviews = false,
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
    resultQuery = resultQuery.eq('visibility', 'public').is('archived_at', null).eq('review_status', 'visible');
  }

  let result: LinkedPostQueryResult = await resultQuery;
  if (scope === 'public' && isMissingPostReviewStatusColumnError(result.error)) {
    logBackendError('marketplace_moderation_boundary_unenforceable', { error: result.error });
    return new Map();
  }
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
        fallbackQuery = fallbackQuery.eq('review_status', 'visible');
      }
    }

    result = await fallbackQuery;
    if (scope === 'public' && isMissingPostReviewStatusColumnError(result.error)) {
      logBackendError('marketplace_moderation_boundary_unenforceable', { error: result.error });
      return new Map();
    }
  }

  let rows: LinkedPostRow[] = [];

  if (isMissingPostTextColumnsError(result.error)) {
    let legacyQuery = adminSupabase
      .from('posts')
      .select('id, generation_id, title, category, visibility, archived_at, review_status, showcase_asset_path, output_url, source_kind, source_tool, source_tool_slug, save_count, remix_count, share_visit_count')
      .in('id', uniquePostIds);

    if (scope === 'public') {
      legacyQuery = legacyQuery.eq('visibility', 'public').is('archived_at', null).eq('review_status', 'visible');
    }

    let legacyResult: LinkedPostQueryResult = await legacyQuery;
    if (scope === 'public' && isMissingPostReviewStatusColumnError(legacyResult.error)) {
      logBackendError('marketplace_moderation_boundary_unenforceable', { error: legacyResult.error });
      return new Map();
    }
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
          fallbackLegacyQuery = fallbackLegacyQuery.eq('review_status', 'visible');
        }
      }

      legacyResult = await fallbackLegacyQuery;
      if (scope === 'public' && isMissingPostReviewStatusColumnError(legacyResult.error)) {
        logBackendError('marketplace_moderation_boundary_unenforceable', { error: legacyResult.error });
        return new Map();
      }
    }

    if (legacyResult.error) {
      if (!isMissingPostsSchemaError(legacyResult.error)) {
        logBackendError('post_resource_linked_posts_load_failed', { error: legacyResult.error });
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
      logBackendError('post_resource_linked_posts_load_failed', { error: result.error });
    }
    return new Map();
  } else {
    rows = (result.data ?? []) as LinkedPostRow[];
  }

  const mediaItemsMap = includeMediaPreviews
    ? await loadPostMediaItemsMap(adminSupabase, rows.map((row) => row.id)).catch((error) => {
        logBackendError('marketplace_media_previews_load_failed', { error: error });
        return new Map();
      })
    : new Map();

  const linkedPosts = await Promise.all(
    rows.map(async (row) => {
      const coverMedia = mediaItemsMap.get(row.id)?.[0] ?? null;
      const mediaUrl = coverMedia?.url ?? await resolvePostMediaUrl(adminSupabase, row);

      return {
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
        mediaUrl,
        mediaPreviewUrl: coverMedia?.previewUrl ?? null,
        mediaKind: coverMedia?.mediaKind ?? getPostMediaKind(row.category, row.post_format),
        saveCount: row.save_count ?? 0,
        remixCount: row.remix_count ?? 0,
        shareVisitCount: row.share_visit_count ?? 0,
      };
    })
  );

  return new Map(linkedPosts.map((row) => [row.id, row]));
}

async function hydrateBundleRows(
  rows: BundleRow[],
  countryCode?: string | null,
  scope: LinkedPostScope = 'public',
  includeMediaPreviews = false,
): Promise<MarketplaceResourceListItem[]> {
  const [profilesMap, postMap] = await Promise.all([
    loadProfileMap(rows.map((row) => row.owner_user_id)),
    loadLinkedPostMap(rows.map((row) => row.post_id), scope, includeMediaPreviews),
  ]);

  return Promise.all(
    rows.map(async (row) => {
      const normalizedResources = normalizeResources(row);
      const fullLockedPreview = buildPostResourceBundleLockedPreview(normalizedResources, row.updated_at);
      const lockedPreview = scope === 'owner'
        ? fullLockedPreview
        : sanitizePostResourceBundleLockedPreview(fullLockedPreview) ?? fullLockedPreview;
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
        title: normalizeBundleDisplayTitle(row.title),
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
      ? Math.max(POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS, Number.isFinite(bundle?.priceUsdCents) ? Math.round(bundle?.priceUsdCents ?? 0) : 0)
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

  const { data: profile, error } = await params.supabase
    .from('profiles')
    .select('username, display_name, avatar_url')
    .eq('id', params.ownerUserId)
    .maybeSingle();

  if (error) {
    logBackendError('marketplace_quality_gate_profile_load_failed', { error: error });
    return CREATOR_PROFILE_CHECK_ERROR;
  }

  const seller = {
    username: typeof profile?.username === 'string' ? profile.username : null,
    displayName: typeof profile?.display_name === 'string' ? profile.display_name : null,
    avatarUrl: typeof profile?.avatar_url === 'string' ? profile.avatar_url : null,
  };
  const profileReadinessError = getCreatorPublishReadinessError(seller, {
    requiresAvatar: accessMode !== 'none',
  });
  if (profileReadinessError) {
    return profileReadinessError;
  }

  const postHasMedia = Boolean(
    params.post.hasMedia ||
    params.post.mediaUrl ||
    params.post.showcaseAssetPath ||
    params.post.outputUrl
  );
  if (accessMode === 'none') {
    return getPublicPostQualityError({
      title: params.post.title,
      body: params.post.body,
      hasMedia: postHasMedia,
    });
  }

  return getMarketplaceQualityError({
    title: params.post.title ?? 'Recipe',
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
    seller,
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
  return (
    Boolean(viewerUserId && viewerUserId === row.owner_user_id) ||
    viewerHasPurchased ||
    (row.status === 'published' && isGenerationRecipeAssetId(row.id))
  );
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
  const normalizedTitle = normalizeText(postTitle) ?? 'Recipe';
  const priceUsdCents = accessMode === 'free'
    ? 0
    : Math.max(POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS, Number.isFinite(bundle?.priceUsdCents) ? Math.round(bundle?.priceUsdCents ?? 0) : 0);

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

    return query.order('id', { ascending: false });
  };

  const matchingItems: MarketplaceResourceListItem[] = [];
  const targetMatchCount = offset + limit + 1;
  const batchSize = Math.min(
    MARKETPLACE_FALLBACK_MAX_BATCH_SIZE,
    Math.max(MARKETPLACE_FALLBACK_MIN_BATCH_SIZE, limit * 2),
  );
  let scanOffset = 0;
  let exhausted = false;
  let selectColumns = BUNDLE_ROW_SELECT;

  while (
    !exhausted
    && matchingItems.length < targetMatchCount
    && scanOffset < MARKETPLACE_FALLBACK_MAX_SCANNED_ROWS
  ) {
    const rangeEnd = Math.min(
      scanOffset + batchSize,
      MARKETPLACE_FALLBACK_MAX_SCANNED_ROWS,
    ) - 1;
    let { data, error } = await buildQuery(selectColumns)
      .range(scanOffset, rangeEnd);

    if (selectColumns === BUNDLE_ROW_SELECT && isMissingPostResourceItemsColumnError(error)) {
      selectColumns = BUNDLE_ROW_SELECT_LEGACY;
      ({ data, error } = await buildQuery(selectColumns)
        .range(scanOffset, rangeEnd));
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

      logBackendError('marketplace_resource_list_load_failed', { error: error });
      throw error;
    }

    const rows = (data ?? []) as unknown as BundleRow[];
    exhausted = rows.length < rangeEnd - scanOffset + 1;
    scanOffset += rows.length;

    if (rows.length === 0) {
      break;
    }

    const hydratedItems = await hydrateBundleRows(rows, countryCode, 'public', true);
    matchingItems.push(...hydratedItems.filter((item) => {
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
    }));
  }

  const pageItems = matchingItems.slice(offset, offset + limit);
  const hasMore = matchingItems.length > offset + limit;

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

type MarketplaceResourceListOptions = {
  filter?: MarketplaceResourceFilter;
  resource?: MarketplaceResourceKindFilter;
  tool?: string | null;
  q?: string | null;
  sort?: MarketplaceResourceSort;
  offset?: number;
  limit?: number;
  countryCode?: string | null;
};

type MarketplaceResourceListBaseOptions = {
  filter: MarketplaceResourceFilter;
  resource: MarketplaceResourceKindFilter;
  tool: string | null;
  q: string | null;
  sort: MarketplaceResourceSort;
  offset: number;
  limit: number;
};

async function getMarketplaceResourceListBase(
  options: MarketplaceResourceListBaseOptions,
): Promise<MarketplaceResourceListPage> {
  const {
    filter,
    resource,
    tool,
    q,
    sort,
    offset,
    limit,
  } = options;
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
        countryCode: null,
      });
    }

    logBackendError('marketplace_resource_list_load_failed', { error: error });
    throw error;
  }

  const rows = ((data ?? []) as BundleRow[]).slice(0, limit + 1);
  const hasMore = rows.length > limit;
  const hydratedItems = await hydrateBundleRows(rows, null, 'public', true);
  const pageItems: MarketplaceResourceListItem[] = [];
  let consumedRowCount = 0;

  for (const item of hydratedItems) {
    if (!item.post) {
      consumedRowCount += 1;
      continue;
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

    const isEligible = quality.eligible
      && (!normalizedQuery || marketplaceItemMatchesQuery(item, normalizedQuery));
    if (isEligible && pageItems.length >= limit) {
      // This is an eligible lookahead row that has not been returned. Leave
      // its raw position for the next page instead of skipping it.
      break;
    }

    consumedRowCount += 1;
    if (isEligible) {
      pageItems.push(item);
    }
  }

  return {
    items: pageItems,
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + consumedRowCount : null,
      offset,
      limit,
    },
  };
}

const getCachedMarketplaceResourceListBase = unstable_cache(
  async (
    filter: MarketplaceResourceFilter,
    resource: MarketplaceResourceKindFilter,
    sort: MarketplaceResourceSort,
    limit: number,
  ) => getMarketplaceResourceListBase({
    filter,
    resource,
    tool: null,
    q: null,
    sort,
    offset: 0,
    limit,
  }),
  ['marketplace-resource-list-base-v3'],
  {
    revalidate: 60,
    tags: [MARKETPLACE_RESOURCE_LIST_CACHE_TAG, SHOWCASE_FEED_CACHE_TAG],
  },
);

function isMissingIncrementalCacheError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('incrementalCache missing');
}

async function loadCachedMarketplaceResourceListBase(
  filter: MarketplaceResourceFilter,
  resource: MarketplaceResourceKindFilter,
  sort: MarketplaceResourceSort,
  limit: number,
) {
  try {
    return await getCachedMarketplaceResourceListBase(filter, resource, sort, limit);
  } catch (error) {
    if (isMissingIncrementalCacheError(error)) {
      return getMarketplaceResourceListBase({
        filter,
        resource,
        tool: null,
        q: null,
        sort,
        offset: 0,
        limit,
      });
    }

    throw error;
  }
}

async function localizeMarketplaceResourceListPage(
  page: MarketplaceResourceListPage,
  countryCode: string | null,
): Promise<MarketplaceResourceListPage> {
  if (countryCode?.toUpperCase() !== 'IN') {
    return page;
  }

  return {
    ...page,
    items: await Promise.all(page.items.map(async (item) => ({
      ...item,
      priceQuote: await buildPriceQuote(item.priceUsdCents, countryCode),
    }))),
  };
}

export async function getMarketplaceResourceList(
  options?: MarketplaceResourceListOptions,
): Promise<MarketplaceResourceListPage> {
  const {
    filter = 'all',
    resource = 'all',
    tool = null,
    q = null,
    sort = 'recent',
    offset = 0,
    limit = MARKETPLACE_DEFAULT_PAGE_SIZE,
    countryCode = null,
  } = options ?? {};
  const normalizedToolFilter = tool ? slugifySourceTool(tool) : '';
  const normalizedQuery = normalizeMarketplaceSearchQuery(q);

  const page = shouldCacheMarketplaceResourceListBasePage({
    offset,
    limit,
    tool: normalizedToolFilter,
    query: normalizedQuery,
  })
    ? await loadCachedMarketplaceResourceListBase(filter, resource, sort, limit)
    : await getMarketplaceResourceListBase({
      filter,
      resource,
      tool: normalizedToolFilter || null,
      q: normalizedQuery || null,
      sort,
      offset,
      limit,
    });

  return localizeMarketplaceResourceListPage(page, countryCode);
}

export async function getPostResourceBundleDetailByPostId(
  postId: string,
  options?: {
    viewerUserId?: string | null;
    countryCode?: string | null;
    adminSupabase?: SupabaseClient;
  }
): Promise<PostResourceBundleDetail | null> {
  const {
    viewerUserId = null,
    countryCode = null,
    adminSupabase = createServiceClient(),
  } = options ?? {};
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

    logBackendError('post_resource_bundle_load_failed', { error: error });
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
      logBackendError('post_resource_purchase_state_load_failed', { error: purchaseError });
    } else {
      viewerHasPurchased = Boolean(purchaseData);
    }
  }

  const viewerIsOwner = Boolean(viewerUserId && viewerUserId === row.owner_user_id);
  const viewerCanAccess = canViewerAccessBundle(row, viewerUserId, viewerHasPurchased);
  const [hydrated] = await hydrateBundleRows([row], countryCode, viewerIsOwner ? 'owner' : 'public');
  if (!viewerIsOwner && !hydrated.post) {
    return null;
  }
  const normalizedResources = normalizeResources(row);

  // Bundles do not persist the creation's reference media as items; the saved
  // references live in generation_input_media and are surfaced here at read
  // time, as the recipe layer did before it was folded into stored bundles.
  // The gate is entitlement (viewerCanAccess covers owner, free unlock, and
  // paid purchase) plus the creator's remix opt-in on the bundle; for
  // non-owners the generation must also still be public, which is how a
  // moderation take-down retracts it. share_input_media_for_remix is
  // deliberately not consulted here — it governs restoring these files into a
  // viewer's own remix (/api/remix-source), not seeing them inside an unlock
  // they are entitled to. Failing to load references must degrade to the
  // bundle without them, never take the whole unlock down.
  if (viewerCanAccess && row.allow_remix && hydrated.post?.generationId) {
    try {
      const eligible = await loadEligibleGenerationRecipeInputMedia({
        adminSupabase,
        postId,
        generationId: hydrated.post.generationId,
        urlMode: 'none',
      });
      const generation = eligible?.generation ?? null;
      const canViewReferences = Boolean(
        generation && (viewerIsOwner || generation.is_public === true),
      );
      if (eligible && canViewReferences && eligible.inputMedia.length > 0) {
        const referenceItems = buildGenerationRecipeResourceItems({
          promptText: null,
          notesMarkdown: null,
          allowRemix: false,
          inputMedia: eligible.inputMedia,
        });
        normalizedResources.items = mergeResourceItems(
          normalizedResources.items ?? [],
          referenceItems,
        );
      }
    } catch (error) {
      logBackendError('post_resource_recipe_reference_load_failed', { error: error });
    }
  }
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

    logBackendError('post_resource_seller_bundles_load_failed', { error: error });
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
      logBackendError('post_resource_seller_sales_load_failed', { error: orderError });
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
        bundleTitle: bundleIdToTitle.get(row.bundle_id) ?? 'Recipe',
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
    logBackendError('post_resource_deleted_snapshots_load_failed', { error: deletedAuditError });
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

const RESOURCE_IDENTIFIER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolvePostIdForResourceIdentifier(identifier: string): Promise<string | null> {
  // Both bundle ids and legacy marketplace asset ids are uuid columns. The
  // identifier arrives raw from an unauthenticated route path segment and
  // postgrest-js does not escape `.or()` filter values, so anything that is
  // not a plain UUID is rejected before it can reach the filter expression.
  const normalizedIdentifier = typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
  if (!RESOURCE_IDENTIFIER_UUID_PATTERN.test(normalizedIdentifier)) {
    return null;
  }

  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('post_id, legacy_asset_id')
    .or(`id.eq.${normalizedIdentifier},legacy_asset_id.eq.${normalizedIdentifier}`)
    .maybeSingle();

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      const { data: legacyAsset, error: legacyError } = await adminSupabase
        .from('marketplace_assets')
        .select('post_id')
        .eq('id', normalizedIdentifier)
        .maybeSingle();

      if (legacyError) {
        if (!isMissingMarketplaceSchemaError(legacyError)) {
          logBackendError('marketplace_legacy_post_id_resolve_failed', { error: legacyError });
        }
        return null;
      }

      return (legacyAsset?.post_id as string | null) ?? null;
    }

    logBackendError('post_resource_bundle_post_id_resolve_failed', { error: error });
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

    logBackendError('post_resource_bundle_by_post_load_failed', { error: error });
    throw error;
  }

  return (data as BundleRow | null) ?? null;
}
