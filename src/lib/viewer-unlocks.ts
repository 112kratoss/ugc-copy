import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadNsfwPostIds } from '@/lib/nsfw-content-server';
import { loadPostMediaItemsMap } from '@/lib/post-media';
import { getPostMediaKind, resolvePostMediaUrl } from '@/lib/posts-server';
import { getCreatorDisplayName } from '@/lib/profile';
import { purchasedProofMediaUrl } from '@/lib/purchased-proof-media';
import type {
  PersistedPostResourceBundleAccessMode,
} from '@/lib/post-resource-bundles';
import type {
  ShowcaseItemCategory,
  ShowcaseMediaKind,
  ShowcasePostFormat,
} from '@/lib/showcase';

export const VIEWER_UNLOCKS_DEFAULT_PAGE_SIZE = 24;
export const VIEWER_UNLOCKS_MAX_PAGE_SIZE = 48;

export type ViewerUnlockPaidWith = 'credits' | 'cash' | 'free';

/** What the buyer paid, as their purchase recorded it. */
export interface ViewerUnlockPayment {
  paidWith: ViewerUnlockPaidWith;
  /** Credits spent, or the cash amount in minor units (paise, cents); null for a free unlock. */
  paidAmountSubunits: number | null;
  /** The cash currency ('INR' or 'USD'); null for credits and free unlocks. */
  paidCurrency: string | null;
}

export interface ViewerUnlockItem extends ViewerUnlockPayment {
  /** Permanent entitlement identity. Bundle and post are only live context. */
  unlockId: string;
  bundleId: string | null;
  postId: string | null;
  title: string;
  previewText: string;
  accessMode: PersistedPostResourceBundleAccessMode;
  priceUsdCents: number;
  purchasedAt: string;
  purchasePriceUsdCents: number;
  /** True once the creator publishes a newer version than the one bought. */
  hasNewerRevision: boolean;
  /** The creator removed the unlock; it can no longer be sold. */
  retired: boolean;
  /** The creator deleted the post; only buyers can still open it. */
  tombstoned: boolean;
  /** No bundle or post is left (the creator deleted their account); only the purchased version remains. */
  detached: boolean;
  /** The post is marked NSFW: clients cover its media until the viewer reveals it in place. */
  isNsfw: boolean;
  post: {
    title: string;
    category: ShowcaseItemCategory;
    postFormat: ShowcasePostFormat;
    /** The full original, kept for app builds that draw it; thumbnails use `previewUrl`. */
    mediaUrl: string | null;
    mediaKind: ShowcaseMediaKind | null;
    /** A small still (a video's poster); null for NSFW, or when no ready one exists. */
    previewUrl: string | null;
    /** The still's placeholder; withheld with it for NSFW. */
    previewThumbhash: string | null;
  } | null;
  creator: {
    username: string | null;
    displayName: string;
    avatarUrl: string | null;
  };
}

export interface ViewerUnlocksPage {
  items: ViewerUnlockItem[];
  pageInfo: {
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
    limit: number;
    offset: number;
  };
}

type UnlockRow = {
  purchase_id: string;
  bundle_id: string | null;
  post_id: string | null;
  bundle_title: string | null;
  preview_text: string | null;
  access_mode: PersistedPostResourceBundleAccessMode;
  price_usd_cents: number | null;
  purchased_at: string;
  purchase_price_usd_cents: number | null;
  purchased_revision_number: number | null;
  has_newer_revision: boolean | null;
  bundle_retired: boolean | null;
  post_title: string | null;
  post_body: string | null;
  post_category: ShowcaseItemCategory | null;
  post_format: ShowcasePostFormat | null;
  post_showcase_asset_path: string | null;
  post_output_url: string | null;
  post_tombstoned: boolean | null;
  post_visibility: string | null;
  owner_user_id: string | null;
  owner_username: string | null;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
  total_count: number | string | null;
};

type PurchaseCoverRow = {
  purchase_id: string;
  storage_path: string | null;
  external_url: string | null;
  preview_storage_path: string | null;
  preview_thumbhash: string | null;
  media_kind: 'image' | 'video';
  sort_order: number;
};

type PurchasePaymentRow = {
  id: string;
  price_usd_cents: number | null;
  amount_subunits: number | null;
  currency: string | null;
  checkout: { razorpay_order_id: string | null } | Array<{ razorpay_order_id: string | null }> | null;
};

type UnlockCover = { previewUrl: string | null; previewThumbhash: string | null };

// Credit unlocks write a `credits_bundle_` order reference; purchases copied
// over from the legacy marketplace keep its `credits_asset_` one.
const CREDIT_ORDER_REFERENCE_PREFIXES = ['credits_bundle_', 'credits_asset_'];

function toViewerUnlockPayment(row: PurchasePaymentRow): ViewerUnlockPayment {
  const amount = row.amount_subunits ?? 0;
  if (amount <= 0 || (row.price_usd_cents ?? 0) <= 0) {
    return { paidWith: 'free', paidAmountSubunits: null, paidCurrency: null };
  }

  const checkout = Array.isArray(row.checkout) ? row.checkout[0] : row.checkout;
  const reference = checkout?.razorpay_order_id ?? '';
  if (CREDIT_ORDER_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix))) {
    return { paidWith: 'credits', paidAmountSubunits: amount, paidCurrency: null };
  }

  return { paidWith: 'cash', paidAmountSubunits: amount, paidCurrency: row.currency };
}

/** Stands in when the payment could not be read: the price in credits, as the library showed before. */
export function unreadViewerUnlockPayment(purchasePriceUsdCents: number): ViewerUnlockPayment {
  return purchasePriceUsdCents > 0
    ? { paidWith: 'credits', paidAmountSubunits: purchasePriceUsdCents, paidCurrency: null }
    : { paidWith: 'free', paidAmountSubunits: null, paidCurrency: null };
}

/**
 * How each purchase was paid, in one read for the whole page. A purchase it
 * could not read is left out; callers fall back to `unreadViewerUnlockPayment`.
 */
export async function loadViewerUnlockPayments(
  adminSupabase: SupabaseClient,
  purchaseIds: string[],
): Promise<Map<string, ViewerUnlockPayment>> {
  if (purchaseIds.length === 0) return new Map();

  const { data, error } = await adminSupabase
    .from('post_resource_bundle_purchases')
    .select('id, price_usd_cents, amount_subunits, currency, checkout:post_resource_bundle_orders(razorpay_order_id)')
    .in('id', purchaseIds);

  if (error) {
    logBackendError('viewer_unlock_payments_load_failed', { error });
    return new Map();
  }

  return new Map(((data ?? []) as PurchasePaymentRow[]).map((row) => [row.id, toViewerUnlockPayment(row)]));
}

/**
 * The first item of each purchase's immutable proof-media snapshot. The buyer
 * may read these paths even after the post goes private, archived or
 * tombstoned, so they come before the live post's media.
 */
async function loadPurchaseSnapshotCovers(
  adminSupabase: SupabaseClient,
  purchaseIds: string[],
): Promise<Map<string, UnlockCover>> {
  if (purchaseIds.length === 0) return new Map();

  const { data, error } = await adminSupabase
    .from('post_resource_purchase_media')
    .select('purchase_id, storage_path, external_url, preview_storage_path, preview_thumbhash, media_kind, sort_order')
    .in('purchase_id', purchaseIds)
    .order('sort_order', { ascending: true });

  if (error) {
    // A missing thumbnail must not cost the buyer their library.
    logBackendError('viewer_unlock_snapshot_covers_load_failed', { error });
    return new Map();
  }

  const covers = new Map<string, UnlockCover>();
  for (const row of (data ?? []) as PurchaseCoverRow[]) {
    if (covers.has(row.purchase_id)) continue;
    // As the detail's purchased media: an image without a preview is its own
    // still, while a video without a poster has none.
    const sourceUrl = row.external_url?.trim()
      || (row.storage_path ? purchasedProofMediaUrl(adminSupabase, row.storage_path) : null);
    covers.set(row.purchase_id, {
      previewUrl: row.preview_storage_path
        ? purchasedProofMediaUrl(adminSupabase, row.preview_storage_path)
        : row.media_kind === 'image' ? sourceUrl : null,
      previewThumbhash: row.preview_thumbhash,
    });
  }

  return covers;
}

/**
 * Purchases made before proof-media snapshots (2026-08-06) have none. While
 * their post is still public or unlisted, unarchived and not deleted, its own
 * first preview stands in, once that preview is ready.
 */
async function loadLivePostCovers(
  adminSupabase: SupabaseClient,
  postIds: string[],
): Promise<Map<string, UnlockCover>> {
  if (postIds.length === 0) return new Map();

  try {
    const [{ data, error }, mediaByPost] = await Promise.all([
      adminSupabase.from('posts').select('id').in('id', postIds).is('archived_at', null),
      loadPostMediaItemsMap(adminSupabase, postIds),
    ]);
    if (error) throw error;

    const covers = new Map<string, UnlockCover>();
    for (const { id } of (data ?? []) as Array<{ id: string }>) {
      const first = mediaByPost.get(id)?.[0];
      if (!first) continue;
      covers.set(id, {
        previewUrl: first.previewStatus === 'ready' ? first.previewUrl : null,
        previewThumbhash: first.previewThumbhash,
      });
    }
    return covers;
  } catch (error) {
    logBackendError('viewer_unlock_live_covers_load_failed', { error });
    return new Map();
  }
}

function derivePostTitle(row: UnlockRow): string {
  const title = row.post_title?.trim();
  if (title) {
    return title;
  }

  const body = row.post_body?.trim();
  if (body) {
    return body.length > 60 ? `${body.slice(0, 57)}...` : body;
  }

  return row.post_format === 'text' ? 'Untitled note' : 'Untitled creation';
}

export function normalizeViewerUnlocksPageParams(params: {
  limit?: number | null;
  offset?: number | null;
}) {
  const limit = Number.isFinite(params.limit)
    ? Math.min(VIEWER_UNLOCKS_MAX_PAGE_SIZE, Math.max(1, Math.trunc(params.limit as number)))
    : VIEWER_UNLOCKS_DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(params.offset)
    ? Math.max(0, Math.trunc(params.offset as number))
    : 0;

  return { limit, offset };
}

/**
 * Everything a viewer has unlocked, newest first. Deliberately includes unlocks
 * whose post was delisted or tombstoned -- that is the whole point of the
 * library. Moderation take-downs are filtered out inside the projection.
 */
export async function listViewerUnlocks({
  adminSupabase,
  viewerUserId,
  limit,
  offset,
}: {
  adminSupabase: SupabaseClient;
  viewerUserId: string;
  limit?: number | null;
  offset?: number | null;
}): Promise<ViewerUnlocksPage> {
  const page = normalizeViewerUnlocksPageParams({ limit, offset });

  const { data, error } = await adminSupabase.rpc('list_viewer_post_resource_unlocks', {
    p_buyer_user_id: viewerUserId,
    p_limit: page.limit,
    p_offset: page.offset,
  });

  if (error) {
    logBackendError('viewer_unlocks_load_failed', { error: error });
    throw error;
  }

  const rows = (data ?? []) as UnlockRow[];
  const total = rows.length > 0 ? Number(rows[0].total_count ?? rows.length) : 0;
  const isDetached = (row: UnlockRow) => !row.bundle_id || !row.post_id;
  const purchaseIds = rows.map((row) => row.purchase_id);
  const postIds = Array.from(new Set(rows.flatMap((row) => (row.post_id ? [row.post_id] : []))));

  const [nsfwPostIds, snapshotCovers, payments, mediaUrls] = await Promise.all([
    // Throws on failure: a content warning must never silently drop.
    loadNsfwPostIds(adminSupabase, postIds),
    loadPurchaseSnapshotCovers(adminSupabase, purchaseIds),
    loadViewerUnlockPayments(adminSupabase, purchaseIds),
    Promise.all(rows.map((row) => (row.post_id
      ? resolvePostMediaUrl(adminSupabase, {
          showcase_asset_path: row.post_showcase_asset_path,
          output_url: row.post_output_url,
          user_id: row.owner_user_id,
        })
      : null))),
  ]);
  // A private, archived or deleted post keeps only its snapshot cover.
  const livePostIds = rows.flatMap((row) => (
    row.post_id
    && !isDetached(row)
    && !snapshotCovers.has(row.purchase_id)
    && (row.post_visibility === 'public' || row.post_visibility === 'unlisted')
    && !row.post_tombstoned
      ? [row.post_id]
      : []
  ));
  const liveCovers = await loadLivePostCovers(adminSupabase, Array.from(new Set(livePostIds)));

  const items = rows.map((row, index): ViewerUnlockItem => {
    const hasPost = Boolean(row.post_id);
    const detached = isDetached(row);
    const isNsfw = Boolean(row.post_id && nsfwPostIds.has(row.post_id));
    // An NSFW row keeps its cover: the buyer may read it (the purchase is the
    // entitlement, 20261015013717) and the client covers the tile until a tap.
    const cover = row.post_id && !detached
      ? snapshotCovers.get(row.purchase_id) ?? liveCovers.get(row.post_id) ?? null
      : null;

    return {
      unlockId: row.purchase_id,
      bundleId: row.bundle_id,
      postId: row.post_id,
      title: row.bundle_title?.trim() || 'Unlock',
      previewText: row.preview_text ?? '',
      accessMode: row.access_mode,
      priceUsdCents: row.price_usd_cents ?? 0,
      purchasedAt: row.purchased_at,
      purchasePriceUsdCents: row.purchase_price_usd_cents ?? 0,
      hasNewerRevision: Boolean(row.has_newer_revision),
      retired: Boolean(row.bundle_retired),
      tombstoned: Boolean(row.post_tombstoned),
      detached,
      isNsfw,
      ...(payments.get(row.purchase_id) ?? unreadViewerUnlockPayment(row.purchase_price_usd_cents ?? 0)),
      post: hasPost
        ? {
            title: derivePostTitle(row),
            category: row.post_category ?? 'image',
            postFormat: row.post_format ?? 'media',
            mediaUrl: mediaUrls[index],
            mediaKind: getPostMediaKind(row.post_category ?? 'image', row.post_format ?? 'media'),
            previewUrl: cover?.previewUrl ?? null,
            previewThumbhash: cover?.previewThumbhash ?? null,
          }
        : null,
      creator: {
        username: row.owner_username,
        displayName: getCreatorDisplayName({
          displayName: row.owner_display_name,
          username: row.owner_username,
        }),
        avatarUrl: row.owner_avatar_url,
      },
    };
  });

  const nextOffset = page.offset + items.length;

  return {
    items,
    pageInfo: {
      total,
      hasMore: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null,
      limit: page.limit,
      offset: page.offset,
    },
  };
}
