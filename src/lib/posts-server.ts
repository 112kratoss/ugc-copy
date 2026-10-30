import { postMediaReadUrl } from '@/lib/post-media-storage';
import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isOwnOrLinkedAccountId } from '@/lib/account-identity';
import { createServiceClient, resolveOwnedStoredMediaUrl } from '@/lib/server-helpers';
import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';
import {
  buildPostResourceBundleLockedPreview,
  getPostResourceKinds,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  sanitizePostResourceBundleLockedPreview,
  type PostResourceBundleResources,
} from '@/lib/post-resource-bundles';
import {
  MAGICBOOKLET_SOURCE_KIND,
  getShowcaseMediaKind,
  isShowcaseItemCategory,
  type RawShowcaseSourceKind,
  type ShowcaseMediaKind,
  type ShowcasePostFormat,
  type ShowcaseAssetSummary,
  type ShowcaseItemCategory,
} from '@/lib/showcase';

type PostCategory = ShowcaseItemCategory;
type PostVisibility = 'public' | 'unlisted' | 'private';

export interface PostReferenceRow {
  id: string;
  user_id: string | null;
  generation_id: string | null;
  visibility: PostVisibility;
  category: PostCategory;
  prompt: string | null;
  title?: string | null;
  source_kind: RawShowcaseSourceKind;
  archived_at?: string | null;
  review_status?: 'visible' | 'flagged' | 'hidden' | null;
}

export interface PostMediaRow {
  showcase_asset_path: string | null;
  output_url: string | null;
  user_id: string | null;
}

interface LegacyGenerationReferenceRow {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  status: string | null;
  category: string | null;
  prompt: string | null;
}

type SupabaseSchemaError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

function getErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const message = (error as SupabaseSchemaError).message;
  return typeof message === 'string' ? message : '';
}

function normalizeLegacyCategory(category: string | null | undefined): PostCategory {
  return isShowcaseItemCategory(category) ? category : 'image';
}

export function normalizeLegacyPostFormat(category: PostCategory): ShowcasePostFormat {
  return category === 'text' ? 'text' : 'media';
}

export function getPostMediaKind(
  category: ShowcaseItemCategory,
  postFormat: ShowcasePostFormat
): ShowcaseMediaKind | null {
  return getShowcaseMediaKind(category, postFormat);
}

// How long a post title may be; client components read it from post-limits.ts.
export { TITLE_MAX_LENGTH } from '@/lib/post-limits';
// The same for a post's text (its body). Edit and publish check this one;
// create checks the same number in post-creation-submission-service.ts, and
// both composers mirror it for their counters.
export const BODY_MAX_LENGTH = 2000;

// Titles derived from a body are cut well short of TITLE_MAX_LENGTH, so an
// auto-generated title can never violate the limit a creator is held to.
const DERIVED_TITLE_MAX_LENGTH = 80;

export function deriveTitleFromBody(body: string | null | undefined): string | null {
  if (!body) {
    return null;
  }

  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return null;
  }

  return firstLine.slice(0, DERIVED_TITLE_MAX_LENGTH);
}

export function summarizeBody(body: string | null | undefined, maxLength = 160): string {
  if (!body) {
    return '';
  }

  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

async function findLegacyGenerationReference(
  adminSupabase: SupabaseClient,
  generationId: string
): Promise<PostReferenceRow | null> {
  const { data, error } = await adminSupabase
    .from('generations')
    .select('id, user_id, is_public, status, category, prompt')
    .eq('id', generationId)
    .maybeSingle();

  if (error) {
    logBackendError('failed_to_resolve_legacy_generation_reference', { error: error });
    throw error;
  }

  const row = (data as LegacyGenerationReferenceRow | null) ?? null;
  if (!row || row.status !== 'succeeded') {
    return null;
  }

  return {
    id: row.id,
    user_id: row.user_id ?? null,
    generation_id: row.id,
    visibility: row.is_public ? 'public' : 'private',
    category: normalizeLegacyCategory(row.category),
    prompt: row.prompt ?? null,
    source_kind: MAGICBOOKLET_SOURCE_KIND,
  };
}

export function isMissingPostsSchemaError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return (
    (code === 'PGRST205' && message.includes("public.posts")) ||
    (code === 'PGRST202' && message.includes('record_post_share_event')) ||
    (code === 'PGRST202' && message.includes('toggle_post_save')) ||
    (code === 'PGRST202' && message.includes('increment_post_remix_count')) ||
    (code === '42703' && (message.includes('post_format') || message.includes('body'))) ||
    message.includes("Could not find the table 'public.posts'") ||
    message.includes("Could not find the table 'public.post_saves'") ||
    message.includes('record_post_share_event') ||
    message.includes('toggle_post_save') ||
    message.includes('increment_post_remix_count')
  );
}

export function isMissingPostTextColumnsError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return (
    code === '42703' &&
    (
      message.includes('post_format') ||
      message.includes('body')
    )
  );
}

export function isMissingPostSourceToolSlugColumnError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return code === '42703' && message.includes('source_tool_slug');
}

export function isMissingPostReviewStatusColumnError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return code === '42703' && message.includes('review_status');
}

export function isMissingPostResourceItemsColumnError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return code === '42703' && (message.includes('resource_items') || message.includes('resource_sections'));
}

/**
 * The retirement columns ship with the bundle-revisions migration. Code can run
 * ahead of schema -- a rollback, or a developer pointing a local server at an
 * unmigrated database -- and asking for a column that does not exist fails the
 * whole select, which would take every bundle read down rather than degrade.
 */
export function isMissingPostResourceRetirementColumnError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return code === '42703' && message.includes('retired_at');
}

/** See isMissingPostResourceRetirementColumnError -- same migration, same risk. */
export function isMissingPostTombstoneColumnError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return code === '42703' && message.includes('tombstoned_at');
}

export function isMissingMarketplaceSchemaError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return (
    code === 'PGRST205' &&
    (
      message.includes('public.marketplace_assets') ||
      message.includes('public.marketplace_asset_content') ||
      message.includes('public.marketplace_orders') ||
      message.includes('public.marketplace_purchases')
    )
  );
}

export function isMissingPostResourceBundlesSchemaError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const code = typeof error === 'object' && error ? (error as SupabaseSchemaError).code : undefined;

  return (
    (code === 'PGRST205' &&
      (
        message.includes('public.post_resource_bundles') ||
        message.includes('public.post_resource_bundle_orders') ||
        message.includes('public.post_resource_bundle_purchases')
      )) ||
    message.includes("Could not find the table 'public.post_resource_bundles'") ||
    message.includes('complete_post_resource_bundle_purchase') ||
    message.includes('upsert_post_with_resource_bundle') ||
    message.includes('update_post_with_resource_bundle') ||
    message.includes('publish_generation_post_with_resource_bundle') ||
    message.includes('list_marketplace_resource_bundles')
  );
}

function resolveShowcaseAssetUrl(
  adminSupabase: SupabaseClient,
  showcaseAssetPath: string
): string {
  return postMediaReadUrl(adminSupabase, showcaseAssetPath);
}

/**
 * The folder a post's own file may be signed from: the post owner's, or that of
 * a guest identity linked to the owner. A creation made as a guest before
 * registering is published as the account (02-4), but a private post of it
 * keeps the generation's file, which stays in the guest's folder; checked
 * against the post owner alone, that post showed its owner no media. Public and
 * unlisted posts read their showcase copy before this is asked. Anyone else's
 * folder stays refused: the owner id returned is then the post owner's own.
 */
async function storedMediaOwnerId(
  adminSupabase: SupabaseClient,
  outputUrl: string,
  postOwnerId: string
): Promise<string> {
  const pathOwnerId = getCanonicalStoredMediaLocation(outputUrl)?.filePath.split('/')[0];
  if (!pathOwnerId || pathOwnerId === postOwnerId) return postOwnerId;
  return await isOwnOrLinkedAccountId(adminSupabase, postOwnerId, pathOwnerId)
    ? pathOwnerId
    : postOwnerId;
}

export async function resolvePostMediaUrl(
  adminSupabase: SupabaseClient,
  row: PostMediaRow
): Promise<string | null> {
  if (row.showcase_asset_path) {
    return resolveShowcaseAssetUrl(adminSupabase, row.showcase_asset_path);
  }

  if (!row.output_url) {
    return null;
  }

  if (row.user_id) {
    return resolveOwnedStoredMediaUrl(
      adminSupabase,
      row.output_url,
      await storedMediaOwnerId(adminSupabase, row.output_url, row.user_id),
    );
  }

  // Some legacy provider-backed posts have no durable owner. Preserve only a
  // plain HTTPS provider URL in that case; a storage path cannot be signed
  // safely without an owner to bind its first segment to.
  try {
    const url = new URL(row.output_url);
    if (url.pathname.includes('/storage/v1/object/')) return null;
    return url.protocol === 'https:' && !url.username && !url.password
      ? row.output_url
      : null;
  } catch {
    return null;
  }
}

async function findPostReferenceByColumn(
  adminSupabase: SupabaseClient,
  column: 'id' | 'generation_id',
  value: string
): Promise<PostReferenceRow | null> {
  let result = await adminSupabase
    .from('posts')
    .select('id, user_id, generation_id, visibility, category, prompt, title, source_kind, archived_at, review_status')
    .eq(column, value)
    .eq('visibility', 'public')
    .is('archived_at', null)
    .eq('review_status', 'visible')
    .maybeSingle();

  if (isMissingPostTextColumnsError(result.error)) {
    result = await adminSupabase
      .from('posts')
      .select('id, user_id, generation_id, visibility, category, prompt, source_kind, archived_at, review_status')
      .eq(column, value)
      .eq('visibility', 'public')
      .is('archived_at', null)
      .eq('review_status', 'visible')
      .maybeSingle();
  }

  if (isMissingPostReviewStatusColumnError(result.error)) {
    logBackendError('cannot_enforce_the_public_post_moderation_boundary', { error: result.error });
    return null;
  }

  if (result.error) {
    logBackendError('failed_to_resolve_post_by', { message: `Failed to resolve post by ${column}:`, error: result.error });
    throw result.error;
  }

  return (result.data as PostReferenceRow | null) ?? null;
}

async function findPostReferenceByIdOrGenerationId(
  id: string,
  adminSupabase = createServiceClient()
): Promise<PostReferenceRow | null> {
  try {
    const directPost = await findPostReferenceByColumn(adminSupabase, 'id', id);
    if (directPost) {
      return directPost;
    }

    return findPostReferenceByColumn(adminSupabase, 'generation_id', id);
  } catch (error) {
    if (!isMissingPostsSchemaError(error)) {
      throw error;
    }

    return findLegacyGenerationReference(adminSupabase, id);
  }
}

export async function findPublicPostReferenceByIdOrGenerationId(
  id: string,
  adminSupabase = createServiceClient()
): Promise<PostReferenceRow | null> {
  const post = await findPostReferenceByIdOrGenerationId(id, adminSupabase);
  if (
    !post ||
    post.visibility !== 'public' ||
    post.archived_at ||
    post.review_status !== 'visible'
  ) {
    return null;
  }

  return post;
}

export interface MarketplaceAssetSummaryHydration {
  assetMap: Map<string, ShowcaseAssetSummary>;
  /**
   * Posts with a published recipe whose summary could not be read: the
   * summaries call failed, or answered with rows this code does not trust.
   * Each may sell its prompt and Remix, so a reader serves it as a locked
   * recipe it cannot show, never as a post without one. A draft sells nothing
   * and is never here. When not even which posts have a published recipe can
   * be read, the hydration throws instead, as the NSFW read beside it does.
   */
  unreadRecipePostIds: ReadonlySet<string>;
}

const PUBLIC_BUNDLE_SUMMARY_RPC = 'get_public_post_resource_bundle_summaries';
const PRIVATE_BUNDLE_SUMMARY_FIELDS = [
  'id',
  'title',
  'access_mode',
  'price_usd_cents',
  'preview_text',
  'prompt_text',
  'notes_markdown',
  'workflow_share_url',
  'workflow_snapshot',
  'attachments',
  'allow_remix',
  'resource_sections',
  'resource_items',
  'sales_count',
  'free_unlock_count',
] as const;

function isMissingPublicBundleSummaryRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as SupabaseSchemaError;
  const errorText = [candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  return (
    candidate.code === '42883' || candidate.code === 'PGRST202'
  ) && errorText.includes(PUBLIC_BUNDLE_SUMMARY_RPC);
}

/** A published row with what a recipe's summary needs; any other published row is a recipe this code cannot show. */
function isReadablePublishedBundleRow(row: Record<string, unknown>): boolean {
  return row.status === 'published' &&
    typeof row.id === 'string' &&
    typeof row.post_id === 'string' &&
    typeof row.title === 'string' &&
    (row.access_mode === 'free' || row.access_mode === 'paid') &&
    typeof row.price_usd_cents === 'number';
}

function buildMarketplaceAssetSummaryMap(
  bundleRows: Array<Record<string, unknown>>
): Map<string, ShowcaseAssetSummary> {
  return new Map(
    bundleRows
      .filter(isReadablePublishedBundleRow)
      .map((row) => {
        const salesCount = typeof row.sales_count === 'number' ? row.sales_count : 0;
        // Absent from the missing-RPC fallback's select, which serves only a
        // database that predates both the RPC and this column.
        const freeUnlockCount = typeof row.free_unlock_count === 'number' ? row.free_unlock_count : 0;
        const legacyResources: Partial<PostResourceBundleResources> = {
          promptText: typeof row.prompt_text === 'string' ? row.prompt_text : null,
          notesMarkdown: typeof row.notes_markdown === 'string' ? row.notes_markdown : null,
          workflowShareUrl: typeof row.workflow_share_url === 'string' ? row.workflow_share_url : null,
          workflowSnapshot: row.workflow_snapshot as PostResourceBundleResources['workflowSnapshot'],
          attachments: normalizePostResourceAttachments(row.attachments),
          allowRemix: Boolean(row.allow_remix),
          sections: normalizePostResourceSections((row as { resource_sections?: unknown }).resource_sections),
        };
        const resourceItems = normalizePostResourceItems((row as { resource_items?: unknown }).resource_items, legacyResources);
        const normalizedResources = {
          ...legacyResources,
          items: resourceItems,
        };
        // Public surfaces serve this summary, so its preview is the teaser from
        // the start (counts, kinds, generic names): a read that forgot to
        // sanitize has none of the creator's titles, cards, files or sizes.
        const lockedPreview = sanitizePostResourceBundleLockedPreview(
          buildPostResourceBundleLockedPreview(normalizedResources),
        )!;
        const resourceKinds = getPostResourceKinds(normalizedResources);

        return [
          row.post_id as string,
          {
            id: row.id as string,
            postId: row.post_id as string,
            title: row.title as string,
            accessMode: row.access_mode as ShowcaseAssetSummary['accessMode'],
            priceUsdCents: row.price_usd_cents as number,
            previewText: typeof row.preview_text === 'string' ? row.preview_text : '',
            allowRemix: Boolean(row.allow_remix || resourceItems.some((item) => item.type === 'remix_access' || item.remixUse === 'direct_remix')),
            ...(salesCount > 0 ? { salesCount } : {}),
            ...(freeUnlockCount > 0 ? { freeUnlockCount } : {}),
            resourceKinds,
            itemCounts: lockedPreview.itemCounts,
            lockedPreview,
          } satisfies ShowcaseAssetSummary,
        ] as const;
      })
  );
}

/** The summaries of the published recipes among `rows`, and the published ones it could not read. */
function hydrateBundleSummaryRows(rows: Array<Record<string, unknown>>): MarketplaceAssetSummaryHydration {
  const assetMap = buildMarketplaceAssetSummaryMap(rows);
  const unreadRecipePostIds = new Set(
    rows
      .filter((row) => row.status === 'published' && typeof row.post_id === 'string' && !assetMap.has(row.post_id))
      .map((row) => row.post_id as string)
  );
  if (unreadRecipePostIds.size > 0) {
    logBackendError('published_post_resource_bundle_summary_unreadable', { count: unreadRecipePostIds.size });
  }
  return { assetMap, unreadRecipePostIds };
}

/** The summaries call's rows, or null when they cannot be trusted. */
function hydratePublicBundleSummaryRows(
  rows: Array<Record<string, unknown>>
): MarketplaceAssetSummaryHydration | null {
  for (const row of rows) {
    if (typeof row.post_id !== 'string') {
      logBackendError('public_bundle_summary_rpc_returned_a_row_without_a_post_id');
      return null;
    }
    if (
      row.status !== 'published' &&
      PRIVATE_BUNDLE_SUMMARY_FIELDS.some((field) => row[field] !== null && row[field] !== undefined)
    ) {
      logBackendError('public_bundle_summary_rpc_returned_details_for_a_non_published_bundle');
      return null;
    }
  }

  return hydrateBundleSummaryRows(rows);
}

/**
 * Which of `postIds` have a published recipe, read on its own: the status of
 * each post's recipe row and nothing else. Null when the bundles table is
 * missing (a database that predates recipes). A read that fails throws: then
 * no post can be told apart from one that sells its prompt.
 */
async function loadPublishedBundlePostIds(
  postIds: string[],
  adminSupabase: SupabaseClient
): Promise<string[] | null> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('post_id, status')
    .in('post_id', postIds);

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) return null;
    logBackendError('failed_to_load_post_resource_bundle_presence', { error: error });
    throw error;
  }

  return ((data ?? []) as unknown as Array<Record<string, unknown>>)
    .filter((row) => row.status === 'published' && typeof row.post_id === 'string')
    .map((row) => row.post_id as string);
}

/**
 * The summaries could not be read or trusted. Only the posts that have a
 * published recipe are served locked: one failed call must neither leak a
 * recipe nor lock every post it was asked about, which would empty the home
 * shelf and send the Remixable lane through the whole catalog.
 */
async function lockPublishedRecipes(
  postIds: string[],
  adminSupabase: SupabaseClient
): Promise<MarketplaceAssetSummaryHydration> {
  const publishedPostIds = await loadPublishedBundlePostIds(postIds, adminSupabase);
  if (!publishedPostIds) return getLegacyMarketplaceAssetSummaryHydration(postIds, adminSupabase);
  return { assetMap: new Map(), unreadRecipePostIds: new Set(publishedPostIds) };
}

async function getMarketplaceAssetSummaryHydrationFallback(
  postIds: string[],
  adminSupabase: SupabaseClient
): Promise<MarketplaceAssetSummaryHydration | null> {
  const publishedPostIds = await loadPublishedBundlePostIds(postIds, adminSupabase);
  if (!publishedPostIds) return null;
  if (publishedPostIds.length === 0) {
    return { assetMap: new Map(), unreadRecipePostIds: new Set() };
  }

  const bundleSelectWithItems =
    'id, post_id, title, access_mode, price_usd_cents, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, resource_sections, resource_items, sales_count, status';
  const bundleSelectLegacy =
    'id, post_id, title, access_mode, price_usd_cents, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, sales_count, status';
  const loadPublishedBundles = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .in('post_id', publishedPostIds)
      .eq('status', 'published');

  let bundleResult = await loadPublishedBundles(bundleSelectWithItems);
  if (isMissingPostResourceItemsColumnError(bundleResult.error)) {
    bundleResult = await loadPublishedBundles(bundleSelectLegacy);
  }

  if (bundleResult.error) {
    // These recipes were just read as published, so whatever failed, they are
    // served locked rather than as posts without one.
    logBackendError('failed_to_load_published_post_resource_bundle_summaries', { error: bundleResult.error });
    return { assetMap: new Map(), unreadRecipePostIds: new Set(publishedPostIds) };
  }

  return hydrateBundleSummaryRows((bundleResult.data ?? []) as unknown as Array<Record<string, unknown>>);
}

async function getLegacyMarketplaceAssetSummaryHydration(
  postIds: string[],
  adminSupabase: SupabaseClient
): Promise<MarketplaceAssetSummaryHydration> {
  const { data, error } = await adminSupabase
    .from('marketplace_assets')
    .select('id, post_id, title, price_usd_cents, status')
    .in('post_id', postIds)
    .eq('status', 'active');

  if (error) {
    if (isMissingMarketplaceSchemaError(error)) {
      return { assetMap: new Map(), unreadRecipePostIds: new Set() };
    }
    logBackendError('failed_to_load_legacy_marketplace_asset_summaries', { error: error });
    throw error;
  }

  const rows = data ?? [];
  const readableRows = rows.filter((row) =>
    typeof row.id === 'string' &&
    typeof row.post_id === 'string' &&
    typeof row.title === 'string' &&
    typeof row.price_usd_cents === 'number'
  );
  return {
    assetMap: new Map(
      readableRows.map((row) => [
        row.post_id as string,
        {
          id: row.id as string,
          postId: row.post_id as string,
          title: row.title as string,
          accessMode: (row.price_usd_cents as number) === 0 ? 'free' : 'paid',
          priceUsdCents: row.price_usd_cents as number,
          previewText: '',
          allowRemix: false,
          salesCount: 0,
          resourceKinds: [],
        } satisfies ShowcaseAssetSummary,
      ])
    ),
    unreadRecipePostIds: new Set(
      rows
        .filter((row) => typeof row.post_id === 'string' && !readableRows.includes(row))
        .map((row) => row.post_id as string)
    ),
  };
}

export async function getMarketplaceAssetSummaryHydration(
  postIds: string[],
  adminSupabase = createServiceClient()
): Promise<MarketplaceAssetSummaryHydration> {
  if (postIds.length === 0) {
    return { assetMap: new Map(), unreadRecipePostIds: new Set() };
  }

  const rpc = (adminSupabase as unknown as {
    rpc?: (
      name: string,
      params: { p_post_ids: string[] }
    ) => Promise<{ data: unknown; error: unknown }>;
  }).rpc;
  if (typeof rpc === 'function') {
    const { data, error } = await rpc.call(adminSupabase, PUBLIC_BUNDLE_SUMMARY_RPC, {
      p_post_ids: postIds,
    });
    if (!error) {
      if (!Array.isArray(data)) {
        logBackendError('public_bundle_summary_rpc_returned_an_invalid_response');
        return lockPublishedRecipes(postIds, adminSupabase);
      }
      return hydratePublicBundleSummaryRows(data as Array<Record<string, unknown>>)
        ?? lockPublishedRecipes(postIds, adminSupabase);
    }
    if (!isMissingPublicBundleSummaryRpcError(error)) {
      logBackendError('failed_to_load_public_post_resource_bundle_summaries', { error: error });
      return lockPublishedRecipes(postIds, adminSupabase);
    }
  }

  // Rolling-deploy compatibility: older databases do not have the RPC. Read
  // presence/status first, then request detailed columns only for rows the
  // database has already identified as published.
  const fallbackHydration = await getMarketplaceAssetSummaryHydrationFallback(
    postIds,
    adminSupabase
  );
  if (fallbackHydration) return fallbackHydration;

  return getLegacyMarketplaceAssetSummaryHydration(postIds, adminSupabase);
}
