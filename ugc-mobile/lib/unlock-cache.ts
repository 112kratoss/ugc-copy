import type { QueryClient } from '@tanstack/react-query';

export interface UnlockedBundleRef {
  postId: string;
  resourceId: string;
}

/**
 * Every cache that changes when a bundle is unlocked.
 *
 * An unlock flips more than the bundle itself: the feed's `canRemix`, the
 * post's access flags and the reel's source data all describe the purchase.
 * The three places that unlock used to invalidate three different subsets,
 * so unlocking from the details page left the reel believing the post was
 * still locked until it was reopened. One list, used everywhere.
 */
export async function refreshUnlockedBundleCaches(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  unlock: UnlockedBundleRef
) {
  await queryClient.invalidateQueries({ queryKey: ['post-resource-bundle', unlock.postId, unlock.resourceId] });
  await queryClient.invalidateQueries({ queryKey: ['marketplace-resource', unlock.resourceId] });
  await queryClient.invalidateQueries({ queryKey: ['marketplace-resources'] });
  await queryClient.invalidateQueries({ queryKey: ['showcase-feed'] });
  await queryClient.invalidateQueries({ queryKey: ['showcase-post', unlock.postId] });
  await queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] });
}
