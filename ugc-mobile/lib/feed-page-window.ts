import type { InfiniteData } from '@tanstack/react-query';
import type { ShowcaseFeedPageParam } from './showcase-feed-query';
import { SHOWCASE_FEED_PAGE_SIZE } from './showcase-feed-query';
import type { ShowcaseFeedResponse } from './types';

export const FEED_WINDOW_PAGE_LIMIT = 12;

/** Chronological feeds can re-read previous pages by their explicit offset. */
export function getPreviousFeedPageParam(
  _firstPage: ShowcaseFeedResponse,
  _pages: ShowcaseFeedResponse[],
  firstPageParam: ShowcaseFeedPageParam,
): ShowcaseFeedPageParam | undefined {
  if (firstPageParam.cursor || !firstPageParam.offset) return undefined;
  return { offset: Math.max(0, firstPageParam.offset - SHOWCASE_FEED_PAGE_SIZE) };
}

/** Page count stops changing once the window is full; gate on its tail instead. */
export function feedWindowPaginationPosition(
  data: InfiniteData<ShowcaseFeedResponse> | undefined,
): number {
  if (!data?.pages.length) return 0;
  const tail = data.pageParams.at(-1);
  return tail && typeof tail === 'object' && 'offset' in tail && typeof tail.offset === 'number'
    ? tail.offset + 1 : data.pages.length;
}
