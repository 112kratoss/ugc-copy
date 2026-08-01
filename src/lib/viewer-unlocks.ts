import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { getPostMediaKind, resolvePostMediaUrl } from '@/lib/posts-server';
import { getCreatorDisplayName } from '@/lib/profile';
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

export interface ViewerUnlockItem {
  bundleId: string;
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
  post: {
    title: string;
    category: ShowcaseItemCategory;
    postFormat: ShowcasePostFormat;
    mediaUrl: string | null;
    mediaKind: ShowcaseMediaKind | null;
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
  bundle_id: string;
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

  const items = await Promise.all(rows.map(async (row): Promise<ViewerUnlockItem> => {
    const hasPost = Boolean(row.post_id);
    const mediaUrl = hasPost
      ? await resolvePostMediaUrl(adminSupabase, {
          showcase_asset_path: row.post_showcase_asset_path,
          output_url: row.post_output_url,
        })
      : null;

    return {
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
      post: hasPost
        ? {
            title: derivePostTitle(row),
            category: row.post_category ?? 'image',
            postFormat: row.post_format ?? 'media',
            mediaUrl,
            mediaKind: getPostMediaKind(row.post_category ?? 'image', row.post_format ?? 'media'),
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
  }));

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
