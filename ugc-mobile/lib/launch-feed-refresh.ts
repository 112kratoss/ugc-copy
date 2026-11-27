import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';

import { isLaneDataFromAnEarlierLaunch } from './showcase-feed-query';
import type { ShowcaseFeedResponse } from './types';

/**
 * The read a launch owes the page it restored, and what its answer does to a
 * page the reader has already started on.
 *
 * A cold start draws Home's For You page as the last launch saved it and reads
 * the lane again behind it (`persisted-home-feed.ts`). The answer is a new
 * ranking, and it lands seconds later (about 7 s on a slow start): by then the
 * reader has scrolled, or opened a post and come back, and found other posts
 * where theirs were (owner, 2026-11-27). So the answer replaces the page only
 * while nobody has touched it. Once the reader has, the posts they were shown
 * stay where they are and the new ranking goes below them, as the web's Explore
 * keeps the tiles it has drawn (`mergeShowcaseFeedKeepingVisibleItems`).
 *
 * The lane is the new session's from then on: its cursor pages on, and a kept
 * post the new ranking also holds takes that copy, with its delivery. A kept
 * post it does not hold keeps no delivery: its old one belongs to a session
 * the lane has left, and the server refuses a foreign delivery's events.
 */

const lanesToKeep = new Set<string>();

function laneId(queryKey: QueryKey) {
  return JSON.stringify(queryKey);
}

/** Whether the read a launch owes its restored page is still out. */
export function isLaunchRefreshOut(lane: { dataUpdatedAt: number; isFetching: boolean; isFetchingNextPage: boolean }) {
  return lane.isFetching && !lane.isFetchingNextPage && isLaneDataFromAnEarlierLaunch(lane.dataUpdatedAt);
}

/** The reader has touched the restored page while its read is out: its posts stay. */
export function keepRestoredPage(queryKey: QueryKey) {
  lanesToKeep.add(laneId(queryKey));
}

/** The new ranking under the restored page's posts. */
export function mergeUnderRestoredPage(restored: ShowcaseFeedResponse, fresh: ShowcaseFeedResponse): ShowcaseFeedResponse {
  const freshById = new Map(fresh.items.map((item) => [item.id, item] as const));
  const keptIds = new Set(restored.items.map((item) => item.id));
  return {
    ...fresh,
    // The posts that are here only because the reader was on them: this
    // launch's alone (`withoutKeptRestoredPosts`).
    keptRestoredPostIds: restored.items.filter((item) => !freshById.has(item.id)).map((item) => item.id),
    items: [
      ...restored.items.map((item) => {
        const again = freshById.get(item.id);
        if (again) return again;
        const { recommendation: _otherSession, ...kept } = item;
        return kept;
      }),
      ...fresh.items.filter((item) => !keptIds.has(item.id)),
    ],
  };
}

/**
 * The page as the server answered it, for the next launch to restore: without
 * the posts this launch kept on top of it. Saved with them, the next launch
 * would draw the same posts first again, keep them again at a touch, and so
 * on, the saved page a dozen posts longer each time, and since a kept post
 * holds no delivery the server would never learn it had been seen.
 */
export function withoutKeptRestoredPosts(page: ShowcaseFeedResponse): ShowcaseFeedResponse {
  const { keptRestoredPostIds, ...answered } = page;
  if (!keptRestoredPostIds?.length) return answered;
  const kept = new Set(keptRestoredPostIds);
  return { ...answered, items: answered.items.filter((item) => !kept.has(item.id)) };
}

/**
 * What a lane's first-page read hands back: its answer, or its answer under the
 * page the lane holds where the reader's touch asked for that page to be kept.
 * The ask is spent by the first answer either way, and never applies to a
 * refresh the reader asked for (a pull, the pill). Only a first-page answer
 * renews the page, and each one spends the ask, so the page it finds is the one
 * the reader touched. Its age is not asked again: a save or a hidden post in
 * the seconds between the touch and the answer stamps the lane as written now.
 */
export function firstPageUnderRestoredPage(
  client: Pick<QueryClient, 'getQueryState'> | undefined,
  queryKey: QueryKey,
  fresh: ShowcaseFeedResponse,
  readerAskedForRefresh: boolean,
): ShowcaseFeedResponse {
  if (!lanesToKeep.delete(laneId(queryKey)) || readerAskedForRefresh || !client) return fresh;
  const restored = client.getQueryState<InfiniteData<ShowcaseFeedResponse>>(queryKey)?.data?.pages[0];
  return restored ? mergeUnderRestoredPage(restored, fresh) : fresh;
}

export function resetRestoredPageKeepsForTests() {
  lanesToKeep.clear();
}
