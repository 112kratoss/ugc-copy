import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { MagicbookletApiClient } from './api-client';
import { flattenCreatorProfilePages, getNextCreatorProfileOffset } from './creator-profile-view-model';
import { readShowcasePostOrMissing } from './immersive-preview-source-data';
import { buildImmersiveShowcaseItems, type ImmersivePreviewItem } from './immersive-preview-view-model';
import {
  findShowcaseFeedItemPositions,
  removeShowcaseFeedItems,
  restoreShowcaseFeedItemsToInfiniteData,
  type ShowcaseFeedRemovalTarget,
} from './showcase-feed-events';
import type { CreatorProfileResponse, ShowcaseFeedItem } from './types';
import type { ProfileLibrarySelection } from './use-profile-library-source';

type CreatorReelApi = Pick<MagicbookletApiClient, 'getCreatorProfile' | 'getShowcasePost'>;
type CreatorGridPages = InfiniteData<CreatorProfileResponse>;

/** Posts per page of a creator's grid. */
export const CREATOR_PROFILE_PAGE_SIZE = 24;

/** Every cached creator grid. */
const CREATOR_GRIDS = ['creator-profile'] as const;

/** A creator's grid, keyed by the handle as the page was routed. */
export function creatorProfileGridQueryKey(username: string) {
  return ['creator-profile', 'infinite', username] as const;
}

/**
 * The infinite query a creator's page pages its grid with
 * (`components/creator-profile-screen.tsx`), and which a reel opened on that
 * page pages too. Both must ask for pages of one size: a refetch reads every
 * page again at the offset it was loaded from, with the page size of whoever
 * asks, so a second size would leave a gap between pages.
 */
export function creatorProfileGridQueryOptions(
  api: Pick<MagicbookletApiClient, 'getCreatorProfile'>,
  username: string,
) {
  return {
    queryKey: creatorProfileGridQueryKey(username),
    initialPageParam: 0,
    queryFn: ({ pageParam }: { pageParam: number }) => api.getCreatorProfile(username, {
      limit: CREATOR_PROFILE_PAGE_SIZE,
      offset: pageParam,
    }),
    getNextPageParam: getNextCreatorProfileOffset,
    staleTime: 1000 * 60,
  };
}

/**
 * The creator a reel was opened on: the very infinite query their page's grid
 * pages, read in the grid's order and paged on through the grid's offsets, as
 * `useShowcaseLaneSource` does for a lane.
 *
 * The reel used to load a window of its own: the grid's cached pages while
 * they were fresh, else a new read of the creator's first 48 posts. A post
 * opened from deep in the grid moved to the front of that window, and nothing
 * came after its last post: a reader swiping through a creator with a hundred
 * posts met a silent end where the grid could have gone on (audit 02-6).
 *
 * The page owns its grid's refreshes (it merges a fresh first page as the
 * reader comes back to it). This reader never reads the loaded pages again
 * itself: not as the reel opens, not as the app returns to the foreground.
 *
 * The post the route named is looked up on its own only when the grid's
 * loaded pages do not hold it (a link, or a sign-in that came back to the
 * reel), and then stays at the head of the list for this visit.
 */
export function useCreatorReelSource({
  api,
  username,
  initialId,
  viewerUserId,
  mediaOnly = false,
  enabled = true,
}: {
  api: CreatorReelApi;
  /** The handle as the page was routed, which its grid is keyed by. */
  username: string | null;
  initialId: string;
  /** The signed-in account, so its own posts offer Edit post. */
  viewerUserId: string | null;
  mediaOnly?: boolean;
  enabled?: boolean;
}) {
  const active = enabled && Boolean(username);
  const gridQuery = useInfiniteQuery({
    ...creatorProfileGridQueryOptions(api, username ?? ''),
    enabled: active,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const pages = gridQuery.data?.pages;
  const gridHasData = Boolean(gridQuery.data);
  // The creator the grid belongs to, as the server named them.
  const creatorId = pages?.[0]?.profile.id ?? null;

  const gridItems = useMemo(
    () => buildImmersiveShowcaseItems('creator-profile', flattenCreatorProfilePages(pages), viewerUserId)
      .filter((item) => !mediaOnly || Boolean(item.mediaItems.length || item.mediaUrl)),
    [mediaOnly, pages, viewerUserId]
  );
  const selectedInGrid = Boolean(initialId) && gridItems.some((item) => item.id === initialId);
  // A post the grid held and the reader took out (a report removes it from the
  // grid's pages) is not looked up again: it would come back at the head of
  // the reel it was just taken out of.
  const [selectionWasInGrid, setSelectionWasInGrid] = useState(false);
  useEffect(() => {
    if (selectedInGrid) setSelectionWasInGrid(true);
  }, [selectedInGrid]);

  const selectionQuery = useQuery({
    queryKey: ['creator-reel-selection', username ?? '', viewerUserId ?? 'guest', initialId],
    enabled: active && Boolean(initialId) && gridHasData && !selectedInGrid && !selectionWasInGrid,
    staleTime: 1000 * 60,
    retry: false,
    queryFn: (): Promise<ShowcaseFeedItem | null> => readShowcasePostOrMissing(api, initialId),
  });

  // Pinned for this visit only, and only when it had to be fetched on its own.
  const [selectionPinned, setSelectionPinned] = useState(false);
  useEffect(() => {
    if (selectionQuery.data && !selectedInGrid) setSelectionPinned(true);
  }, [selectedInGrid, selectionQuery.data]);

  const items = useMemo((): ImmersivePreviewItem[] => {
    if (!active) return [];
    if (!selectionPinned) return gridItems;
    const pinned = gridItems.find((item) => item.id === initialId)
      ?? (selectionQuery.data ? buildImmersiveShowcaseItems('creator-profile', [selectionQuery.data], viewerUserId)[0] : null);
    return pinned ? [pinned, ...gridItems.filter((item) => item.id !== initialId)] : gridItems;
  }, [active, gridItems, initialId, selectionPinned, selectionQuery.data, viewerUserId]);

  const selectionFound = Boolean(initialId) && items.some((item) => item.id === initialId);
  const selection: ProfileLibrarySelection = !active || !initialId
    ? 'none'
    : selectionFound
      ? 'found'
      // Taken out of the grid by the reader: the reel moved on, nothing to find.
      : selectionWasInGrid
        ? 'none'
        : !gridHasData && gridQuery.isError && !gridQuery.isFetching
          ? 'error'
          : !gridHasData || selectionQuery.fetchStatus === 'fetching' || (selectionQuery.data && !selectionPinned)
            ? 'loading'
            : selectionQuery.isError
              ? 'error'
              : selectionQuery.isSuccess
                ? 'missing'
                : 'loading';

  const { fetchNextPage: fetchGridNextPage, hasNextPage, isFetching, isFetchNextPageError } = gridQuery;
  // The reel's own reach for the next page, from its end. Never over a fetch
  // under way, which `fetchNextPage` would cancel (the page's own next page
  // among them), and not again after a page failed: the closing slide asks.
  const fetchNextPage = useCallback(() => {
    if (!active || !hasNextPage || isFetching || isFetchNextPageError) return;
    void fetchGridNextPage();
  }, [active, fetchGridNextPage, hasNextPage, isFetchNextPageError, isFetching]);
  const retryNextPage = useCallback(() => {
    if (!active || isFetching) return;
    void fetchGridNextPage();
  }, [active, fetchGridNextPage, isFetching]);

  return {
    items,
    selection,
    creatorId,
    hasData: gridHasData,
    isLoading: active && !gridHasData && (gridQuery.isPending || gridQuery.isFetching),
    isError: active && !gridHasData && gridQuery.isError,
    /** A refresh of the grid, never the page loading behind the reader. */
    isFetching: gridQuery.isFetching && !gridQuery.isFetchingNextPage,
    refetch: gridQuery.refetch,
    retrySelection: selectionQuery.refetch,
    fetchNextPage,
    retryNextPage,
    hasNextPage: gridQuery.hasNextPage,
    isFetchingNextPage: gridQuery.isFetchingNextPage,
    isFetchNextPageError: gridQuery.isFetchNextPageError,
  };
}

/**
 * Changes one post in every cached creator grid that holds it, as a save or a
 * comment reaches a lane's pages: the grid's tile, and a reel reading the
 * grid, show the change. A grid without the post is left as it was, its age
 * included.
 */
export function updateCachedCreatorGridPost(
  queryClient: Pick<QueryClient, 'setQueriesData'>,
  postId: string,
  update: (item: ShowcaseFeedItem) => ShowcaseFeedItem,
) {
  const holds = (page: CreatorProfileResponse) => page.items.some((item) => item.id === postId);
  queryClient.setQueriesData<CreatorGridPages>({ queryKey: CREATOR_GRIDS }, (data) => {
    if (!data?.pages.some(holds)) return undefined;
    return {
      ...data,
      pages: data.pages.map((page) => (holds(page)
        ? { ...page, items: page.items.map((item) => (item.id === postId ? update(item) : item)) }
        : page)),
    };
  });
}

/**
 * Takes posts out of a creator's grid, as the reel takes them out of a lane's
 * pages: a post reported from a reel opened on the grid leaves the grid the
 * reader goes back to, and does not come back at the end of the reel as the
 * grid's next page lands. Returns how to put them back where they were.
 */
export function removeFromCachedCreatorGrid(
  queryClient: Pick<QueryClient, 'getQueryData' | 'setQueryData'>,
  username: string,
  target: ShowcaseFeedRemovalTarget,
): () => void {
  const queryKey = creatorProfileGridQueryKey(username);
  // A creator page carries its posts in `items`, as a feed page does.
  const positions = findShowcaseFeedItemPositions(queryClient.getQueryData<CreatorGridPages>(queryKey), target);
  if (!positions.length) return () => undefined;
  queryClient.setQueryData<CreatorGridPages>(queryKey, (data) => (data ? {
    ...data,
    pages: data.pages.map((page) => ({ ...page, items: removeShowcaseFeedItems(page.items, target) })),
  } : data));
  return () => {
    queryClient.setQueryData<CreatorGridPages>(queryKey, (data) => {
      const restored = restoreShowcaseFeedItemsToInfiniteData(data, positions);
      // `undefined` writes nothing: a grid that holds them again keeps its age.
      if (!data || !restored || restored === data) return undefined;
      return {
        ...data,
        pages: data.pages.map((page, index) => ({ ...page, items: restored.pages[index]?.items ?? page.items })),
      };
    });
  };
}
