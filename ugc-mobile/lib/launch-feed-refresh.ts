import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { isLaneDataFromAnEarlierLaunch } from './showcase-feed-query';

/**
 * The read a launch owes the page it restored, and what happens to it once the
 * reader has started on that page.
 *
 * A cold start draws Home's For You page as the last launch saved it and reads
 * the lane again behind it (`persisted-home-feed.ts`). The answer is a new
 * ranking, and it lands seconds later (about 7 s on a slow start): by then the
 * reader has scrolled, or opened a post and come back, and found other posts
 * where theirs were (owner, 2026-11-27). A feed that has been touched keeps its
 * posts and offers the new ones, as every lane does on a return to the app
 * (product decision D2). So the read replaces the page only while nobody has
 * touched it. At the first touch it is let go, the saved page stays, and the
 * "New posts" pill offers the refresh.
 *
 * Letting go drops the answer on the phone only: the server has ranked and
 * served a page nobody sees, as it has for a refresh the reader cancels by
 * leaving. The pill's refresh ranks afresh.
 */

/** Whether the read a launch owes its restored page is still out. */
export function isLaunchRefreshOut(lane: { dataUpdatedAt: number; isFetching: boolean; isFetchingNextPage: boolean }) {
  return lane.isFetching && !lane.isFetchingNextPage && isLaneDataFromAnEarlierLaunch(lane.dataUpdatedAt);
}

/** Lets the launch's read go, leaving the lane the page it restored. */
export function holdLaunchRefresh(queryClient: Pick<QueryClient, 'cancelQueries'>, queryKey: QueryKey) {
  return queryClient.cancelQueries({ queryKey, exact: true }, { revert: true });
}
