import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import type { CreatorProfileResponse, ShowcaseFeedItem, ShowcaseFeedResponse, ShowcasePostResponse } from '@/lib/types';

export interface UnlockedBundleRef {
  postId: string;
  resourceId: string;
}

type UnlockCacheClient = Pick<QueryClient, 'invalidateQueries' | 'setQueriesData'>;

/**
 * The post as the server describes it to someone who owns its recipe:
 * `resolvePostRemixCapability` turns `unlock_required` into `public`, and
 * `canRemix` follows unless the remix opens on the web (src/lib/showcase-feed.ts).
 * A post with no capability on it (an older source) was locked only by its
 * recipe, so it opens the same way.
 */
export function applyBundleUnlockToItem(item: ShowcaseFeedItem, postId: string): ShowcaseFeedItem {
  if (item.id !== postId || item.canRemix) return item;
  const lockedByRecipe = item.remixCapability === 'unlock_required'
    || (item.remixCapability === undefined && Boolean(item.asset?.allowRemix));
  if (!lockedByRecipe) return item;
  return {
    ...item,
    canRemix: item.remixTarget !== 'workflow' && item.remixTarget !== 'text_template',
    remixCapability: 'public',
  };
}

function applyToFeedPage(page: ShowcaseFeedResponse, postId: string): ShowcaseFeedResponse {
  if (!Array.isArray(page?.items)) return page;
  return { ...page, items: page.items.map((item) => applyBundleUnlockToItem(item, postId)) };
}

export function applyBundleUnlockToInfiniteFeed(
  data: InfiniteData<ShowcaseFeedResponse> | undefined,
  postId: string
): InfiniteData<ShowcaseFeedResponse> | undefined {
  if (!data || !Array.isArray(data.pages)) return data;
  return { ...data, pages: data.pages.map((page) => applyToFeedPage(page, postId)) };
}

export function applyBundleUnlockToSourceData(
  data: ImmersiveSourceData | undefined,
  postId: string
): ImmersiveSourceData | undefined {
  if (!data?.showcaseItems) return data;
  return { ...data, showcaseItems: data.showcaseItems.map((item) => applyBundleUnlockToItem(item, postId)) };
}

/** The post read is cached as the response or, from older writers, as the bare item. */
export function applyBundleUnlockToPostResponse(
  data: ShowcasePostResponse | ShowcaseFeedItem | undefined,
  postId: string
): ShowcasePostResponse | ShowcaseFeedItem | undefined {
  if (!data) return data;
  if ('item' in data && data.item) return { ...data, item: applyBundleUnlockToItem(data.item, postId) };
  if ('id' in data && typeof data.id === 'string') return applyBundleUnlockToItem(data as ShowcaseFeedItem, postId);
  return data;
}

/**
 * Every cache that changes when a bundle is unlocked.
 *
 * Only the bundle's own reads are waited for: they are what turns the card
 * over, and either one is mounted only by the screen showing it. The feed,
 * the reel's source and the post learn the new remix access by a patch, the
 * way a save reaches them (`use-showcase-save-mutation.ts`). Refetching them
 * instead held the button on its spinner through every loaded page of every
 * mounted feed, one invalidation after another, and re-ranked For You under
 * the buyer. The rest (the buyer's library, the post's own read) refresh
 * behind the result. The app has no marketplace list to refresh: recipes are
 * browsed as posts, which the patches above reach.
 */
export async function refreshUnlockedBundleCaches(queryClient: UnlockCacheClient, unlock: UnlockedBundleRef) {
  queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
    { queryKey: ['showcase-feed'] },
    (current) => applyBundleUnlockToInfiniteFeed(current, unlock.postId)
  );
  queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
    { queryKey: ['profile-saved-media'] },
    (current) => applyBundleUnlockToInfiniteFeed(current, unlock.postId)
  );
  // A creator's grid is what the reel opened on their page draws from, so the
  // unlock has to reach it the way it reaches a lane.
  queryClient.setQueriesData<InfiniteData<CreatorProfileResponse>>(
    { queryKey: ['creator-profile'] },
    (current) => current?.pages
      ? { ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => applyBundleUnlockToItem(item, unlock.postId)) })) }
      : current
  );
  queryClient.setQueriesData<ImmersiveSourceData>(
    { queryKey: ['immersive-preview-source'] },
    (current) => applyBundleUnlockToSourceData(current, unlock.postId)
  );
  queryClient.setQueriesData<ShowcasePostResponse | ShowcaseFeedItem>(
    { queryKey: ['showcase-post', unlock.postId] },
    (current) => applyBundleUnlockToPostResponse(current, unlock.postId)
  );

  for (const queryKey of [['viewer-unlocks'], ['showcase-post', unlock.postId]]) {
    void Promise.resolve(queryClient.invalidateQueries({ queryKey })).catch(() => undefined);
  }

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['post-resource-bundle', unlock.postId, unlock.resourceId] }),
    queryClient.invalidateQueries({ queryKey: ['marketplace-resource', unlock.resourceId] }),
  ]);
}
