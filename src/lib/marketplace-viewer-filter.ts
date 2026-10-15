import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { isUserRelationshipBlocked, loadBlockedCreatorIds } from '@/lib/moderation-service';
import { getPostResourceBundleDetailByPostId } from '@/lib/post-resource-bundles-server';
import { createServiceClient } from '@/lib/server-helpers';

export type MarketplaceViewerFilterDependencies = {
  createServiceClient?: () => SupabaseClient;
  getPostResourceBundleDetailByPostId?: typeof getPostResourceBundleDetailByPostId;
  isUserRelationshipBlocked?: typeof isUserRelationshipBlocked;
  loadBlockedCreatorIds?: typeof loadBlockedCreatorIds;
};

/**
 * A storefront page is cached once for everyone, so a signed-in viewer's
 * blocks are applied to the page after it is read, the way search applies them
 * to its recipe rows. A block either way hides the creator's recipes. A block
 * set that cannot be read hides the page rather than show someone the viewer
 * blocked, as the feed does.
 */
export async function filterMarketplaceItemsForViewer<T extends { seller: { id: string } }>(
  items: T[],
  viewerUserId: string | null,
  dependencies: MarketplaceViewerFilterDependencies = {},
): Promise<T[]> {
  if (!viewerUserId || items.length === 0) return items;

  try {
    const blockedCreatorIds = await (dependencies.loadBlockedCreatorIds ?? loadBlockedCreatorIds)({
      adminSupabase: (dependencies.createServiceClient ?? createServiceClient)(),
      creatorIds: items.map((item) => item.seller.id),
      viewerUserId,
    });
    return blockedCreatorIds.size === 0
      ? items
      : items.filter((item) => !blockedCreatorIds.has(item.seller.id));
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
    { viewerUserId: buyerUserId, adminSupabase, entitledPurchase: true },
  );
  if (!detail) return true;
  if (detail.viewerIsOwner) return false;

  return (dependencies.isUserRelationshipBlocked ?? isUserRelationshipBlocked)({
    adminSupabase,
    firstUserId: buyerUserId,
    secondUserId: detail.seller.id,
  });
}
