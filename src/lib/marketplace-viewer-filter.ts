import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import {
  isUserRelationshipBlocked,
  loadBlockedCreatorIds,
  loadViewerBlockRelationships,
} from '@/lib/moderation-service';
import { getPostResourceBundleDetailByPostId } from '@/lib/post-resource-bundles-server';
import { createServiceClient } from '@/lib/server-helpers';

export type MarketplaceViewerFilterDependencies = {
  createServiceClient?: () => SupabaseClient;
  getPostResourceBundleDetailByPostId?: typeof getPostResourceBundleDetailByPostId;
  isUserRelationshipBlocked?: typeof isUserRelationshipBlocked;
  loadBlockedCreatorIds?: typeof loadBlockedCreatorIds;
  loadViewerBlockRelationships?: typeof loadViewerBlockRelationships;
};

/** A signed-in viewer's blocks, either way, as read beside the page they filter. */
export type MarketplaceViewerBlocks =
  | { ok: true; blockedUserIds: ReadonlySet<string>; truncated: boolean }
  | { ok: false; error: unknown };

/**
 * Reads everyone a signed-in viewer blocks or is blocked by. The set is the viewer's, not the page's,
 * so the list route reads it beside the page instead of after it: waiting for the page's creators
 * cost every signed-in list read a database round trip of its own (live sweep, 2026-11-17). Never
 * rejects: a read that fails is answered by `filterMarketplaceItemsForViewer` as a failed read always
 * was, with no recipes.
 */
export async function readMarketplaceViewerBlocks(
  viewerUserId: string,
  dependencies: MarketplaceViewerFilterDependencies = {},
): Promise<MarketplaceViewerBlocks> {
  try {
    const { blockedUserIds, truncated } = await (dependencies.loadViewerBlockRelationships ?? loadViewerBlockRelationships)({
      adminSupabase: (dependencies.createServiceClient ?? createServiceClient)(),
      viewerUserId,
    });
    return { ok: true, blockedUserIds, truncated };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * A storefront page is cached once for everyone, so a signed-in viewer's
 * blocks are applied to the page after it is read, the way search applies them
 * to its recipe rows. A block either way hides the creator's recipes. A block
 * set that cannot be read hides the page rather than show someone the viewer
 * blocked, as the feed does.
 *
 * `viewerBlocks`: the viewer's whole set, read beside the page (`readMarketplaceViewerBlocks`).
 * Without it, or when it ran past its cap and is incomplete, the blocks between the viewer and the
 * page's own creators are read, which is exact at any size.
 */
export async function filterMarketplaceItemsForViewer<T extends { seller: { id: string } }>(
  items: T[],
  viewerUserId: string | null,
  dependencies: MarketplaceViewerFilterDependencies = {},
  { viewerBlocks = null }: { viewerBlocks?: MarketplaceViewerBlocks | null } = {},
): Promise<T[]> {
  if (!viewerUserId || items.length === 0) return items;

  try {
    let blockedCreatorIds: ReadonlySet<string>;
    if (viewerBlocks?.ok === false) {
      throw viewerBlocks.error;
    } else if (viewerBlocks?.ok && !viewerBlocks.truncated) {
      blockedCreatorIds = viewerBlocks.blockedUserIds;
    } else {
      if (viewerBlocks?.truncated) logBackendWarning('marketplace_viewer_block_set_truncated', { viewerUserId });
      blockedCreatorIds = await (dependencies.loadBlockedCreatorIds ?? loadBlockedCreatorIds)({
        adminSupabase: (dependencies.createServiceClient ?? createServiceClient)(),
        creatorIds: items.map((item) => item.seller.id),
        viewerUserId,
      });
    }
    // The viewer's own recipes stay, as the read of the page's creators never asks about them.
    return blockedCreatorIds.size === 0
      ? items
      : items.filter((item) => item.seller.id === viewerUserId || !blockedCreatorIds.has(item.seller.id));
  } catch (error) {
    logBackendError('marketplace_viewer_block_filter_failed', { error });
    return [];
  }
}

/**
 * Whether a recipe's detail read is answered as not found for this viewer: a
 * block either way, as the post page answers. Like the post page, a
 * relationship that cannot be checked counts as a block.
 */
export async function isMarketplaceCreatorBlockedForViewer(
  viewerUserId: string,
  creatorUserId: string,
  dependencies: MarketplaceViewerFilterDependencies = {},
): Promise<boolean> {
  if (viewerUserId === creatorUserId) return false;

  try {
    return await (dependencies.isUserRelationshipBlocked ?? isUserRelationshipBlocked)({
      adminSupabase: (dependencies.createServiceClient ?? createServiceClient)(),
      firstUserId: viewerUserId,
      secondUserId: creatorUserId,
    });
  } catch (error) {
    logBackendError('marketplace_viewer_block_check_failed', { error });
    return true;
  }
}

/**
 * Whether a buy of this post's recipe is refused as not found: the detail read
 * withholds the bundle from this buyer (a moderation take-down, mature content
 * they have not revealed, a post the public cannot open), or the buyer and the
 * creator block each other. A buy can otherwise reach what the read refuses,
 * because the purchase RPCs check only the bundle's status.
 *
 * The read is asked as for the buyer's own purchase, so a buyer calling again
 * still gets the route's "already owned" answer whatever their reveal says now;
 * anyone else needs the reveal the read asks for. Unlike the reads, a check
 * that fails here throws: the route answers 500 and nothing is sold.
 */
export async function isPostResourceBundleBuyWithheld(
  {
    adminSupabase,
    buyerUserId,
    postId,
  }: {
    adminSupabase: SupabaseClient;
    buyerUserId: string;
    postId: string;
  },
  dependencies: MarketplaceViewerFilterDependencies = {},
): Promise<boolean> {
  const detail = await (dependencies.getPostResourceBundleDetailByPostId ?? getPostResourceBundleDetailByPostId)(
    postId,
    { viewerUserId: buyerUserId, adminSupabase, entitledPurchase: true, countLockedReferences: false },
  );
  if (!detail) return true;
  if (detail.viewerIsOwner) return false;

  return (dependencies.isUserRelationshipBlocked ?? isUserRelationshipBlocked)({
    adminSupabase,
    firstUserId: buyerUserId,
    secondUserId: detail.seller.id,
  });
}
