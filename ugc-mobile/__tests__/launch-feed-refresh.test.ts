import { InfiniteQueryObserver, QueryClient, type InfiniteData } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { holdLaunchRefresh, isLaunchRefreshOut } from '../lib/launch-feed-refresh';
import { showcaseFeedLaneQueryOptions } from '../lib/showcase-feed-lane';
import type { ShowcaseFeedResponse } from '../lib/types';

/** Read by the launch before this one. */
const SAVED_AT = Date.parse('2026-11-27T08:00:00.000Z');
const page = (ids: string[]) => ({ success: true, items: ids.map((id) => ({ id })), feedSessionId: 'session-1' }) as unknown as ShowcaseFeedResponse;

/** Home on a cold start: the saved page in the cache, and the lane's reader moving onto it as auth settles. */
function coldStart() {
  let answer!: (response: ShowcaseFeedResponse) => void;
  const api = { getShowcaseFeed: vi.fn(() => new Promise<ShowcaseFeedResponse>((resolve) => { answer = resolve; })) };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lane = showcaseFeedLaneQueryOptions(api as never, {}, 'user-1');
  client.setQueryData<InfiniteData<ShowcaseFeedResponse>>(
    lane.queryKey,
    { pages: [page(['saved-1', 'saved-2'])], pageParams: [{ offset: 0 }] },
    { updatedAt: SAVED_AT },
  );
  // Home waits for auth before it reads: under no identity it only stands by.
  const observer = new InfiniteQueryObserver(client, { ...showcaseFeedLaneQueryOptions(api as never, {}, null), enabled: false } as never);
  const unsubscribe = observer.subscribe(() => undefined);
  observer.setOptions(lane as never);
  const ids = () => client.getQueryData<InfiniteData<ShowcaseFeedResponse>>(lane.queryKey)?.pages.map((lanePage) => lanePage.items.map((item) => item.id));
  return { api, client, lane, observer, unsubscribe, ids, answer: (response: ShowcaseFeedResponse) => answer(response) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe("the read a launch owes Home's saved page", () => {
  it('is out from the moment Home mounts on the page', async () => {
    const start = coldStart();
    stop = start.unsubscribe;
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1));

    expect(isLaunchRefreshOut(start.observer.getCurrentResult())).toBe(true);
  });

  it('replaces the page while nobody has touched it', async () => {
    const start = coldStart();
    stop = start.unsubscribe;
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1));

    start.answer(page(['ranked-now']));
    await vi.waitFor(() => expect(start.ids()).toEqual([['ranked-now']]));
    expect(isLaunchRefreshOut(start.observer.getCurrentResult())).toBe(false);
  });

  // The owner's report: open a post or scroll, and other posts are where these were.
  it('leaves the page alone once the reader has touched it, whenever the answer lands', async () => {
    const start = coldStart();
    stop = start.unsubscribe;
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1));

    await holdLaunchRefresh(start.client, start.lane.queryKey);
    start.answer(page(['ranked-now']));
    await settle();

    expect(start.ids()).toEqual([['saved-1', 'saved-2']]);
    const result = start.observer.getCurrentResult();
    expect(result.isFetching).toBe(false);
    expect(result.isError).toBe(false);
    // Still the saved page's own age: the pill's refresh, or the next visit to the lane, renews it.
    expect(start.client.getQueryState(start.lane.queryKey)?.dataUpdatedAt).toBe(SAVED_AT);
    expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1);
  });

  it('is not a page being added below, nor a refresh of a lane read in this launch', () => {
    expect(isLaunchRefreshOut({ dataUpdatedAt: SAVED_AT, isFetching: true, isFetchingNextPage: true })).toBe(false);
    expect(isLaunchRefreshOut({ dataUpdatedAt: Date.now(), isFetching: true, isFetchingNextPage: false })).toBe(false);
    expect(isLaunchRefreshOut({ dataUpdatedAt: SAVED_AT, isFetching: false, isFetchingNextPage: false })).toBe(false);
  });
});
