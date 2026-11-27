import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';

import { removeBlockedCreatorFromInfiniteData, removeShowcaseFeedItemsFromInfiniteData } from './showcase-feed-events';
import { applyShowcaseSaveStateToInfiniteFeed, type ShowcaseSaveStateResult } from './showcase-save-cache';
import type { ShowcaseFeedItem, ShowcaseFeedResponse } from './types';

/**
 * What a post action does to the feed lanes, short of reading them again.
 *
 * A ranked lane that is on screen, or mounted behind a reel or the composer,
 * is never read again because something else changed: read again more than
 * two minutes after its last ranking it is a new session, every loaded page in
 * a new order at the same scroll position, and the reader comes back to other
 * posts where theirs were (owner, 2026-11-27; the foreground half of this was
 * audit 02-2, `showcaseFeedLaneQueryOptions`). Nor is it marked out of date:
 * a lane marked so is read again when the reader next comes back to its
 * filter, which is the same swap a moment later (`rankedLaneStaleTime`). So
 * what an action changes is written into the pages
 * (`applyShowcaseFeedLaneChange`), and only the Recent timeline, whose order a
 * read does not change, is read again (`refreshShowcaseFeedTimelines`). A
 * ranked lane takes new posts when the reader asks: a pull, Refresh, the "New
 * posts" pill.
 */

const SHOWCASE_FEED_QUERY_KEY = ['showcase-feed'] as const;

type LaneData = InfiniteData<ShowcaseFeedResponse>;

/** One change to write into every lane that holds the post or the creator. */
export type ShowcaseFeedLaneChange =
  /** Deleted, archived, or no longer public: the post leaves. */
  | { removedPostId: string }
  /** Blocked: their posts leave, and no remix credit names them. */
  | { blockedCreatorId: string }
  /** Saved or unsaved somewhere that holds no lane of its own. */
  | { saveState: ShowcaseSaveStateResult }
  /** The post as the server has it now, where a lane holds an older copy. */
  | { refreshedPost: ShowcaseFeedItem };

/** The Recent lane: a timeline, whose order a read does not change (`createShowcaseFeedQueryKey`). */
function isTimelineLaneKey(queryKey: QueryKey) {
  const lane = queryKey[3];
  return typeof lane === 'object' && lane !== null && (lane as { sort?: unknown }).sort === 'recent';
}

/** The timeline lanes read again now: a post just published belongs at the top of Recent. */
export function refreshShowcaseFeedTimelines(queryClient: Pick<QueryClient, 'invalidateQueries'>) {
  return queryClient.invalidateQueries({
    queryKey: SHOWCASE_FEED_QUERY_KEY,
    predicate: (query) => isTimelineLaneKey(query.queryKey),
  });
}

function changeLane(data: LaneData, change: ShowcaseFeedLaneChange): LaneData {
  if ('removedPostId' in change) {
    return removeShowcaseFeedItemsFromInfiniteData(data, { postId: change.removedPostId }) ?? data;
  }
  if ('blockedCreatorId' in change) {
    return removeBlockedCreatorFromInfiniteData(data, change.blockedCreatorId) ?? data;
  }
  if ('refreshedPost' in change) {
    const post = change.refreshedPost;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        // The lane's copy keeps its delivery: a post read on its own carries
        // none, and the copy's events are filed under it.
        items: page.items.map((item) => (
          item.id === post.id ? { ...item, ...post, recommendation: item.recommendation } : item
        )),
      })),
    };
  }
  return applyShowcaseSaveStateToInfiniteFeed(data, change.saveState) ?? data;
}

/** Whether a patch left every page holding the very items it held. */
function holdsSameItems(before: LaneData, after: LaneData) {
  return before.pages.length === after.pages.length && before.pages.every((page, pageIndex) => {
    const next = after.pages[pageIndex].items;
    return page.items.length === next.length && page.items.every((item, index) => item === next[index]);
  });
}

/**
 * Writes one change into every cached lane, of every viewer and filter.
 *
 * A lane the change does not touch keeps its data object, so its grid is not
 * handed a new list to lay out. A lane it does touch keeps the age of its
 * pages: a write stamped now would call a page fresh that is owed a read, the
 * one restored at launch above all (`persisted-home-feed.ts`).
 */
export function applyShowcaseFeedLaneChange(
  queryClient: Pick<QueryClient, 'getQueriesData' | 'getQueryState' | 'setQueryData'>,
  change: ShowcaseFeedLaneChange,
) {
  for (const [queryKey, data] of queryClient.getQueriesData<LaneData>({ queryKey: SHOWCASE_FEED_QUERY_KEY })) {
    if (!data?.pages) continue;
    const next = changeLane(data, change);
    if (next === data || holdsSameItems(data, next)) continue;
    const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt;
    queryClient.setQueryData<LaneData>(queryKey, next, updatedAt ? { updatedAt } : undefined);
  }
}

/**
 * A saved edit, taken to the lanes that hold the post as it was: one no longer
 * public leaves them, and one still public is read once and brought up to date
 * where it stands. Nothing is read for a post no lane holds.
 */
export async function applyEditedPostToShowcaseFeedLanes(
  queryClient: Pick<QueryClient, 'getQueriesData' | 'getQueryState' | 'setQueryData'>,
  api: { getShowcasePost: (postId: string) => Promise<{ item?: ShowcaseFeedItem | null } | null | undefined> },
  postId: string,
  visibility: string | null | undefined,
) {
  if (visibility !== 'public') {
    applyShowcaseFeedLaneChange(queryClient, { removedPostId: postId });
    return;
  }
  const held = queryClient.getQueriesData<LaneData>({ queryKey: SHOWCASE_FEED_QUERY_KEY })
    .some(([, data]) => data?.pages?.some((page) => page.items.some((item) => item.id === postId)));
  if (!held) return;
  const response = await api.getShowcasePost(postId).catch(() => null);
  if (response?.item) applyShowcaseFeedLaneChange(queryClient, { refreshedPost: response.item });
}
