import 'server-only';

import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import { convertFromUsd, formatMoney } from '@/lib/currency';
import {
  deriveTitleFromBody,
  getPostMediaKind,
  isMissingMarketplaceSchemaError,
  isMissingPostResourceBundlesSchemaError,
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
  getPostResourceKinds,
} from '@/lib/post-resource-bundles';
import type {
  MarketplaceCheckoutCurrency,
  MarketplacePriceQuote,
  MarketplaceResourceFilter,
  MarketplaceResourceSort,
  PersistedPostResourceBundleAccessMode,
  PostResourceAttachment,
  PostResourceBundleInput,
  PostResourceBundleResources,
  PostResourceBundleStatus,
  PostResourceKind,
} from '@/lib/post-resource-bundles';
import {
  type ShowcaseItemCategory,
  type ShowcaseMediaKind,
  type ShowcasePostFormat,
  type ShowcaseSourceKind,
  type ShowcaseVisibility,
} from '@/lib/showcase';
import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type SerializedWorkflowCanvasGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

type LinkedPostScope = 'public' | 'owner';

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
  price_usd_cents: number;
  sales_count: number;
  earnings_usd_cents: number;
  created_at: string;
  updated_at: string;
}

interface LinkedPostRow extends PostMediaRow {
  id: string;
  title: string | null;
  body: string | null;
  category: ShowcaseItemCategory;
  post_format: ShowcasePostFormat;
  visibility: ShowcaseVisibility;
  source_kind: ShowcaseSourceKind;
  source_tool: string | null;
}

interface PurchaseRow {
  bundle_id: string;
  buyer_user_id: string;
}

interface OrderRow {
  bundle_id: string;
  buyer_user_id: string;
  legacy_order_id: string | null;
  id: string;
  amount_subunits: number;
  currency: MarketplaceCheckoutCurrency;
  created_at: string;
}

export interface PostResourceBundleSellerSummary {
  id: string;
  username: string | null;
  name: string;
  avatar: string | null;
}

export interface PostResourceBundleLinkedPost {
  id: string;
  title: string;
  category: ShowcaseItemCategory;
  body: string;
  postFormat: ShowcasePostFormat;
  visibility: ShowcaseVisibility;
  sourceKind: ShowcaseSourceKind;
  sourceTool: string | null;
  mediaUrl: string | null;
  mediaKind: ShowcaseMediaKind | null;
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
  createdAt: string;
  updatedAt: string;
  seller: PostResourceBundleSellerSummary;
  post: PostResourceBundleLinkedPost | null;
  priceQuote: MarketplacePriceQuote;
}

export interface PostResourceBundleDetail extends MarketplaceResourceListItem {
  status: PostResourceBundleStatus;
  resources: PostResourceBundleResources | null;
  viewerIsOwner: boolean;
  viewerHasPurchased: boolean;
  viewerCanAccess: boolean;
}

export interface SellerPostResourceBundleDashboard {
  bundles: MarketplaceResourceListItem[];
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

function normalizeAttachments(value: unknown): PostResourceAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const label = typeof item.label === 'string' ? item.label.trim() : '';
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      if (!url) {
        return null;
      }

      return {
        label: label || url,
        url,
      } satisfies PostResourceAttachment;
    })
    .filter((item): item is PostResourceAttachment => item !== null);
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
    .select('id, title, body, category, post_format, visibility, showcase_asset_path, output_url, source_kind, source_tool')
    .in('id', uniquePostIds);

  if (scope === 'public') {
    resultQuery = resultQuery.eq('visibility', 'public');
  }

  const result = await resultQuery;
  let rows: LinkedPostRow[] = [];

  if (isMissingPostTextColumnsError(result.error)) {
    let legacyQuery = adminSupabase
      .from('posts')
      .select('id, title, category, visibility, showcase_asset_path, output_url, source_kind, source_tool')
      .in('id', uniquePostIds);

    if (scope === 'public') {
      legacyQuery = legacyQuery.eq('visibility', 'public');
    }

    const legacyResult = await legacyQuery;
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
      title: row.title?.trim() || deriveTitleFromBody(row.body) || (row.post_format === 'text' ? 'Untitled note' : 'Untitled creation'),
      category: row.category,
      body: row.body?.trim() || '',
      postFormat: row.post_format,
      visibility: row.visibility,
      sourceKind: row.source_kind,
      sourceTool: row.source_tool,
      mediaUrl: await resolvePostMediaUrl(adminSupabase, row),
      mediaKind: getPostMediaKind(row.category, row.post_format),
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
        resourceKinds: getPostResourceKinds(normalizedResources),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        seller: toSellerSummary(row.owner_user_id, profilesMap),
        post: postMap.get(row.post_id) ?? null,
        priceQuote: await buildPriceQuote(row.price_usd_cents, countryCode),
      };
    })
  );
}

function normalizeResources(row: BundleRow): PostResourceBundleResources {
  return {
    promptText: normalizeText(row.prompt_text),
    notesMarkdown: normalizeText(row.notes_markdown),
    workflowShareUrl: normalizeText(row.workflow_share_url),
    workflowSnapshot: row.workflow_snapshot
      ? serializeWorkflowGraph(normalizeWorkflowGraph(row.workflow_snapshot))
      : null,
    attachments: normalizeAttachments(row.attachments),
    allowRemix: Boolean(row.allow_remix),
  };
}

export function isBundlePublishedForMarketplace(row: BundleRow): boolean {
  return row.status === 'published';
}

export function canViewerAccessBundle(row: BundleRow, viewerUserId?: string | null, viewerHasPurchased = false): boolean {
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
  const status: PostResourceBundleStatus = postVisibility === 'public' ? 'published' : 'draft';
  const normalizedTitle = normalizeText(postTitle) ?? 'Attached resources';
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
    attachments: resources.attachments ?? [],
    allow_remix: Boolean(resources.allowRemix),
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

export async function getMarketplaceResourceList(options?: {
  filter?: MarketplaceResourceFilter;
  sort?: MarketplaceResourceSort;
  offset?: number;
  limit?: number;
  countryCode?: string | null;
}) {
  const {
    filter = 'all',
    sort = 'recent',
    offset = 0,
    limit = 24,
    countryCode = null,
  } = options ?? {};

  const adminSupabase = createServiceClient();
  let query = adminSupabase
    .from('post_resource_bundles')
    .select('id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at')
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
  } else {
    query = query.order('created_at', { ascending: false });
  }

  const { data, error } = await query.range(offset, offset + limit);
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

  const rows = (data ?? []) as BundleRow[];
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: await hydrateBundleRows(visibleRows, countryCode),
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
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
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at')
    .eq('post_id', postId)
    .maybeSingle();

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

  return {
    ...hydrated,
    status: row.status,
    resources: viewerCanAccess ? normalizeResources(row) : null,
    viewerHasPurchased,
    viewerIsOwner,
    viewerCanAccess,
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
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at')
    .eq('owner_user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return {
        bundles: [],
        sales: [],
        totalSalesCount: 0,
        totalEarningsUsdCents: 0,
      };
    }

    console.error('Failed to load seller resource bundles:', error);
    throw error;
  }

  const rows = (data ?? []) as BundleRow[];
  const bundles = await hydrateBundleRows(rows, countryCode, 'owner');
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
        bundleTitle: bundleIdToTitle.get(row.bundle_id) ?? 'Attached resources',
        buyerUserId: row.buyer_user_id,
        buyerLabel,
        amountSubunits: row.amount_subunits,
        currency: row.currency,
        createdAt: row.created_at,
      };
    });
  }

  return {
    bundles,
    sales,
    totalSalesCount: rows.reduce((sum, row) => sum + row.sales_count, 0),
    totalEarningsUsdCents: rows.reduce((sum, row) => sum + row.earnings_usd_cents, 0),
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

export async function getBundleForOrderById(bundleId: string): Promise<BundleRow | null> {
  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at')
    .eq('id', bundleId)
    .maybeSingle();

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return null;
    }

    console.error('Failed to load bundle by id:', error);
    throw error;
  }

  return (data as BundleRow | null) ?? null;
}

export async function getBundleForOrderByPostId(postId: string): Promise<BundleRow | null> {
  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at')
    .eq('post_id', postId)
    .maybeSingle();

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return null;
    }

    console.error('Failed to load bundle by post id:', error);
    throw error;
  }

  return (data as BundleRow | null) ?? null;
}
