import { loadNsfwPostIds, hasNsfwReveal } from '@/lib/nsfw-content-server';
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
  isMissingPostResourceRetirementColumnError,
  isMissingPostTombstoneColumnError,
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
import { throwSupabaseMutationFailure } from '@/lib/upload-byte-admission';
import {
  addPostResourceItemCountsToLockedPreview,
  buildPostResourceBundleLockedPreview,
  getPostResourceItemCounts,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  resolvePostRemixCapability,
  resolveRecipeAllowRemix,
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
  type MarketplaceQualityInput,
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
  PostResourceItemCounts,
  PostResourceItemRole,
  PostResourceItemType,
  PostResourceRemixUse,
  PostResourceKind,
} from '@/lib/post-resource-bundles';
import { buildGenerationRecipeResourceItems } from '@/lib/generation-paywall';
import {
  buildLegacyGenerationInputMedia,
  GENERATION_INPUT_MEDIA_COLUMNS,
  loadGenerationInputMediaMap,
  mapGenerationInputMediaRowsWithoutUrls,
  type GenerationInputMediaItem,
  type GenerationInputMediaRow,
} from '@/lib/generation-input-media';
import { slugifySourceTool } from '@/lib/source-tools';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';
import { isOwnOrLinkedAccountId, readLinkedAccountIds, resolveLinkedAccountIds } from '@/lib/account-identity';
import { generationInputOrigin, loadSourceGenerationOwners, needsSourceGenerationOwner, type GenerationInputOrigin } from '@/lib/generation-input-origin';
import { loadPostMediaItemsMap, type PostMediaPersistInput } from '@/lib/post-media';
import { loadPurchasedProofMedia } from '@/lib/purchased-proof-media';
import {
  MARKETPLACE_DEFAULT_PAGE_SIZE,
  shouldCacheMarketplaceResourceListBasePage,
} from '@/lib/marketplace-resource-list-cache-policy';
import { MARKETPLACE_RESOURCE_LIST_CACHE_TAG } from '@/lib/marketplace-resource-list-cache';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';
import {
  MAGICBOOKLET_SOURCE_KIND,
  normalizeShowcaseSourceKind,
  type RawShowcaseSourceKind,
  type ShowcaseItemCategory,
  type ShowcaseMediaKind,
  type ShowcaseMediaItem,
  type ShowcasePostFormat,
  type ShowcaseSourceKind,
  type ShowcaseVisibility,
} from '@/lib/showcase';
import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

/**
 * 'public'  — anyone: the post must be public, unarchived and moderation-clean.
 * 'entitled'— a buyer reading an unlock they paid for. Private, archived and
 *             tombstoned posts resolve, because a creator delisting or deleting
 *             their post must not retract what someone bought. Moderation state
 *             is still enforced: a hidden post stops resolving for everyone.
 * 'owner'   — the creator: no filtering at all.
 */
type LinkedPostScope = 'public' | 'entitled' | 'owner';

const BUNDLE_ROW_SELECT =
  'id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, resource_sections, resource_items, price_usd_cents, sales_count, free_unlock_count, earnings_usd_cents, retired_at, created_at, updated_at';
// Same projection minus `retired_at`, for a database that predates the
// bundle-revisions migration. Without it, one unknown column 500s every bundle
// read instead of degrading to a bundle that simply is not retired.
const BUNDLE_ROW_SELECT_WITHOUT_RETIREMENT = BUNDLE_ROW_SELECT.replace(', retired_at', '');
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
  /** Paid unlocks only, since 2026-10-17. */
  sales_count: number;
  /** Absent from the pre-resource-items projection. */
  free_unlock_count?: number;
  earnings_usd_cents: number;
  retired_at?: string | null;
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
  tombstoned_at?: string | null;
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

/** What the gates on a creation's saved inputs read of its post. */
type GenerationRecipeGatePostRow = Pick<
  GenerationRecipePostRow,
  'user_id' | 'generation_id' | 'visibility' | 'archived_at' | 'review_status' | 'source_kind'
>;

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
  /** The owner deleted this post; only entitled buyers can still resolve it. */
  tombstoned: boolean;
  reviewStatus: 'visible' | 'flagged' | 'hidden';
  sourceKind: ShowcaseSourceKind;
  sourceTool: string | null;
  sourceToolSlug: string | null;
  mediaUrl: string | null;
  mediaPreviewUrl: string | null;
  mediaRenditionUrl: string | null;
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
  /** Paid unlocks. A free unlock is not a sale (decision 6, 2026-10-17). */
  salesCount: number;
  /** Free unlocks: what a free recipe's "N opened" counts. */
  freeUnlockCount: number;
  /**
   * Owner-scope only. Public marketplace responses are edge-cached and
   * unauthenticated, so a creator's revenue must never ride along with them;
   * `salesCount` and `freeUnlockCount` stay public as social proof.
   */
  earningsUsdCents?: number;
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

/**
 * The exact state of a bundle at the moment a buyer paid for it. Present only
 * when the current bundle has since been edited, so the UI can offer "the
 * version you unlocked" without cluttering the common case where nothing
 * changed.
 */
export interface PurchasedPostResourceBundleRevision {
  revisionNumber: number;
  purchasedAt: string;
  title: string;
  summary: string;
  previewText: string;
  accessMode: PersistedPostResourceBundleAccessMode;
  priceUsdCents: number;
  resources: PostResourceBundleResources;
  mediaItems: ShowcaseMediaItem[];
}

export interface PostResourceBundleDetail extends MarketplaceResourceListItem {
  status: PostResourceBundleStatus;
  resources: PostResourceBundleResources | null;
  viewerIsOwner: boolean;
  viewerHasPurchased: boolean;
  viewerCanAccess: boolean;
  /** Set when the bundle changed after this viewer bought it. */
  purchasedRevision: PurchasedPostResourceBundleRevision | null;
  /** The creator removed the unlock after it had buyers; it can no longer be sold. */
  retiredAt: string | null;
  /** The creator deleted the post; buyers keep access, the public does not. */
  tombstoned: boolean;
}

interface SellerResourceDashboardBundle extends MarketplaceResourceListItem {
  status: PostResourceBundleStatus;
  post: PostResourceBundleLinkedPost | null;
  quality: MarketplaceQualityAssessment;
  // Hydrated at 'owner' scope, so the seller always sees their own earnings.
  earningsUsdCents: number;
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
    buyerLabel: string;
    amountSubunits: number;
    currency: MarketplaceCheckoutCurrency;
    createdAt: string;
  }>;
  /** Paid unlocks across the seller's listings. */
  totalSalesCount: number;
  totalFreeUnlockCount: number;
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

/**
 * Whose each of a creation's saved inputs is (`generationInputOrigin`), by its row's id: the
 * publisher's own, or another account's, as a remix's references from its original are. With
 * no rows kept, the inputs its settings name are read the legacy way, so a creation from
 * before rows were kept still counts its own. A read that fails counts nothing as the
 * original's: the inputs stay with the creator.
 */
export type GenerationInputOrigins = {
  /** Each stored input's origin, by its `generation_input_media` id. */
  byRowId: Map<string, GenerationInputOrigin>;
  /** Some input is the creator's own: a recipe that leaves them out hands none to a remix. */
  hasOwn: boolean;
};

export async function loadGenerationInputOrigins(params: {
  supabase: SupabaseClient;
  ownerUserId: string;
  generationId: string;
}): Promise<GenerationInputOrigins> {
  // Unknown, so every input is the creator's: none is shared, and none is handed to a remix.
  const unknown: GenerationInputOrigins = { byRowId: new Map(), hasOwn: true };
  // Read alongside the rows: it depends only on the creator. It never rejects.
  const linkedAccountIdsRead = readLinkedAccountIds(params.supabase, params.ownerUserId);
  const { data, error } = await params.supabase
    .from('generation_input_media')
    .select('id, metadata, storage_path, source_generation_id')
    .eq('generation_id', params.generationId);
  if (error) {
    logBackendError('post_resource_generation_input_origins_load_failed', { error });
    return unknown;
  }
  let inputs: Array<{ id: string; metadata: Record<string, unknown> | null; storagePath: string | null; sourceGenerationId: string | null }> =
    ((data ?? []) as Array<Pick<GenerationInputMediaRow, 'id' | 'metadata' | 'storage_path' | 'source_generation_id'>>).map((row) => ({
      id: row.id,
      metadata: row.metadata,
      storagePath: row.storage_path,
      sourceGenerationId: row.source_generation_id,
    }));
  if (inputs.length === 0) {
    const { data: generation, error: generationError } = await params.supabase
      .from('generations')
      .select('id, user_id, category, workflow_settings')
      .eq('id', params.generationId)
      .maybeSingle();
    if (generationError) {
      logBackendError('post_resource_generation_input_origins_load_failed', { error: generationError });
      return unknown;
    }
    const row = generation as { id: string; user_id: string | null; category: string | null; workflow_settings: unknown } | null;
    if (row) {
      const legacy = await buildLegacyGenerationInputMedia({
        supabase: params.supabase,
        generationId: row.id,
        ownerUserId: row.user_id ?? params.ownerUserId,
        category: row.category,
        workflowSettings: normalizeWorkflowSettings(row.workflow_settings) ?? {},
        urlMode: 'none',
      });
      inputs = legacy.map((item) => ({ id: item.id, metadata: item.metadata, storagePath: item.storagePath, sourceGenerationId: item.sourceGenerationId }));
    }
  }
  const [ownerIds, sourceGenerationOwners] = await Promise.all([
    linkedAccountIdsRead,
    loadSourceGenerationOwners(params.supabase, inputs.filter(needsSourceGenerationOwner).map((input) => input.sourceGenerationId)),
  ]);
  if (!ownerIds) {
    // A guest's uploads sit in the guest's folder: unread, who is linked to the creator could
    // make them read as another's, shared with the recipe.
    logBackendError('post_resource_generation_input_origins_linked_accounts_failed');
    return unknown;
  }
  const context = { ownerIds: new Set(ownerIds), sourceGenerationOwners };
  const byRowId = new Map(inputs.map((input) => [input.id, generationInputOrigin(input, context)] as const));
  return { byRowId, hasOwn: [...byRowId.values()].includes('own') };
}

/**
 * The id a recipe stores its copy of a saved input under, which is also how a
 * read knows that input is already in the recipe (S-F8).
 */
function generationReferenceItemId(inputId: string, index: number): string {
  return `reference-${sanitizePathSegment(inputId, String(index + 1))}`;
}

/**
 * Copies a creation's saved references into the publisher's resource files.
 *
 * The copies are written under the publisher (`ownerUserId`); each reference is
 * read under its own row's owner, which must be the publisher or a guest linked
 * to it. A creation made as a guest before registering is published as the
 * account (02-4), but its references keep the guest's id and sit in the guest's
 * folder, so read under the publisher alone it packaged none of them.
 *
 * `onlyRowIds` keeps the copies to those rows: a recipe that leaves the creator's
 * own uploads out shares only the references a remix brought from its original.
 */
export async function buildGenerationReferenceResourceItems(params: {
  supabase: SupabaseClient;
  ownerUserId: string;
  generationId: string;
  onlyRowIds?: ReadonlySet<string>;
}): Promise<PostResourceItem[]> {
  const { data, error } = await params.supabase
    .from('generation_input_media')
    .select(GENERATION_INPUT_MEDIA_COLUMNS)
    .eq('generation_id', params.generationId)
    .order('sort_order', { ascending: true });

  if (error) {
    logBackendError('post_resource_generation_refs_load_failed', { error: error });
    return [];
  }

  const rows = ((data ?? []) as GenerationInputMediaRow[])
    .filter((row) => !params.onlyRowIds || params.onlyRowIds.has(row.id));
  const items: PostResourceItem[] = [];
  // The linked guests are asked for only when a row is not the publisher's own.
  const sourceOwnerIds = rows.some((row) => row.user_id !== params.ownerUserId)
    ? await resolveLinkedAccountIds(params.supabase, params.ownerUserId)
    : [params.ownerUserId];

  for (const [index, row] of rows.entries()) {
    const sourceLocation = sourceOwnerIds.includes(row.user_id)
      ? getUserOwnedStoredMediaLocation(row.storage_path, row.user_id)
      : null;
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
        id: generationReferenceItemId(row.id, index),
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

/**
 * `entitled` relaxes the public-surface checks for someone who already bought
 * the unlock, so a tombstoned post keeps serving them the reference media they
 * paid for. Moderation state is never relaxed: a hidden post retracts for
 * everyone. Callers that restore files into a viewer's own remix must leave
 * this false -- entitlement to read is not entitlement to reuse.
 */
function isGenerationRecipePostEligible(
  row: GenerationRecipeGatePostRow,
  options: { entitled?: boolean } = {},
): boolean {
  const publicSurfaceOk = options.entitled
    ? true
    : (row.visibility === 'public' || row.visibility === 'unlisted') && row.archived_at === null;

  return Boolean(
    row.user_id &&
    row.generation_id &&
    publicSurfaceOk &&
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

/**
 * The first gate on a creation's saved inputs going out with its post's
 * recipe: the post is a public creation of its creator's (see above), linked
 * to that generation.
 */
function isGenerationRecipeInputPost(
  post: GenerationRecipeGatePostRow,
  generationId: string,
  options: { entitled?: boolean } = {},
): boolean {
  return isGenerationRecipePostEligible(post, options)
    && Boolean(post.user_id)
    && post.generation_id === generationId;
}

/**
 * The second: a post must not surface a third party's inputs, so the linked
 * generation has to belong to the post creator: made under their own id, or as
 * a guest since linked to them (publish files that creation under the account,
 * while the generation keeps the guest's id). A lookup that fails reads as not
 * linked, which withholds the inputs.
 */
async function isGenerationRecipeInputGeneration(
  adminSupabase: SupabaseClient,
  post: Pick<GenerationRecipePostRow, 'user_id'>,
  generation: Pick<GenerationRecipeRow, 'user_id'>,
): Promise<boolean> {
  return !generation.user_id
    || Boolean(post.user_id && await isOwnOrLinkedAccountId(adminSupabase, post.user_id, generation.user_id));
}

/**
 * The third, which depends on who reads: whether the generation's live inputs
 * are shown. is_public stays the gate for a live post: a creator who
 * deliberately un-publishes a generation retracts its live references, buyers
 * included. Tombstoning is different -- it flips is_public=false as a side
 * effect of deleting the post, so keying off the flag alone would strip
 * references out from under buyers at exactly the moment we promised to
 * retain them. Moderation still retracts everything, because a hidden post
 * stops resolving before any of this is read.
 */
function canViewGenerationRecipeInputs(
  generation: Pick<GenerationRecipeRow, 'is_public'>,
  viewer: { isOwner: boolean; boughtTombstonedPost: boolean },
): boolean {
  return viewer.isOwner || generation.is_public === true || viewer.boughtTombstonedPost;
}

/**
 * The three gates, in one place for every reader: the recipe's panel
 * (`resolveGenerationRecipeInputs`) and the remix's loader
 * (`loadEligibleGenerationRecipeInputMedia`) both ask here, so a remix never
 * hands over a creation's inputs the panel withholds. The remix is the
 * stricter of the two: it never reads through a tombstone.
 */
async function passesGenerationRecipeInputGates(
  adminSupabase: SupabaseClient,
  post: GenerationRecipeGatePostRow,
  generation: Pick<GenerationRecipeRow, 'id' | 'user_id' | 'is_public'>,
  reader: GenerationRecipeInputReader,
): Promise<boolean> {
  // A reader who bought a since-deleted post keeps reading through its
  // tombstone; everyone else needs the post on a public surface.
  return isGenerationRecipeInputPost(post, generation.id, { entitled: reader.boughtTombstonedPost })
    && canViewGenerationRecipeInputs(generation, reader)
    // Awaited: a pending answer is truthy, and would let any account's
    // generation through.
    && await isGenerationRecipeInputGeneration(adminSupabase, post, generation);
}

/**
 * The generation's saved inputs, or for a generation made before inputs were
 * saved, the ones its settings name, signed from the folder of whoever made
 * it: a guest's creation keeps its files under the guest's id.
 */
async function resolveGenerationRecipeInputMedia(params: {
  adminSupabase: SupabaseClient;
  post: Pick<GenerationRecipePostRow, 'user_id' | 'category'>;
  generation: Pick<GenerationRecipeRow, 'id' | 'user_id' | 'category' | 'workflow_settings'>;
  durableInputMedia: GenerationInputMediaItem[];
  urlMode: 'signed' | 'none';
}): Promise<GenerationInputMediaItem[]> {
  if (params.durableInputMedia.length > 0) {
    return params.durableInputMedia;
  }

  return buildLegacyGenerationInputMedia({
    supabase: params.adminSupabase,
    generationId: params.generation.id,
    ownerUserId: params.generation.user_id ?? params.post.user_id,
    category: params.generation.category ?? params.post.category,
    workflowSettings: normalizeWorkflowSettings(params.generation.workflow_settings) ?? {},
    urlMode: params.urlMode,
  });
}

/**
 * A recipe's stored items followed by the creation's saved inputs it does not
 * already hold, which is how an unlock reads it: an input needs a file of its
 * own, and one the recipe stores is listed once.
 */
function addGenerationRecipeReferenceItems(
  storedItems: PostResourceItem[],
  inputMedia: GenerationInputMediaItem[],
): PostResourceItem[] {
  // "Include creation references" already stored a copy of an input as
  // `reference-<input id>` (buildGenerationReferenceResourceItems); listing
  // the live input beside it showed every reference twice (S-F8).
  const storedItemIds = new Set(storedItems.map((item) => item.id));
  const unstoredInputMedia = inputMedia.filter((input, index) => (
    !storedItemIds.has(generationReferenceItemId(input.id, index))
  ));
  if (unstoredInputMedia.length === 0) {
    return storedItems;
  }

  return mergeResourceItems(storedItems, buildGenerationRecipeResourceItems({
    promptText: null,
    notesMarkdown: null,
    allowRemix: false,
    inputMedia: unstoredInputMedia,
  }));
}

async function loadEligibleGenerationRecipeInputMedia(params: {
  adminSupabase: SupabaseClient;
  postId: string;
  generationId: string;
  urlMode: 'signed' | 'none';
  /** Whether the reader owns the recipe, which shows them their own creation's inputs whatever its state. */
  viewerIsOwner: boolean;
  /**
   * Rethrow a failed read of the kept inputs. Taken for "nothing kept", it
   * hands over the uploads the run's settings name, file names and all.
   */
  throwOnError?: boolean;
}): Promise<{ generation: GenerationRecipeRow; inputMedia: GenerationInputMediaItem[] } | null> {
  const { adminSupabase } = params;
  const post = await loadGenerationRecipePostRow(adminSupabase, params.postId);
  const generation = post ? await loadGenerationRecipeRow(adminSupabase, params.generationId) : null;
  if (
    !post
    || !generation
    // A remix restores files into the reader's own work, so it never reads
    // through a tombstone: entitlement to read is not entitlement to reuse.
    || !(await passesGenerationRecipeInputGates(adminSupabase, post, generation, {
      isOwner: params.viewerIsOwner,
      boughtTombstonedPost: false,
    }))
  ) {
    return null;
  }

  const inputMediaMap = await loadGenerationInputMediaMap({
    supabase: adminSupabase,
    generationIds: [params.generationId],
    urlMode: params.urlMode,
    throwOnError: params.throwOnError,
  });

  return {
    generation,
    inputMedia: await resolveGenerationRecipeInputMedia({
      adminSupabase,
      post,
      generation,
      durableInputMedia: inputMediaMap.get(params.generationId) ?? [],
      urlMode: params.urlMode,
    }),
  };
}

// A recipe's post, the post's generation and that generation's saved inputs,
// embedded under the recipe: one request for a page of recipes, where
// loadEligibleGenerationRecipeInputMedia reads one post's in three.
const GENERATION_RECIPE_INPUT_POST_EMBED =
  'post:posts!post_resource_bundles_post_id_fkey(id, user_id, generation_id, category, visibility, archived_at, review_status, source_kind, '
  + 'generation:generations!posts_generation_id_fkey(id, user_id, is_public, category, workflow_settings, '
  + `inputs:generation_input_media!generation_input_media_generation_id_fkey(${GENERATION_INPUT_MEDIA_COLUMNS})))`;

// What merging the inputs into a recipe keys on (normalizeStoredReferenceKeyItems),
// read for a page that does not hold its recipes' rows.
const GENERATION_RECIPE_STORED_KEY_COLUMNS = 'attachments, resource_items';

// A count only adds to a teaser, so a slow read (a retried 503, a busy
// database) is given up on rather than waited for by the page or the recipe.
const RECIPE_REFERENCE_COUNT_TIMEOUT_MS = 1000;

type GenerationRecipeInputPostRow = GenerationRecipeGatePostRow & Pick<GenerationRecipePostRow, 'id' | 'category'> & {
  generation: (Pick<GenerationRecipeRow, 'id' | 'user_id' | 'is_public' | 'category' | 'workflow_settings'> & {
    inputs: GenerationInputMediaRow[] | null;
  }) | null;
};

type GenerationRecipeInputSourceRow = Pick<BundleRow, 'post_id' | 'owner_user_id'>
  & Partial<Pick<BundleRow, 'attachments' | 'resource_items'>>
  & { post: GenerationRecipeInputPostRow | null };

/** Who reads a recipe, as the third gate on its creation's inputs asks. */
type GenerationRecipeInputReader = Parameters<typeof canViewGenerationRecipeInputs>[1];

/**
 * Reads the recipes among these posts whose creators share the creation's
 * inputs (the stored switch), each with its post, generation and saved
 * inputs, in one request, keyed by the database's own spelling of the post
 * id. It gates nothing: `resolveGenerationRecipeInputs` applies the unlock's
 * gates for whoever reads.
 */
async function loadGenerationRecipeInputSources(params: {
  adminSupabase: SupabaseClient;
  postIds: readonly string[];
  /**
   * The list page it reads for: a public one reads published recipes alone,
   * as no one a list could know of opens the rest, and an owner's own page
   * every recipe of theirs, drafts too. The single-post detail, which has
   * settled who may read already, passes none.
   */
  page?: { ownerUserId: string | null };
  /** Also what each recipe stores, for a page that does not hold its rows. */
  withStoredKeys?: boolean;
  signal?: AbortSignal;
}): Promise<Map<string, GenerationRecipeInputSourceRow>> {
  const postIds = [...new Set(params.postIds)];
  if (postIds.length === 0) {
    return new Map();
  }

  const query = params.adminSupabase
    .from('post_resource_bundles')
    .select([
      'post_id, owner_user_id',
      ...(params.withStoredKeys ? [GENERATION_RECIPE_STORED_KEY_COLUMNS] : []),
      GENERATION_RECIPE_INPUT_POST_EMBED,
    ].join(', '))
    .in('post_id', postIds)
    .eq('allow_remix', true);
  const paged = !params.page
    ? query
    : params.page.ownerUserId
      ? query.eq('owner_user_id', params.page.ownerUserId)
      : query.eq('status', 'published');
  const { data, error } = await (params.signal ? paged.abortSignal(params.signal) : paged);
  if (error) {
    throw error;
  }

  return new Map(((data ?? []) as unknown as GenerationRecipeInputSourceRow[]).map((source) => [source.post_id, source]));
}

/**
 * The creation's saved inputs a recipe's reader gets with it, by the unlock's
 * three gates, or null where one holds them back: without links, for a teaser
 * to count or an unlock to list.
 */
async function resolveGenerationRecipeInputs(params: {
  adminSupabase: SupabaseClient;
  post: GenerationRecipeInputPostRow | null;
  reader: GenerationRecipeInputReader;
}): Promise<GenerationInputMediaItem[] | null> {
  const { post, reader } = params;
  const generation = post?.generation ?? null;
  if (!post || !generation || !(await passesGenerationRecipeInputGates(params.adminSupabase, post, generation, reader))) {
    return null;
  }

  return resolveGenerationRecipeInputMedia({
    adminSupabase: params.adminSupabase,
    post,
    generation,
    durableInputMedia: mapGenerationInputMediaRowsWithoutUrls(generation.inputs ?? []),
    urlMode: 'none',
  });
}

/**
 * A recipe's stored items with the creation's inputs merged in, as its unlock
 * lists them, and what the merge added, by type (null for nothing): the one
 * merge behind an unlock and every teaser's count of it.
 */
function mergeGenerationRecipeInputs(
  storedItems: PostResourceItem[],
  inputMedia: GenerationInputMediaItem[] | null,
): { items: PostResourceItem[]; addedCounts: PostResourceItemCounts | null } {
  const items = inputMedia ? addGenerationRecipeReferenceItems(storedItems, inputMedia) : storedItems;
  const addedItems = items.slice(storedItems.length);
  return { items, addedCounts: addedItems.length > 0 ? getPostResourceItemCounts(addedItems) : null };
}

/**
 * A recipe's stored items as far as merging the creation's inputs reads them:
 * by id (a stored `reference-<input id>` copy) and by file path, which only
 * `resource_items` and a legacy recipe's attachments carry. Its prompt, notes
 * and workflow make items with neither, so a page does not read that paid
 * text to count.
 */
function normalizeStoredReferenceKeyItems(
  source: Partial<Pick<BundleRow, 'attachments' | 'resource_items'>>,
): PostResourceItem[] {
  return normalizePostResourceItems(source.resource_items, { attachments: normalizeAttachments(source.attachments) });
}

/**
 * What unlocking each of these posts' recipes adds from its creation's saved
 * inputs, counted by type (recipe reading review B3), so a page's teasers --
 * the reel's and the feed's, the marketplace's and search's, the owner's lists
 * -- name what the unlock gives, as the post page does. The unlock's own read,
 * gates and merge: an owner's own page reads every recipe of theirs as their
 * own unlock does, and any other page reads published recipes as a buyer
 * would, since a list knows no purchases. One request for the page; a read
 * that fails or runs long counts nothing, a recipe whose inputs cannot be read
 * counts nothing on its own, and nothing but the counts leaves this function.
 */
export async function countGenerationRecipeReferenceItemsByPostId(params: {
  adminSupabase: SupabaseClient;
  postIds: readonly string[];
  /** The owner whose own page this is; null for a public page. */
  ownerUserId: string | null;
  /** What each recipe stores, from a page that holds its rows: not read again. */
  storedItemsByPostId?: ReadonlyMap<string, PostResourceItem[]>;
}): Promise<Map<string, PostResourceItemCounts>> {
  const { adminSupabase, ownerUserId, storedItemsByPostId } = params;
  if (params.postIds.length === 0) {
    return new Map();
  }

  let sources: Map<string, GenerationRecipeInputSourceRow>;
  try {
    sources = await loadGenerationRecipeInputSources({
      adminSupabase,
      postIds: params.postIds,
      page: { ownerUserId },
      withStoredKeys: !storedItemsByPostId,
      signal: AbortSignal.timeout(RECIPE_REFERENCE_COUNT_TIMEOUT_MS),
    });
  } catch (error) {
    logBackendError('post_resource_list_reference_count_failed', { error: error });
    return new Map();
  }

  const counted = await Promise.all([...sources.values()].map(async (source) => {
    try {
      const storedItems = storedItemsByPostId
        ? storedItemsByPostId.get(source.post_id) ?? []
        : normalizeStoredReferenceKeyItems(source);
      const { addedCounts } = mergeGenerationRecipeInputs(storedItems, await resolveGenerationRecipeInputs({
        adminSupabase,
        post: source.post,
        reader: {
          // An owner's page reads only their own recipes; checked here all the same.
          isOwner: ownerUserId !== null && source.owner_user_id === ownerUserId,
          boughtTombstonedPost: false,
        },
      }));
      return addedCounts ? [[source.post_id, addedCounts] as const] : [];
    } catch (error) {
      // One recipe whose inputs cannot be read leaves the rest of the page counted.
      logBackendError('post_resource_list_reference_count_failed', { error: error, postId: source.post_id });
      return [];
    }
  }));

  return new Map(counted.flat());
}

export async function loadGenerationRecipeRemixInputMediaByPostId(params: {
  postId: string;
  generationId: string;
  viewerUserId: string;
  adminSupabase?: SupabaseClient;
  /** Rethrow a failed read of the kept inputs (`loadEligibleGenerationRecipeInputMedia`). */
  throwOnError?: boolean;
}): Promise<GenerationInputMediaItem[]> {
  const adminSupabase = params.adminSupabase ?? createServiceClient();
  const entitlement = await getPostResourceBundleDetailByPostId(params.postId, {
    viewerUserId: params.viewerUserId,
    adminSupabase,
    countLockedReferences: false,
  });
  // The creator's stored switch (`resources.allowRemix`), not the Remix every
  // published creation recipe comes with: unlocking one lets a buyer remix it,
  // and hands over the creation's inputs only where the creator opted in.
  if (
    !entitlement
    || !entitlement.viewerCanAccess
    || entitlement.resources?.allowRemix !== true
    || entitlement.post?.generationId !== params.generationId
  ) {
    return [];
  }

  const eligible = await loadEligibleGenerationRecipeInputMedia({
    adminSupabase,
    postId: params.postId,
    generationId: params.generationId,
    urlMode: 'signed',
    // The unlock's gates for this reader, so a remix and the copy a generation
    // start makes from it withhold what the unlocked recipe withholds, such as
    // a live post's creation that is no longer public.
    viewerIsOwner: entitlement.viewerIsOwner,
    throwOnError: params.throwOnError,
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

/**
 * When each recipe's content last changed: its latest revision's time. A
 * revision is minted only when buyer-visible content changes
 * (`capture_post_resource_bundle_revision`), while the row's `updated_at`
 * also moves with every sale, free open and status sync, so "Updated <date>"
 * read from the row said a recipe nobody had touched in months was updated
 * today (recipe audit B-F4). One read per batch; a bundle with no revision, or
 * a read that fails, falls back to the row's own time.
 */
async function loadLatestContentRevisionTimes(bundleIds: string[]): Promise<Map<string, string>> {
  const uniqueBundleIds = Array.from(new Set(bundleIds.filter(Boolean)));
  if (uniqueBundleIds.length === 0) {
    return new Map();
  }

  try {
    const { data, error } = await createServiceClient()
      .from('post_resource_bundle_revisions')
      .select('bundle_id, revision_number, created_at')
      .in('bundle_id', uniqueBundleIds)
      .order('revision_number', { ascending: false });

    if (error) {
      if (!isMissingPostResourceBundlesSchemaError(error)) {
        logBackendError('post_resource_revision_times_load_failed', { error: error });
      }
      return new Map();
    }

    const latest = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ bundle_id: string | null; created_at: string | null }>) {
      if (row.bundle_id && row.created_at && !latest.has(row.bundle_id)) {
        latest.set(row.bundle_id, row.created_at);
      }
    }
    return latest;
  } catch (error) {
    logBackendError('post_resource_revision_times_load_failed', { error: error });
    return new Map();
  }
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
  const buildPostQuery = (includeTombstone: boolean) => {
    let query = adminSupabase
      .from('posts')
      .select(
        [
          'id',
          'user_id',
          'generation_id',
          'title',
          'body',
          'category',
          'post_format',
          'visibility',
          'archived_at',
          includeTombstone ? 'tombstoned_at' : null,
          'review_status',
          'showcase_asset_path',
          'output_url',
          'source_kind',
          'source_tool',
          'source_tool_slug',
          'save_count',
          'remix_count',
          'share_visit_count',
        ].filter(Boolean).join(', '),
      )
      .in('id', uniquePostIds);

    if (scope === 'public') {
      query = query.eq('visibility', 'public').is('archived_at', null).eq('review_status', 'visible');
    } else if (scope === 'entitled') {
      query = query.eq('review_status', 'visible');
    }

    return query;
  };

  let result: LinkedPostQueryResult = await buildPostQuery(true);

  // tombstoned_at ships with the bundle-revisions migration. On a database that
  // predates it, asking for the column fails the whole lookup, which would make
  // every linked post look missing and 404 healthy public bundles.
  if (isMissingPostTombstoneColumnError(result.error)) {
    result = await buildPostQuery(false);
  }
  if (scope !== 'owner' && isMissingPostReviewStatusColumnError(result.error)) {
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
          'user_id',
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
    } else if (scope === 'entitled' && includeReviewStatus) {
      fallbackQuery = fallbackQuery.eq('review_status', 'visible');
    }

    result = await fallbackQuery;
    if (scope !== 'owner' && isMissingPostReviewStatusColumnError(result.error)) {
      logBackendError('marketplace_moderation_boundary_unenforceable', { error: result.error });
      return new Map();
    }
  }

  let rows: LinkedPostRow[] = [];

  if (isMissingPostTextColumnsError(result.error)) {
    let legacyQuery = adminSupabase
      .from('posts')
      .select('id, user_id, generation_id, title, category, visibility, archived_at, review_status, showcase_asset_path, output_url, source_kind, source_tool, source_tool_slug, save_count, remix_count, share_visit_count')
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
          'user_id',
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
        tombstoned: Boolean(row.tombstoned_at),
        reviewStatus: row.review_status ?? 'visible',
        sourceKind: normalizeShowcaseSourceKind(row.source_kind),
        sourceTool: row.source_tool,
        sourceToolSlug: row.source_tool_slug ?? slugifySourceTool(row.source_tool),
        mediaUrl,
        mediaPreviewUrl: coverMedia?.previewUrl ?? null,
        mediaRenditionUrl: coverMedia?.renditionUrl ?? null,
        mediaKind: coverMedia?.mediaKind ?? getPostMediaKind(row.category, row.post_format),
        saveCount: row.save_count ?? 0,
        remixCount: row.remix_count ?? 0,
        shareVisitCount: row.share_visit_count ?? 0,
      };
    })
  );

  return new Map(linkedPosts.map((row) => [row.id, row]));
}

/**
 * What unlocking each of these listed recipes adds from its creation's saved
 * inputs (B3), for a page that holds their rows: an owner's own page as their
 * own unlock reads them, any other as a buyer's would. Only a recipe whose
 * creator shares the inputs (the stored switch) can gain any.
 */
function countListedRecipeReferences(
  rows: readonly BundleRow[],
  ownerUserId: string | null,
  storedItemsOf: (row: BundleRow) => PostResourceItem[] = (row) => normalizeResources(row).items ?? [],
): Promise<Map<string, PostResourceItemCounts>> {
  const sharing = rows.filter((row) => row.allow_remix === true);
  return countGenerationRecipeReferenceItemsByPostId({
    adminSupabase: createServiceClient(),
    postIds: sharing.map((row) => row.post_id),
    ownerUserId,
    storedItemsByPostId: new Map(sharing.map((row) => [row.post_id, storedItemsOf(row)])),
  });
}

/** A listed recipe whose teaser counts what its unlock adds (B3): counts and kinds only. */
function withCreationReferenceCounts(
  item: MarketplaceResourceListItem,
  counts: PostResourceItemCounts | undefined,
): MarketplaceResourceListItem {
  if (!counts) {
    return item;
  }

  const lockedPreview = addPostResourceItemCountsToLockedPreview(item.lockedPreview, counts);
  return { ...item, resourceKinds: lockedPreview.resourceKinds, lockedPreview };
}

async function hydrateBundleRows(
  rows: BundleRow[],
  countryCode?: string | null,
  scope: LinkedPostScope = 'public',
  includeMediaPreviews = false,
  options: {
    // Presentation scope and post-visibility scope usually agree, but a buyer
    // reading a delisted or tombstoned unlock needs the wider post lookup while
    // still getting the public presentation.
    postScope?: LinkedPostScope;
    allowNsfw?: boolean;
    // A page that serves every recipe it hydrates (the seller dashboard)
    // counts what each unlock adds from the creation's inputs (B3) beside its
    // other reads: an owner's own page as their unlock reads it, a public one
    // as a buyer's would. A page that filters what it hydrates (the
    // marketplace, its search) counts only what it serves, after filtering on
    // what recipes store; the single-post detail counts its own.
    creationReferencesFor?: { ownerUserId: string | null };
  } = {},
): Promise<MarketplaceResourceListItem[]> {
  const { postScope = scope, allowNsfw = false, creationReferencesFor } = options;
  if (scope === 'public' && !allowNsfw) {
    const nsfwIds = await loadNsfwPostIds(createServiceClient(), rows.map((row) => row.post_id));
    rows = rows.filter((row) => !nsfwIds.has(row.post_id));
  }
  const storedResourcesByBundleId = new Map(rows.map((row) => [row.id, normalizeResources(row)]));
  const [profilesMap, postMap, contentUpdatedAtMap, creationReferenceCounts] = await Promise.all([
    loadProfileMap(rows.map((row) => row.owner_user_id)),
    loadLinkedPostMap(rows.map((row) => row.post_id), postScope, includeMediaPreviews),
    loadLatestContentRevisionTimes(rows.map((row) => row.id)),
    creationReferencesFor
      ? countListedRecipeReferences(
          rows,
          creationReferencesFor.ownerUserId,
          (row) => storedResourcesByBundleId.get(row.id)?.items ?? [],
        )
      : new Map<string, PostResourceItemCounts>(),
  ]);

  return Promise.all(
    rows.map(async (row) => {
      const post = postMap.get(row.post_id) ?? null;
      // A creation post's published recipe includes its Remix, whatever its
      // stored switch says (2026-10-27): reported as such on every read, so its
      // kinds, chips and remix gate agree.
      const allowRemix = resolveRecipeAllowRemix({
        storedAllowRemix: row.allow_remix,
        status: row.status,
        generationId: post?.generationId ?? null,
      });
      const normalizedResources = { ...(storedResourcesByBundleId.get(row.id) ?? normalizeResources(row)), allowRemix };
      const updatedAt = contentUpdatedAtMap.get(row.id) ?? row.updated_at;
      const fullLockedPreview = buildPostResourceBundleLockedPreview(normalizedResources, updatedAt);
      const lockedPreview = scope === 'owner'
        ? fullLockedPreview
        : sanitizePostResourceBundleLockedPreview(fullLockedPreview) ?? fullLockedPreview;
      const remix = resolvePostRemixCapability({
        generationId: post?.generationId ?? null,
        postFormat: post?.postFormat ?? null,
        category: post?.category ?? null,
        sourceKind: post?.sourceKind ?? null,
        resourceBundle: {
          viewerCanAccess: scope === 'owner',
          allowRemix,
          items: normalizedResources.items ?? [],
        },
      });

      return withCreationReferenceCounts({
        id: row.id,
        postId: row.post_id,
        legacyAssetId: row.legacy_asset_id,
        title: normalizeBundleDisplayTitle(row.title),
        summary: row.summary,
        previewText: row.preview_text,
        accessMode: row.access_mode,
        priceUsdCents: row.price_usd_cents,
        salesCount: row.sales_count,
        freeUnlockCount: row.free_unlock_count ?? 0,
        ...(scope === 'owner' ? { earningsUsdCents: row.earnings_usd_cents } : {}),
        allowRemix,
        resourceKinds: lockedPreview.resourceKinds,
        lockedPreview,
        createdAt: row.created_at,
        updatedAt,
        seller: toSellerSummary(row.owner_user_id, profilesMap),
        post,
        priceQuote: await buildPriceQuote(row.price_usd_cents, countryCode),
        remixCapability: remix.capability,
        remixTarget: remix.target,
      }, creationReferenceCounts.get(row.post_id));
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
  const profileReadinessError = getCreatorPublishReadinessError(seller);
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
    // seller is deliberately omitted: the assessment's identity issue repeats
    // the handle + display name standard already enforced above.
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
  const result = await params.supabase.rpc('upsert_post_with_resource_bundle', {
    p_post: params.post,
    p_bundle: buildBundleMutationPayload(params.bundle, ownerUserId),
    p_has_bundle: true,
  });

  if (result.error) {
    throwSupabaseMutationFailure(result);
  }

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return normalizeMutationResult(row);
}

export async function updatePostWithResourceBundleAtomically(params: {
  supabase: SupabaseClient;
  postId: string;
  ownerUserId: string;
  patch: Record<string, unknown>;
  hasBundlePayload: boolean;
  bundle: PostResourceBundleInput | null | undefined;
  /**
   * When present, proof media is replaced in the same database transaction as
   * the post and bundle. Storage promotion still happens before this call; an
   * RPC failure therefore leaves every existing database row untouched.
   */
  mediaItems?: PostMediaPersistInput[];
}): Promise<PostResourceBundleMutationResult> {
  const rpcName = params.mediaItems === undefined
    ? 'update_post_with_resource_bundle'
    : 'update_post_with_resource_bundle_and_media';
  const rpcParams = {
    p_post_id: params.postId,
    p_owner_user_id: params.ownerUserId,
    p_post_patch: params.patch,
    p_has_bundle: params.hasBundlePayload,
    p_bundle: params.hasBundlePayload ? buildBundleMutationPayload(params.bundle, params.ownerUserId) : null,
    ...(params.mediaItems === undefined ? {} : { p_media_items: params.mediaItems }),
  };
  const result = await params.supabase.rpc(rpcName, rpcParams);

  if (result.error) {
    throwSupabaseMutationFailure(result);
  }

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
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

/**
 * The entitlement predicate for a stored bundle: owner, or a recorded purchase.
 * Anything wider belongs in the caller, never here — every paid payload in the
 * product is withheld on the strength of this returning false.
 */
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
    // A recipe that anyone has (a sale or a free unlock) is retired rather
    // than deleted by the database (post_resource_bundles_retire_instead_of_delete,
    // 20261027172920): delisted with retired_at set, and its buyers keep it.
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
  const rowsByBundleId = new Map<string, BundleRow>();
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

    if (selectColumns === BUNDLE_ROW_SELECT && isMissingPostResourceRetirementColumnError(error)) {
      selectColumns = BUNDLE_ROW_SELECT_WITHOUT_RETIREMENT;
      ({ data, error } = await buildQuery(selectColumns)
        .range(scanOffset, rangeEnd));
    }

    if (selectColumns !== BUNDLE_ROW_SELECT_LEGACY && isMissingPostResourceItemsColumnError(error)) {
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

    // Filtered on what each recipe stores, as the RPC's SQL filters: what an
    // unlock adds from the creation's inputs (B3) is a best-effort read,
    // counted below for the page served alone.
    const hydratedItems = await hydrateBundleRows(rows, countryCode, 'public', true);
    for (const row of rows) rowsByBundleId.set(row.id, row);
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
  const referenceCounts = await countListedRecipeReferences(
    pageItems.flatMap((item) => {
      const row = rowsByBundleId.get(item.id);
      return row ? [row] : [];
    }),
    null,
  );

  return {
    items: pageItems.map((item) => withCreationReferenceCounts(item, referenceCounts.get(item.postId))),
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
  // Checked below on what each recipe stores, as the RPC's SQL filtered it:
  // what an unlock adds from the creation's inputs (B3) is a best-effort read,
  // counted after for the recipes the page serves alone.
  const hydratedItems = await hydrateBundleRows(rows, null, 'public', true);
  // Walked by raw row, not by hydrated item: hydration drops an NSFW bundle
  // before this loop, and a dropped row still occupies its raw position. Left
  // out of the count, nextOffset fell short by one per hidden row and the next
  // page re-read (and repeated) the rows after it.
  const hydratedById = new Map(hydratedItems.map((item) => [item.id, item]));
  const pageItems: MarketplaceResourceListItem[] = [];
  const pageRows: BundleRow[] = [];
  let consumedRowCount = 0;

  for (const row of rows) {
    const item = hydratedById.get(row.id);
    if (!item?.post) {
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
      pageRows.push(row);
    }
  }
  // As a buyer's unlock would add them.
  const referenceCounts = await countListedRecipeReferences(pageRows, null);

  return {
    items: pageItems.map((item) => withCreationReferenceCounts(item, referenceCounts.get(item.postId))),
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
    tool: string | null,
  ) => getMarketplaceResourceListBase({
    filter,
    resource,
    tool,
    q: null,
    sort,
    offset: 0,
    limit,
  }),
  ['marketplace-resource-list-base-v5'],
  {
    revalidate: 60,
    // SHOWCASE_FEED_CACHE_TAG is load-bearing, not incidental. The listing
    // joins `posts`, and the moderation take-down path
    // (`admin-moderation-service.ts:98`) invalidates *only* the feed tag —
    // never the marketplace one. Dropping it here to stop unrelated events
    // busting this cache would leave taken-down content listed in the
    // marketplace for up to the revalidate window. Narrowing it means first
    // making every post-visibility path invalidate the marketplace tag too.
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
  tool: string | null,
) {
  try {
    return await getCachedMarketplaceResourceListBase(filter, resource, sort, limit, tool);
  } catch (error) {
    if (isMissingIncrementalCacheError(error)) {
      return getMarketplaceResourceListBase({
        filter,
        resource,
        tool,
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
    ? await loadCachedMarketplaceResourceListBase(
      filter,
      resource,
      sort,
      limit,
      normalizedToolFilter || null,
    )
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

type PurchasedRevisionRow = {
  revision_number: number;
  is_latest: boolean;
  title: string;
  summary: string;
  preview_text: string;
  access_mode: PersistedPostResourceBundleAccessMode;
  price_usd_cents: number;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: unknown;
  attachments: unknown;
  allow_remix: boolean;
  resource_sections: unknown;
  resource_items: unknown;
  created_at: string;
  content_fingerprint: string;
};

/**
 * Reads the revision this buyer pinned at checkout. Degrades to null rather
 * than throwing: a missing revision must never take down an unlock the buyer
 * is otherwise entitled to read.
 */
async function loadPurchasedBundleRevision(
  adminSupabase: SupabaseClient,
  bundleId: string,
  buyerUserId: string,
): Promise<PurchasedRevisionRow | null> {
  const { data, error } = await adminSupabase.rpc('get_purchased_post_resource_bundle_revision', {
    p_bundle_id: bundleId,
    p_buyer_user_id: buyerUserId,
  });

  if (error) {
    if (!isMissingPostResourceBundlesSchemaError(error)) {
      logBackendError('post_resource_purchased_revision_load_failed', { error: error });
    }
    return null;
  }

  const [row] = (data ?? []) as PurchasedRevisionRow[];
  return row ?? null;
}

function toPurchasedRevision(
  row: PurchasedRevisionRow | null,
): PurchasedPostResourceBundleRevision | null {
  // Nothing to offer when the buyer's revision is still the current one.
  if (!row || row.is_latest) {
    return null;
  }

  const legacyResources: PostResourceBundleResources = {
    promptText: normalizeText(row.prompt_text),
    notesMarkdown: normalizeText(row.notes_markdown),
    workflowShareUrl: normalizeText(row.workflow_share_url),
    workflowSnapshot: row.workflow_snapshot
      ? serializeWorkflowGraph(normalizeWorkflowGraph(row.workflow_snapshot))
      : null,
    attachments: normalizeAttachments(row.attachments),
    allowRemix: Boolean(row.allow_remix),
    sections: normalizePostResourceSections(row.resource_sections),
  };

  return {
    revisionNumber: row.revision_number,
    purchasedAt: row.created_at,
    title: normalizeBundleDisplayTitle(row.title),
    summary: row.summary ?? '',
    previewText: row.preview_text,
    accessMode: row.access_mode === 'paid' ? 'paid' : 'free',
    priceUsdCents: row.price_usd_cents,
    resources: {
      ...legacyResources,
      items: normalizePostResourceItems(row.resource_items, legacyResources),
    },
    mediaItems: [],
  };
}

export async function getPostResourceBundleDetailByPostId(
  postId: string,
  options?: {
    viewerUserId?: string | null;
    countryCode?: string | null;
    adminSupabase?: SupabaseClient;
    /** The post's `is_nsfw`, when the caller has just read its row; read here otherwise. */
    isNsfw?: boolean;
    /**
     * The caller is opening the viewer's own purchase (the buyer library). A
     * purchase is the entitlement, so its buyer skips the NSFW reveal gate;
     * the purchase lookup below still decides, never this flag alone.
     */
    entitledPurchase?: boolean;
    /**
     * Whether a viewer without access is told how many of the creation's
     * inputs the unlock adds (B3), which costs a read. A caller that reads the
     * detail only to decide access (a buy, a file, a remix) passes false.
     */
    countLockedReferences?: boolean;
  }
): Promise<PostResourceBundleDetail | null> {
  const {
    viewerUserId = null,
    countryCode = null,
    adminSupabase = createServiceClient(),
    isNsfw,
    entitledPurchase = false,
    countLockedReferences = true,
  } = options ?? {};
  const selectBundle = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .eq('post_id', postId)
      .maybeSingle();
  let { data, error } = await selectBundle(BUNDLE_ROW_SELECT);
  if (isMissingPostResourceRetirementColumnError(error)) {
    ({ data, error } = await selectBundle(BUNDLE_ROW_SELECT_WITHOUT_RETIREMENT));
  }
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

  // Every check below goes by the post id as the database spells it. Postgres
  // found the recipe by the caller's spelling whatever its case, but answers
  // with its own, so an NSFW post looked up by an id in capitals read as safe.
  const recipePostId = row.post_id;
  const nsfwGated = row.owner_user_id !== viewerUserId
    && (isNsfw ?? (await loadNsfwPostIds(adminSupabase, [recipePostId])).has(recipePostId));
  if (nsfwGated && !entitledPurchase && !await hasNsfwReveal(adminSupabase, recipePostId, viewerUserId)) return null;

  // Entitlement is resolved before the publish gate, because a delisted or
  // retired bundle must still open for the people who bought it -- that is the
  // whole promise of a purchase surviving the creator removing the unlock.
  let viewerHasPurchased = false;
  let viewerPurchaseId: string | null = null;
  if (viewerUserId && viewerUserId !== row.owner_user_id) {
    const { data: purchaseData, error: purchaseError } = await adminSupabase
      .from('post_resource_bundle_purchases')
      .select('id, bundle_id, buyer_user_id')
      .eq('bundle_id', row.id)
      .eq('buyer_user_id', viewerUserId)
      .maybeSingle();

    if (purchaseError && !isMissingPostResourceBundlesSchemaError(purchaseError)) {
      logBackendError('post_resource_purchase_state_load_failed', { error: purchaseError });
    } else {
      viewerHasPurchased = Boolean(purchaseData);
      viewerPurchaseId = (purchaseData as { id?: string } | null)?.id ?? null;
    }
  }

  // Whatever show_mature or the reveal say, a buyer reads what they bought;
  // anyone else still needs a reveal.
  if (nsfwGated && entitledPurchase && !viewerHasPurchased && !await hasNsfwReveal(adminSupabase, recipePostId, viewerUserId)) {
    return null;
  }

  if (
    !isBundlePublishedForMarketplace(row)
    && row.owner_user_id !== viewerUserId
    && !viewerHasPurchased
  ) {
    return null;
  }

  const viewerIsOwner = Boolean(viewerUserId && viewerUserId === row.owner_user_id);
  const viewerCanAccess = canViewerAccessBundle(row, viewerUserId, viewerHasPurchased);
  // A buyer keeps reading through a delisting, an archive and a tombstone; the
  // 'entitled' scope still enforces moderation state, so a take-down retracts
  // the unlock for everyone.
  const postScope: LinkedPostScope = viewerIsOwner
    ? 'owner'
    : viewerHasPurchased
      ? 'entitled'
      : 'public';
  // The payload as stored, the creator's own `allowRemix` switch included:
  // the editor round-trips it, and it alone decides whether the creation's
  // inputs go to the people who unlock the recipe. Whether the recipe comes
  // with its Remix is `hydrated.allowRemix` (resolveRecipeAllowRemix).
  const normalizedResources = normalizeResources(row);
  // A recipe the creator shares the creation's inputs with (the stored switch)
  // reads them beside the reads above, so neither adds a wait to the post page
  // or the app's Details: for the unlock to merge them in, or for someone
  // without it to be told how many come with it (B3). The teaser gives up on a
  // slow read; the unlock waits for its references. The kept inputs come
  // embedded in that one request, so a failed read of them fails it, and the
  // recipe goes out without references (below): it never reads as "nothing
  // kept", which would list the uploads the run's settings name (#584).
  const readsCreationInputs = row.allow_remix === true && (viewerCanAccess || countLockedReferences);
  const creationInputsFailure = viewerCanAccess
    ? 'post_resource_recipe_reference_load_failed'
    : 'post_resource_locked_reference_count_failed';
  const [[hydrated], creationInputSource] = await Promise.all([
    hydrateBundleRows([row], countryCode, viewerIsOwner ? 'owner' : 'public', false, {
      postScope,
      allowNsfw: true, // The owner, reveal or purchase check above already authorized this single post.
    }),
    readsCreationInputs
      ? loadGenerationRecipeInputSources({
          adminSupabase,
          postIds: [recipePostId],
          signal: viewerCanAccess ? undefined : AbortSignal.timeout(RECIPE_REFERENCE_COUNT_TIMEOUT_MS),
        }).then(
          (sources) => sources.get(recipePostId) ?? null,
          (error: unknown) => {
            logBackendError(creationInputsFailure, { error: error });
            return null;
          },
        )
      : null,
  ]);
  if (!hydrated || (!viewerIsOwner && !hydrated.post)) {
    return null;
  }
  // What the creation's inputs add to the recipe: counted below for every
  // reader, and merged into the items for one with access.
  let referenceCounts: PostResourceItemCounts | null = null;

  // What the buyer actually paid for. Later edits reach them as improvements,
  // but the revision pinned at checkout stays available so a creator cannot
  // hollow out a sold unlock.
  const purchasedRevisionRow = viewerHasPurchased && viewerUserId
    ? await loadPurchasedBundleRevision(adminSupabase, row.id, viewerUserId)
    : null;
  const purchasedRevision = viewerCanAccess ? toPurchasedRevision(purchasedRevisionRow) : null;
  if (purchasedRevision && viewerPurchaseId) {
    purchasedRevision.mediaItems = await loadPurchasedProofMedia({
      adminSupabase,
      purchaseId: viewerPurchaseId,
      resources: purchasedRevision.resources,
      includeStoredUrls: true,
    });
  }

  // Bundles do not persist the creation's reference media as items; the saved
  // references live in generation_input_media and are surfaced here at read
  // time, as the recipe layer did before it was folded into stored bundles.
  // The gate is entitlement (viewerCanAccess covers owner, free unlock, and
  // paid purchase) plus the creator's stored remix opt-in on the bundle --
  // never the Remix every published creation recipe comes with since
  // 2026-10-27: the inputs can be personal and nobody else opted them in. For
  // non-owners the generation must also still be public, which is how a
  // moderation take-down retracts it. share_input_media_for_remix is
  // deliberately not consulted here — it governs restoring these files into a
  // viewer's own remix (/api/remix-source), not seeing them inside an unlock
  // they are entitled to. Failing to load references must degrade to the
  // bundle without them, never take the whole unlock down. Someone without
  // the recipe is told how many come with it, by the same read and gates, as
  // they stand for a buyer: the post live, the generation still public.
  if (creationInputSource) {
    try {
      const merged = mergeGenerationRecipeInputs(normalizedResources.items ?? [], await resolveGenerationRecipeInputs({
        adminSupabase,
        post: creationInputSource.post,
        // Without access this reads as no owner and no buyer: a would-be buyer.
        reader: {
          isOwner: viewerIsOwner,
          boughtTombstonedPost: viewerHasPurchased && hydrated.post?.tombstoned === true,
        },
      }));
      // Counted for a viewer with access too, so the recipe names the same
      // kinds once it is unlocked (the app's recipe page shows them either way).
      referenceCounts = merged.addedCounts;
      if (viewerCanAccess) {
        normalizedResources.items = merged.items;
      }
    } catch (error) {
      logBackendError(creationInputsFailure, { error: error });
    }
  }
  const lockedPreview = referenceCounts
    ? addPostResourceItemCountsToLockedPreview(hydrated.lockedPreview, referenceCounts)
    : hydrated.lockedPreview;
  const remix = resolvePostRemixCapability({
    generationId: hydrated.post?.generationId ?? null,
    postFormat: hydrated.post?.postFormat ?? null,
    category: hydrated.post?.category ?? null,
    sourceKind: hydrated.post?.sourceKind ?? null,
    resourceBundle: {
      viewerCanAccess,
      allowRemix: hydrated.allowRemix,
      items: normalizedResources.items ?? [],
    },
  });

  return {
    ...hydrated,
    resourceKinds: lockedPreview.resourceKinds,
    lockedPreview,
    status: row.status,
    resources: viewerCanAccess ? normalizedResources : null,
    viewerHasPurchased,
    viewerIsOwner,
    viewerCanAccess,
    purchasedRevision,
    retiredAt: row.retired_at ?? null,
    tombstoned: Boolean(hydrated.post?.tombstoned),
    remixCapability: remix.capability,
    remixTarget: remix.target,
  };
}

/**
 * The seller dashboard's listing check, for an owner read that holds the post
 * row itself (the owner post list behind the app's Your Sales). It grades with
 * the display title and seller summary the dashboard builds, so the app and the
 * web sell page give one listing the same verdict.
 */
export function assessOwnerListingQuality(input: {
  ownerUserId: string;
  ownerProfile: { username: string | null; display_name: string | null; avatar_url: string | null } | null;
  bundle: {
    title: string | null | undefined;
    summary: string | null | undefined;
    previewText: string | null | undefined;
    accessMode: PersistedPostResourceBundleAccessMode;
    priceUsdCents: number;
    resourceKinds: PostResourceKind[];
  };
  post: MarketplaceQualityInput['post'];
}): MarketplaceQualityAssessment {
  const profilesMap = new Map<string, ProfileRow>(
    input.ownerProfile ? [[input.ownerUserId, { id: input.ownerUserId, ...input.ownerProfile }]] : [],
  );

  return assessMarketplaceListingQuality({
    title: normalizeBundleDisplayTitle(input.bundle.title),
    summary: input.bundle.summary,
    previewText: input.bundle.previewText,
    accessMode: input.bundle.accessMode,
    priceUsdCents: input.bundle.priceUsdCents,
    resourceKinds: input.bundle.resourceKinds,
    post: input.post,
    seller: toSellerSummary(input.ownerUserId, profilesMap),
  });
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
        totalFreeUnlockCount: 0,
        totalEarningsUsdCents: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    logBackendError('post_resource_seller_bundles_load_failed', { error: error });
    throw error;
  }

  const rows = (data ?? []) as unknown as BundleRow[];
  const hydratedBundles = await hydrateBundleRows(rows, countryCode, 'owner', false, {
    creationReferencesFor: { ownerUserId: userId },
  });
  const bundles = hydratedBundles.map((bundle, index) => ({
    ...bundle,
    status: rows[index]?.status ?? 'draft',
    earningsUsdCents: rows[index]?.earnings_usd_cents ?? 0,
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

    // A free unlock leaves a "paid" order of 0 subunits. It is not a sale
    // (decision 6, 2026-10-17): the dashboard counts it under Free unlocks and
    // lists only what buyers paid for here.
    const orders = ((orderData ?? []) as OrderRow[]).filter((row) => row.amount_subunits > 0);
    const buyerProfiles = await loadProfileMap(orders.map((row) => row.buyer_user_id));
    sales = orders.map((row) => {
      const buyerProfile = buyerProfiles.get(row.buyer_user_id);
      // This payload is serialised into the seller's page, so a buyer is a
      // handle or a name and never their account id: one with neither, or every
      // buyer when the profile read fails, is "A buyer".
      const buyerLabel = buyerProfile?.username
        ? `@${buyerProfile.username}`
        : buyerProfile?.display_name?.trim() || 'A buyer';

      return {
        id: row.id,
        bundleId: row.bundle_id,
        bundleTitle: bundleIdToTitle.get(row.bundle_id) ?? 'Recipe',
        buyerLabel,
        amountSubunits: row.amount_subunits,
        currency: row.currency,
        createdAt: row.created_at,
      };
    });
  }

  const { data: deletedAuditData, error: deletedAuditError } = await adminSupabase
    .from('post_deletion_audits')
    .select('id, post_id, title, visibility, source_kind, bundle_access_mode, bundle_status, bundle_price_usd_cents, bundle_resource_kinds, sales_count, earnings_usd_cents, had_paid_orders, deleted_at')
    .eq('owner_user_id', userId)
    .order('deleted_at', { ascending: false });

  if (deletedAuditError) {
    logBackendError('post_resource_deleted_snapshots_load_failed', { error: deletedAuditError });
    throw deletedAuditError;
  }

  // A post deleted while it had buyers is tombstoned, not removed, so its
  // bundle is still one of `bundles` (where `post.tombstoned` labels it); its
  // deletion audit would list the same post a second time.
  const listedPostIds = new Set(rows.map((row) => row.post_id));
  const deletedSnapshots = ((deletedAuditData ?? []) as Array<{
    id: string;
    post_id: string | null;
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
  }>).filter((row) => !row.post_id || !listedPostIds.has(row.post_id)).map((row) => ({
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
    totalFreeUnlockCount: rows.reduce((sum, row) => sum + (row.free_unlock_count ?? 0), 0),
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
