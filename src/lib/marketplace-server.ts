import 'server-only';

import { cache } from 'react';

import { convertFromUsd, formatMoney } from '@/lib/currency';
import type {
  MarketplacePriceQuote,
  MarketplaceSort,
} from '@/lib/marketplace';
import { createServiceClient } from '@/lib/server-helpers';
import {
  deriveTitleFromBody,
  getPostMediaKind,
  isMissingMarketplaceSchemaError,
  isMissingPostTextColumnsError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
  resolvePostMediaUrl,
  type PostMediaRow,
} from '@/lib/posts-server';
import { getCreatorDisplayName } from '@/lib/profile';
import type {
  ShowcaseAssetType,
  ShowcaseItemCategory,
  ShowcaseMediaKind,
  ShowcasePostFormat,
  ShowcaseSourceKind,
  ShowcaseVisibility,
} from '@/lib/showcase';
import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type SerializedWorkflowCanvasGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

type MarketplaceAssetStatus = 'draft' | 'active' | 'unlisted' | 'deleted';
type CheckoutCurrency = 'INR' | 'USD';

interface MarketplaceAssetRow {
  id: string;
  seller_user_id: string;
  post_id: string | null;
  type: ShowcaseAssetType;
  title: string;
  description: string;
  preview: string;
  price_usd_cents: number;
  status: MarketplaceAssetStatus;
  sales_count: number;
  earnings_usd_cents: number;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface MarketplacePostRow extends PostMediaRow {
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
  asset_id: string;
  buyer_user_id: string;
  order_id: string;
  price_usd_cents: number;
  amount_subunits: number;
  currency: CheckoutCurrency;
  created_at: string;
}

interface AssetContentRow {
  workflow_graph: Partial<WorkflowCanvasGraph> | null;
  prompt_pack: string | null;
  guide_markdown: string | null;
}

interface WorkflowCanvasListRow {
  id: string;
  title: string;
  updated_at: string;
  status: 'draft' | 'published';
}

type LinkedPostScope = 'public' | 'owner';

export interface MarketplaceSellerSummary {
  id: string;
  username: string | null;
  name: string;
  avatar: string | null;
}

export interface MarketplaceLinkedPost {
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

export interface MarketplaceAssetListItem {
  id: string;
  type: ShowcaseAssetType;
  title: string;
  description: string;
  preview: string;
  priceUsdCents: number;
  status: MarketplaceAssetStatus;
  salesCount: number;
  earningsUsdCents: number;
  createdAt: string;
  updatedAt: string;
  seller: MarketplaceSellerSummary;
  post: MarketplaceLinkedPost | null;
  priceQuote: MarketplacePriceQuote;
}

export interface MarketplaceAssetContent {
  workflowGraph: SerializedWorkflowCanvasGraph | null;
  promptPack: string | null;
  guideMarkdown: string | null;
}

export interface MarketplaceAssetDetail extends MarketplaceAssetListItem {
  viewerHasPurchased: boolean;
  viewerIsSeller: boolean;
  viewerCanAccess: boolean;
  content: MarketplaceAssetContent | null;
}

export interface MarketplaceAssetListPage {
  items: MarketplaceAssetListItem[];
  pageInfo: {
    hasMore: boolean;
    nextOffset: number | null;
    offset: number;
    limit: number;
  };
}

export interface SellerPostOption {
  id: string;
  title: string;
  category: ShowcaseItemCategory;
  visibility: ShowcaseVisibility;
  createdAt: string;
  linkedAssetId: string | null;
}

export interface SellerWorkflowCanvasOption {
  id: string;
  title: string;
  updatedAt: string;
  status: 'draft' | 'published';
}

export interface SellerSaleRecord {
  id: string;
  assetId: string;
  assetTitle: string;
  buyerUserId: string;
  buyerLabel: string;
  priceUsdCents: number;
  amountSubunits: number;
  currency: CheckoutCurrency;
  createdAt: string;
}

export interface SellerMarketplaceDashboard {
  listings: MarketplaceAssetListItem[];
  posts: SellerPostOption[];
  workflowCanvases: SellerWorkflowCanvasOption[];
  sales: SellerSaleRecord[];
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
    console.error('Failed to load marketplace FX rates:', error);
    return null;
  }
});

function toSellerSummary(
  userId: string,
  profilesMap: Map<string, ProfileRow>
): MarketplaceSellerSummary {
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
    console.error('Failed to load marketplace profiles:', error);
    return new Map();
  }

  return new Map(
    (data ?? [])
      .filter((row): row is ProfileRow => typeof row.id === 'string')
      .map((row) => [row.id, row])
  );
}

async function loadPostMap(
  postIds: string[],
  scope: LinkedPostScope = 'public'
) {
  const uniquePostIds = Array.from(new Set(postIds.filter(Boolean)));
  if (uniquePostIds.length === 0) {
    return new Map<string, MarketplaceLinkedPost>();
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

  let rows: MarketplacePostRow[] = [];

  if (isMissingPostTextColumnsError(result.error)) {
    let legacyResultQuery = adminSupabase
      .from('posts')
      .select('id, title, category, visibility, showcase_asset_path, output_url, source_kind, source_tool')
      .in('id', uniquePostIds);
    if (scope === 'public') {
      legacyResultQuery = legacyResultQuery.eq('visibility', 'public');
    }
    const legacyResult = await legacyResultQuery;

    if (legacyResult.error) {
      if (!isMissingPostsSchemaError(legacyResult.error)) {
        console.error('Failed to load marketplace posts:', legacyResult.error);
      }
      return new Map();
    }

    rows = ((legacyResult.data ?? []) as Array<Omit<MarketplacePostRow, 'body' | 'post_format'>>).map((row) => ({
      ...row,
      body: null,
      post_format: normalizeLegacyPostFormat(row.category),
    }));
  } else if (result.error) {
    if (!isMissingPostsSchemaError(result.error)) {
      console.error('Failed to load marketplace posts:', result.error);
    }
    return new Map();
  } else {
    rows = (result.data ?? []) as MarketplacePostRow[];
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

async function hydrateAssetRows(
  rows: MarketplaceAssetRow[],
  countryCode?: string | null,
  options?: {
    linkedPostScope?: LinkedPostScope;
  }
): Promise<MarketplaceAssetListItem[]> {
  const linkedPostScope = options?.linkedPostScope ?? 'public';
  const profilesMap = await loadProfileMap(rows.map((row) => row.seller_user_id));
  const postMap = await loadPostMap(
    rows.map((row) => row.post_id).filter(Boolean) as string[],
    linkedPostScope
  );

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      description: row.description,
      preview: row.preview,
      priceUsdCents: row.price_usd_cents,
      status: row.status,
      salesCount: row.sales_count,
      earningsUsdCents: row.earnings_usd_cents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      seller: toSellerSummary(row.seller_user_id, profilesMap),
      post: row.post_id ? postMap.get(row.post_id) ?? null : null,
      priceQuote: await buildPriceQuote(row.price_usd_cents, countryCode),
    }))
  );
}

function canViewerSeeAsset(
  row: MarketplaceAssetRow,
  viewerUserId?: string | null
): boolean {
  return row.status === 'active' || row.status === 'unlisted' || row.seller_user_id === viewerUserId;
}

export async function getMarketplacePriceQuote(
  priceUsdCents: number,
  countryCode?: string | null
): Promise<MarketplacePriceQuote> {
  return buildPriceQuote(priceUsdCents, countryCode);
}

export async function getMarketplaceAssetList(options?: {
  type?: ShowcaseAssetType | 'all';
  sort?: MarketplaceSort;
  offset?: number;
  limit?: number;
  countryCode?: string | null;
}): Promise<MarketplaceAssetListPage> {
  const {
    type = 'all',
    sort = 'recent',
    offset = 0,
    limit = 24,
    countryCode = null,
  } = options ?? {};
  const adminSupabase = createServiceClient();

  let query = adminSupabase
    .from('marketplace_assets')
    .select('id, seller_user_id, post_id, type, title, description, preview, price_usd_cents, status, sales_count, earnings_usd_cents, created_at, updated_at')
    .eq('status', 'active');

  if (type !== 'all') {
    query = query.eq('type', type);
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
    if (isMissingMarketplaceSchemaError(error)) {
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

    console.error('Failed to load marketplace asset list:', error);
    throw error;
  }

  const rows = (data ?? []) as MarketplaceAssetRow[];
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: await hydrateAssetRows(visibleRows, countryCode),
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      offset,
      limit,
    },
  };
}

export async function getMarketplaceAssetDetail(
  assetId: string,
  options?: {
    viewerUserId?: string | null;
    countryCode?: string | null;
  }
): Promise<MarketplaceAssetDetail | null> {
  const { viewerUserId = null, countryCode = null } = options ?? {};
  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase
    .from('marketplace_assets')
    .select('id, seller_user_id, post_id, type, title, description, preview, price_usd_cents, status, sales_count, earnings_usd_cents, created_at, updated_at')
    .eq('id', assetId)
    .maybeSingle();

  if (error) {
    if (isMissingMarketplaceSchemaError(error)) {
      return null;
    }

    console.error('Failed to load marketplace asset detail:', error);
    throw error;
  }

  const row = (data as MarketplaceAssetRow | null) ?? null;
  if (!row || !canViewerSeeAsset(row, viewerUserId)) {
    return null;
  }

  const viewerIsSeller = Boolean(viewerUserId && viewerUserId === row.seller_user_id);
  const [item] = await hydrateAssetRows([row], countryCode, {
    linkedPostScope: viewerIsSeller ? 'owner' : 'public',
  });
  let viewerHasPurchased = false;

  if (viewerUserId && !viewerIsSeller) {
    const { data: purchase, error: purchaseError } = await adminSupabase
      .from('marketplace_purchases')
      .select('asset_id')
      .eq('asset_id', assetId)
      .eq('buyer_user_id', viewerUserId)
      .maybeSingle();

    if (purchaseError) {
      console.error('Failed to load marketplace purchase state:', purchaseError);
    } else {
      viewerHasPurchased = Boolean(purchase);
    }
  }

  const viewerCanAccess = viewerIsSeller || viewerHasPurchased;
  let content: MarketplaceAssetContent | null = null;

  if (viewerCanAccess) {
    const { data: contentRow, error: contentError } = await adminSupabase
      .from('marketplace_asset_content')
      .select('workflow_graph, prompt_pack, guide_markdown')
      .eq('asset_id', assetId)
      .maybeSingle();

    if (contentError) {
      console.error('Failed to load marketplace asset content:', contentError);
    } else if (contentRow) {
      const typedContent = contentRow as AssetContentRow;
      content = {
        workflowGraph: typedContent.workflow_graph
          ? serializeWorkflowGraph(normalizeWorkflowGraph(typedContent.workflow_graph))
          : null,
        promptPack: typedContent.prompt_pack,
        guideMarkdown: typedContent.guide_markdown,
      };
    }
  }

  return {
    ...item,
    viewerHasPurchased,
    viewerIsSeller,
    viewerCanAccess,
    content,
  };
}

export async function getSellerMarketplaceDashboard(
  userId: string,
  options?: {
    countryCode?: string | null;
  }
): Promise<SellerMarketplaceDashboard> {
  const countryCode = options?.countryCode ?? null;
  const adminSupabase = createServiceClient();
  const { data: assetData, error: assetsError } = await adminSupabase
    .from('marketplace_assets')
    .select('id, seller_user_id, post_id, type, title, description, preview, price_usd_cents, status, sales_count, earnings_usd_cents, created_at, updated_at')
    .eq('seller_user_id', userId)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false });

  if (assetsError) {
    if (isMissingMarketplaceSchemaError(assetsError)) {
      return {
        listings: [],
        posts: [],
        workflowCanvases: [],
        sales: [],
        totalSalesCount: 0,
        totalEarningsUsdCents: 0,
      };
    }

    console.error('Failed to load seller marketplace assets:', assetsError);
    throw assetsError;
  }

  const assetRows = (assetData ?? []) as MarketplaceAssetRow[];
  const listings = await hydrateAssetRows(assetRows, countryCode, {
    linkedPostScope: 'owner',
  });
  const assetIdToTitle = new Map(assetRows.map((row) => [row.id, row.title]));
  const postIdToAssetId = new Map(
    assetRows
      .filter((row) => row.post_id)
      .map((row) => [row.post_id as string, row.id])
  );

  const { data: postData, error: postsError } = await adminSupabase
    .from('posts')
    .select('id, title, category, visibility, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (postsError) {
    console.error('Failed to load seller posts:', postsError);
    throw postsError;
  }

  const posts = (postData ?? []).map((row) => ({
    id: row.id as string,
    title: (typeof row.title === 'string' && row.title.trim()) ? row.title.trim() : 'Untitled creation',
    category: row.category as ShowcaseItemCategory,
    visibility: row.visibility as ShowcaseVisibility,
    createdAt: row.created_at as string,
    linkedAssetId: postIdToAssetId.get(row.id as string) ?? null,
  }));

  const { data: canvasData, error: canvasError } = await adminSupabase
    .from('workflow_canvases')
    .select('id, title, updated_at, status')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (canvasError) {
    console.error('Failed to load seller workflow canvases:', canvasError);
    throw canvasError;
  }

  const workflowCanvases = (canvasData ?? []).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    updatedAt: row.updated_at as string,
    status: row.status as WorkflowCanvasListRow['status'],
  }));

  let sales: SellerSaleRecord[] = [];
  if (assetRows.length > 0) {
    const assetIds = assetRows.map((row) => row.id);
    const { data: purchaseData, error: purchaseError } = await adminSupabase
      .from('marketplace_purchases')
      .select('asset_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency, created_at')
      .in('asset_id', assetIds)
      .order('created_at', { ascending: false });

    if (purchaseError) {
      console.error('Failed to load seller marketplace sales:', purchaseError);
      throw purchaseError;
    }

    const purchases = (purchaseData ?? []) as PurchaseRow[];
    const buyerProfiles = await loadProfileMap(purchases.map((row) => row.buyer_user_id));

    sales = purchases.map((row) => {
      const buyerProfile = buyerProfiles.get(row.buyer_user_id);
      const buyerLabel = buyerProfile?.username
        ? `@${buyerProfile.username}`
        : getCreatorDisplayName({
            displayName: buyerProfile?.display_name ?? null,
            username: buyerProfile?.username ?? null,
            email: row.buyer_user_id,
          });

      return {
        id: `${row.order_id}:${row.asset_id}`,
        assetId: row.asset_id,
        assetTitle: assetIdToTitle.get(row.asset_id) ?? 'Untitled listing',
        buyerUserId: row.buyer_user_id,
        buyerLabel,
        priceUsdCents: row.price_usd_cents,
        amountSubunits: row.amount_subunits,
        currency: row.currency,
        createdAt: row.created_at,
      };
    });
  }

  return {
    listings,
    posts,
    workflowCanvases,
    sales,
    totalSalesCount: assetRows.reduce((sum, row) => sum + row.sales_count, 0),
    totalEarningsUsdCents: assetRows.reduce((sum, row) => sum + row.earnings_usd_cents, 0),
  };
}
