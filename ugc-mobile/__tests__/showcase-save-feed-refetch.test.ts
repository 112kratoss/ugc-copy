import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { createShowcaseFeedQueryKey } from '../lib/showcase-feed-query';
import { scheduleShowcaseSaveCompletionEffects } from '../lib/showcase-save-cache';

interface ProbePage {
  items: Array<{ id: string }>;
  pageInfo: { hasMore: boolean; nextOffset: number; offset: number };
}

const clients: QueryClient[] = [];

/**
 * Stands in for a mounted feed screen: an infinite query on the real key, with
 * `pageCount` pages already loaded by scrolling. Returns a fetch counter so a
 * test can attribute later requests to whatever it does next.
 */
async function mountFeedWithLoadedPages(pageCount: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const counter = { fetches: 0 };

  const observer = new InfiniteQueryObserver(client, {
    queryKey: createShowcaseFeedQueryKey({ sort: 'for-you' }, 'user-1'),
    initialPageParam: { offset: 0 },
    queryFn: async ({ pageParam }: { pageParam: { offset?: number } }) => {
      counter.fetches += 1;
      const offset = pageParam.offset ?? 0;
      return {
        items: [{ id: `post-${offset}` }],
        pageInfo: { hasMore: true, nextOffset: offset + 12, offset },
      } satisfies ProbePage;
    },
    getNextPageParam: (lastPage: ProbePage) => ({ offset: lastPage.pageInfo.nextOffset }),
  } as never);

  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  for (let page = 1; page < pageCount; page += 1) {
    await observer.fetchNextPage();
  }

  return { client, counter, observer, unsubscribe };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('post-save refresh work against a mounted feed', () => {
  it('refetches no feed pages, so the list never reflows under the viewer', async () => {
    const { client, counter, unsubscribe } = await mountFeedWithLoadedPages(3);
    const fetchesAfterScrolling = counter.fetches;
    expect(fetchesAfterScrolling).toBe(3);

    scheduleShowcaseSaveCompletionEffects({
      postId: 'post-0',
      userId: 'user-1',
      invalidateQueries: (filters) => client.invalidateQueries(filters),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(counter.fetches - fetchesAfterScrolling).toBe(0);
    unsubscribe();
  });

  it('leaves the pull-to-refresh spinner alone, which is what shifted the scroll offset', async () => {
    const { client, observer, unsubscribe } = await mountFeedWithLoadedPages(2);
    // `refreshing` on the home and showcase feeds. iOS reveals a programmatic
    // refresh by moving the scroll view's content offset down and only restores
    // it at the top of the list, so this flipping true is a visible layout jump.
    const spinnerStates: boolean[] = [];
    const stopWatching = observer.subscribe((result) => {
      spinnerStates.push(result.isRefetching && !result.isFetchingNextPage);
    });

    scheduleShowcaseSaveCompletionEffects({
      postId: 'post-0',
      userId: 'user-1',
      invalidateQueries: (filters) => client.invalidateQueries(filters),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spinnerStates).not.toContain(true);
    stopWatching();
    unsubscribe();
  });
});
