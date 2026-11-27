import { InfiniteQueryObserver, QueryClient, type InfiniteData } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isLaunchRefreshOut, keepRestoredPage, mergeUnderRestoredPage, resetRestoredPageKeepsForTests } from '../lib/launch-feed-refresh';
import { requestFreshRanking, resetFreshRankingForTests } from '../lib/feed-fresh-ranking';
import { showcaseFeedLaneQueryOptions } from '../lib/showcase-feed-lane';
import type { ShowcaseFeedResponse } from '../lib/types';

/** Read by the launch before this one. */
const SAVED_AT = Date.parse('2026-11-27T08:00:00.000Z');
const page = (ids: string[], session = 'saved-session') => ({
  success: true,
  items: ids.map((id) => ({ id, recommendation: { deliveryId: `${session}:${id}` } })),
  feedSessionId: session,
  nextCursor: `${session}-cursor`,
}) as unknown as ShowcaseFeedResponse;

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
  resetRestoredPageKeepsForTests();
  resetFreshRankingForTests();
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
  it('lands under the page once the reader has touched it: the saved posts stay, the new ranking follows', async () => {
    const start = coldStart();
    stop = start.unsubscribe;
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1));

    keepRestoredPage(start.lane.queryKey);
    start.answer(page(['ranked-1', 'saved-2', 'ranked-2'], 'new-session'));
    await vi.waitFor(() => expect(start.ids()).toEqual([['saved-1', 'saved-2', 'ranked-1', 'ranked-2']]));

    const lanePage = start.client.getQueryData<InfiniteData<ShowcaseFeedResponse>>(start.lane.queryKey)!.pages[0];
    // The lane is the new session's: its cursor pages on, where the saved
    // page's own would have ended the feed once its session had closed.
    expect(lanePage).toMatchObject({ feedSessionId: 'new-session', nextCursor: 'new-session-cursor' });
    const deliveries = lanePage.items.map((item) => item.recommendation?.deliveryId);
    // A kept post the new ranking holds takes its delivery; one it does not
    // keeps none, since the server refuses another session's.
    expect(deliveries).toEqual([undefined, 'new-session:saved-2', 'new-session:ranked-1', 'new-session:ranked-2']);
    // Read in this launch now: nothing reads it again behind the reader.
    expect(isLaunchRefreshOut(start.observer.getCurrentResult())).toBe(false);
    expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1);
  });

  // A heart tapped between the touch and the answer writes the lane, and a
  // plain write stamps it as read now: the page is still the one to keep.
  it('still keeps the page when the reader saves a post on it before the answer lands', async () => {
    const start = coldStart();
    stop = start.unsubscribe;
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1));
    keepRestoredPage(start.lane.queryKey);
    start.client.setQueriesData<InfiniteData<ShowcaseFeedResponse>>({ queryKey: ['showcase-feed'] }, (data) => (
      data ? { ...data, pages: data.pages.map((lanePage) => ({ ...lanePage, items: lanePage.items.map((item) => ({ ...item, isSaved: item.id === 'saved-1' })) })) } : data
    ));

    start.answer(page(['ranked-1'], 'new-session'));

    await vi.waitFor(() => expect(start.ids()).toEqual([['saved-1', 'saved-2', 'ranked-1']]));
    expect(start.client.getQueryData<InfiniteData<ShowcaseFeedResponse>>(start.lane.queryKey)?.pages[0].items[0]).toMatchObject({ id: 'saved-1', isSaved: true });
  });

  it('keeps the page for one answer only', async () => {
    const start = coldStart();
    stop = start.unsubscribe;
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1));
    keepRestoredPage(start.lane.queryKey);
    start.answer(page(['ranked-1'], 'new-session'));
    await vi.waitFor(() => expect(start.ids()).toEqual([['saved-1', 'saved-2', 'ranked-1']]));

    // The next read of the first page (a later refresh) replaces it as any does.
    void start.observer.refetch();
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(2));
    start.answer(page(['later-1'], 'later-session'));
    await vi.waitFor(() => expect(start.ids()).toEqual([['later-1']]));
  });

  it("gives way to the reader's own refresh: a pull replaces the page", async () => {
    const start = coldStart();
    stop = start.unsubscribe;
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(1));
    keepRestoredPage(start.lane.queryKey);

    // A pull while the launch's read is out: asked fresh, read again.
    requestFreshRanking({}, 'user-1');
    void start.observer.refetch();
    await vi.waitFor(() => expect(start.api.getShowcaseFeed).toHaveBeenCalledTimes(2));
    start.answer(page(['pulled-1'], 'pulled-session'));

    await vi.waitFor(() => expect(start.ids()).toEqual([['pulled-1']]));
  });

  it('puts the new ranking under the saved posts without repeating one', () => {
    const merged = mergeUnderRestoredPage(page(['a', 'b']), page(['b', 'c', 'a', 'd'], 'new-session'));

    expect(merged.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.feedSessionId).toBe('new-session');
  });

  it('is not a page being added below, nor a refresh of a lane read in this launch', () => {
    expect(isLaunchRefreshOut({ dataUpdatedAt: SAVED_AT, isFetching: true, isFetchingNextPage: true })).toBe(false);
    expect(isLaunchRefreshOut({ dataUpdatedAt: Date.now(), isFetching: true, isFetchingNextPage: false })).toBe(false);
    expect(isLaunchRefreshOut({ dataUpdatedAt: SAVED_AT, isFetching: false, isFetchingNextPage: false })).toBe(false);
  });
});
