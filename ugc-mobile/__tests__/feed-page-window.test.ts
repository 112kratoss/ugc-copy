import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { FEED_WINDOW_PAGE_LIMIT, feedWindowPaginationPosition, getPreviousFeedPageParam } from '../lib/feed-page-window';
import { getNextShowcaseFeedPageParam, type ShowcaseFeedPageParam } from '../lib/showcase-feed-query';
import type { ShowcaseFeedResponse } from '../lib/types';
it('keeps a bounded bidirectional window and continues fetching after the page count stops growing', async () => {
  const client = new QueryClient();
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ['window'], initialPageParam: { offset: 0 } as ShowcaseFeedPageParam,
    queryFn: async ({ pageParam }) => ({ items: Array.from({ length: 12 }, (_, i) => ({ id: String((pageParam.offset ?? 0) + i) })), pageInfo: { hasMore: true, nextOffset: (pageParam.offset ?? 0) + 12 } }) as ShowcaseFeedResponse,
    getNextPageParam: getNextShowcaseFeedPageParam,
    getPreviousPageParam: getPreviousFeedPageParam,
    maxPages: FEED_WINDOW_PAGE_LIMIT,
  });
  const unsubscribe = observer.subscribe(() => {});
  await observer.refetch();
  const positions = new Set<number>();
  for (let i=0;i<30;i++) {
    await observer.fetchNextPage();
    const data = observer.getCurrentResult().data!;
    positions.add(feedWindowPaginationPosition(data));
    expect(data.pages.length).toBeLessThanOrEqual(FEED_WINDOW_PAGE_LIMIT);
  }
  expect(positions.size).toBe(30);
  const first = (observer.getCurrentResult().data!.pageParams[0] as ShowcaseFeedPageParam).offset!;
  await observer.fetchPreviousPage();
  expect((observer.getCurrentResult().data!.pageParams[0] as ShowcaseFeedPageParam).offset).toBe(first - 12);
  expect(observer.getCurrentResult().data!.pages).toHaveLength(FEED_WINDOW_PAGE_LIMIT);
  unsubscribe(); client.clear();
});
