import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import {
  buildPostResourceBundleLockedPreview,
  getPostResourceKinds,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
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
}

export interface PostMediaRow {
  showcase_asset_path: string | null;
  output_url: string | null;
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

  return firstLine.slice(0, 80);
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
    console.error('Failed to resolve legacy generation reference:', error);
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
  const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(showcaseAssetPath);
  return data.publicUrl;
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

  if (row.output_url.startsWith('http')) {
    return row.output_url;
  }

  return resolveStoredMediaUrl(adminSupabase, row.output_url);
}

async function findPostReferenceByColumn(
  adminSupabase: SupabaseClient,
  column: 'id' | 'generation_id',
  value: string
): Promise<PostReferenceRow | null> {
  let result = await adminSupabase
    .from('posts')
    .select('id, user_id, generation_id, visibility, category, prompt, title, source_kind')
    .eq(column, value)
    .maybeSingle();

  if (isMissingPostTextColumnsError(result.error)) {
    result = await adminSupabase
      .from('posts')
      .select('id, user_id, generation_id, visibility, category, prompt, source_kind')
      .eq(column, value)
      .maybeSingle();
  }

  if (result.error) {
    console.error(`Failed to resolve post by ${column}:`, result.error);
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
  if (!post || post.visibility !== 'public') {
    return null;
  }

  return post;
}

export interface MarketplaceAssetSummaryHydration {
  assetMap: Map<string, ShowcaseAssetSummary>;
  knownBundlePostIds: ReadonlySet<string> | null;
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

function failClosedMarketplaceAssetSummaryHydration(postIds: string[]): MarketplaceAssetSummaryHydration {
  return {
    assetMap: new Map(),
    // Treat every requested post as potentially bundled until bundle presence can
    // be established. This prevents a database error from synthesizing a public
    // recipe over an intentional draft bundle.
    knownBundlePostIds: new Set(postIds),
  };
}

function buildMarketplaceAssetSummaryMap(
  bundleRows: Array<Record<string, unknown>>
): Map<string, ShowcaseAssetSummary> {
  return new Map(
    bundleRows
      .filter((row) => row.status === 'published')
      .filter((row) =>
        typeof row.id === 'string' &&
        typeof row.post_id === 'string' &&
        typeof row.title === 'string' &&
        (row.access_mode === 'free' || row.access_mode === 'paid') &&
        typeof row.price_usd_cents === 'number'
      )
      .map((row) => {
        const salesCount = typeof row.sales_count === 'number' ? row.sales_count : 0;
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
        const lockedPreview = buildPostResourceBundleLockedPreview(normalizedResources);
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
            resourceKinds,
            itemCounts: lockedPreview.itemCounts,
            lockedPreview,
          } satisfies ShowcaseAssetSummary,
        ] as const;
      })
  );
}

function hydratePublicBundleSummaryRows(
  rows: Array<Record<string, unknown>>,
  postIds: string[]
): MarketplaceAssetSummaryHydration {
  const knownBundlePostIds = new Set<string>();
  for (const row of rows) {
    if (typeof row.post_id !== 'string') {
      console.error('Public bundle summary RPC returned a row without a post id.');
      return failClosedMarketplaceAssetSummaryHydration(postIds);
    }
    knownBundlePostIds.add(row.post_id);
    if (
      row.status !== 'published' &&
      PRIVATE_BUNDLE_SUMMARY_FIELDS.some((field) => row[field] !== null && row[field] !== undefined)
    ) {
      console.error('Public bundle summary RPC returned details for a non-published bundle.');
      return failClosedMarketplaceAssetSummaryHydration(postIds);
    }
  }

  return {
    assetMap: buildMarketplaceAssetSummaryMap(rows),
    knownBundlePostIds,
  };
}

async function getMarketplaceAssetSummaryHydrationFallback(
  postIds: string[],
  adminSupabase: SupabaseClient
): Promise<MarketplaceAssetSummaryHydration | null> {
  const { data: presenceData, error: presenceError } = await adminSupabase
    .from('post_resource_bundles')
    .select('post_id, status')
    .in('post_id', postIds);

  if (presenceError) {
    if (isMissingPostResourceBundlesSchemaError(presenceError)) return null;
    console.error('Failed to load post resource bundle presence:', presenceError);
    return failClosedMarketplaceAssetSummaryHydration(postIds);
  }

  const presenceRows = (presenceData ?? []) as unknown as Array<Record<string, unknown>>;
  const knownBundlePostIds = new Set(
    presenceRows
      .map((row) => row.post_id)
      .filter((postId): postId is string => typeof postId === 'string')
  );
  const publishedPostIds = presenceRows
    .filter((row) => row.status === 'published')
    .map((row) => row.post_id)
    .filter((postId): postId is string => typeof postId === 'string');

  if (publishedPostIds.length === 0) {
    return { assetMap: new Map(), knownBundlePostIds };
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
    if (isMissingPostResourceBundlesSchemaError(bundleResult.error)) return null;
    console.error('Failed to load published post resource bundle summaries:', bundleResult.error);
    return { assetMap: new Map(), knownBundlePostIds };
  }

  return {
    assetMap: buildMarketplaceAssetSummaryMap(
      (bundleResult.data ?? []) as unknown as Array<Record<string, unknown>>
    ),
    knownBundlePostIds,
  };
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
    if (!isMissingMarketplaceSchemaError(error)) {
      console.error('Failed to load legacy marketplace asset summaries:', error);
    }
    return {
      assetMap: new Map(),
      knownBundlePostIds: null,
    };
  }

  return {
    assetMap: new Map(
      (data ?? [])
        .filter((row) =>
          typeof row.id === 'string' &&
          typeof row.post_id === 'string' &&
          typeof row.title === 'string' &&
          typeof row.price_usd_cents === 'number'
        )
        .map((row) => [
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
    knownBundlePostIds: null,
  };
}

export async function getMarketplaceAssetSummaryHydration(
  postIds: string[],
  adminSupabase = createServiceClient()
): Promise<MarketplaceAssetSummaryHydration> {
  if (postIds.length === 0) {
    return {
      assetMap: new Map(),
      knownBundlePostIds: new Set(),
    };
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
        console.error('Public bundle summary RPC returned an invalid response.');
        return failClosedMarketplaceAssetSummaryHydration(postIds);
      }
      return hydratePublicBundleSummaryRows(
        data as Array<Record<string, unknown>>,
        postIds
      );
    }
    if (!isMissingPublicBundleSummaryRpcError(error)) {
      console.error('Failed to load public post resource bundle summaries:', error);
      return failClosedMarketplaceAssetSummaryHydration(postIds);
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

export async function getMarketplaceAssetSummaryMap(
  postIds: string[],
  adminSupabase = createServiceClient()
): Promise<Map<string, ShowcaseAssetSummary>> {
  const { assetMap } = await getMarketplaceAssetSummaryHydration(postIds, adminSupabase);
  return assetMap;
}
