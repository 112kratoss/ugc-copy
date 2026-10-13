import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { MagicbookletApiClient } from './api-client';
import { useAuth } from './auth';
import { readShowcasePostOrMissing } from './immersive-preview-source-data';
import { buildImmersiveShowcaseItems, type ImmersivePreviewItem } from './immersive-preview-view-model';
import { filterAnonymousSessionShowcaseFeedItems } from './showcase-feed-events';
import { showcaseFeedLaneQueryOptions, type ShowcaseFeedLane } from './showcase-feed-lane';
import { flattenShowcaseFeedPages, getShowcaseFeedSessionContext } from './showcase-feed-query';
import type { ShowcaseFeedItem } from './types';
import type { ProfileLibrarySelection } from './use-profile-library-source';

type LaneApi = Pick<MagicbookletApiClient, 'getShowcaseFeed' | 'getShowcasePost'>;

/**
 * The lane a reel was opened from: the very infinite query the Explore or Home
 * grid pages, read in the grid's order and paged through the grid's cursor and
 * session, as `useProfileLibrarySource` does for a profile reel.
 *
 * The reel used to load a window of its own: a fresh 48-post For You session
 * with none of the lane's filters, asked for again on open and on every return,
 * whose reshuffle could drop the post on screen and serve deliveries nobody saw.
 * It also stopped at that window (audit 03-2, 03-4). Reading the grid's pages
 * keeps the reader in the lane they tapped, with its neighbours, to its end.
 *
 * The grid owns the lane's refreshes. This reader never asks for a new session
 * itself: not as the reel opens, not as the reader comes back to it, not as the
 * app returns to the foreground.
 *
 * The post the route named is looked up on its own only when the lane's loaded
 * pages do not hold it (sign-in can bring the reader back to a lane of another
 * account's), and then stays at the head of the list for this visit.
 *
 * `userId` names the lane: the backend identity, guest or registered
 * (`identityUserId`), which the grids key their lanes by. What a registered
 * account changes is read from auth, as the grids read it: a guest's removals
 * last for this visit and leave the reel too, and only an account's own post
 * offers Edit post.
 */
export function useShowcaseLaneSource({
  api,
  userId,
  lane,
  initialId,
  mediaOnly = false,
  enabled = true,
}: {
  api: LaneApi;
  /** The backend identity, guest or registered: `identityUserId` from `useAuth`. */
  userId: string | null | undefined;
  lane: ShowcaseFeedLane | null;
  initialId: string;
  /** Explore's reel leaves out posts with nothing to show, as its grid does. */
  mediaOnly?: boolean;
  enabled?: boolean;
}) {
  const registeredUserId = useAuth().user?.id ?? null;
  const active = enabled && Boolean(lane);
  const laneQuery = useInfiniteQuery({
    ...showcaseFeedLaneQueryOptions(api, lane ?? {}, userId),
    enabled: active,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const pages = laneQuery.data?.pages;
  const laneHasData = Boolean(laneQuery.data);

  const laneItems = useMemo(() => {
    const flattened = flattenShowcaseFeedPages(pages);
    const visible = registeredUserId ? flattened : filterAnonymousSessionShowcaseFeedItems(flattened);
    return buildImmersiveShowcaseItems('showcase-feed', visible, registeredUserId)
      .filter((item) => !mediaOnly || Boolean(item.mediaItems.length || item.mediaUrl));
  }, [mediaOnly, pages, registeredUserId]);
  const selectedInLane = Boolean(initialId) && laneItems.some((item) => item.id === initialId);

  const selectionQuery = useQuery({
    queryKey: ['showcase-lane-selection', userId?.trim() || 'installation', initialId],
    enabled: active && Boolean(initialId) && laneHasData && !selectedInLane,
    staleTime: 1000 * 60,
    retry: false,
    queryFn: (): Promise<ShowcaseFeedItem | null> => readShowcasePostOrMissing(api, initialId),
  });

  // Pinned for this visit only, and only when it had to be fetched on its own.
  const [selectionPinned, setSelectionPinned] = useState(false);
  useEffect(() => {
    if (selectionQuery.data && !selectedInLane) setSelectionPinned(true);
  }, [selectedInLane, selectionQuery.data]);

  const items = useMemo((): ImmersivePreviewItem[] => {
    if (!active) return [];
    if (!selectionPinned) return laneItems;
    const pinned = laneItems.find((item) => item.id === initialId)
      ?? (selectionQuery.data ? buildImmersiveShowcaseItems('showcase-feed', [selectionQuery.data], registeredUserId)[0] : null);
    return pinned ? [pinned, ...laneItems.filter((item) => item.id !== initialId)] : laneItems;
  }, [active, initialId, laneItems, registeredUserId, selectionPinned, selectionQuery.data]);

  const selectionFound = Boolean(initialId) && items.some((item) => item.id === initialId);
  const selection: ProfileLibrarySelection = !active || !initialId
    ? 'none'
    : selectionFound
      ? 'found'
      : !laneHasData && laneQuery.isError && !laneQuery.isFetching
        ? 'error'
        : !laneHasData || selectionQuery.fetchStatus === 'fetching' || (selectionQuery.data && !selectionPinned)
          ? 'loading'
          : selectionQuery.isError
            ? 'error'
            : selectionQuery.isSuccess
              ? 'missing'
              : 'loading';

  const session = useMemo(() => getShowcaseFeedSessionContext(pages), [pages]);

  const { fetchNextPage: fetchLaneNextPage, hasNextPage, isFetching, isFetchNextPageError } = laneQuery;
  // The reel's own reach for the next page, from its end. Never over a fetch
  // under way, which `fetchNextPage` would cancel (the grid's refresh among
  // them), and not again after a page failed: the closing slide asks the reader.
  const fetchNextPage = useCallback(() => {
    if (!active || !hasNextPage || isFetching || isFetchNextPageError) return;
    void fetchLaneNextPage();
  }, [active, fetchLaneNextPage, hasNextPage, isFetchNextPageError, isFetching]);
  const retryNextPage = useCallback(() => {
    if (!active || isFetching) return;
    void fetchLaneNextPage();
  }, [active, fetchLaneNextPage, isFetching]);

  return {
    items,
    selection,
    hasData: laneHasData,
    isLoading: active && !laneHasData && (laneQuery.isPending || laneQuery.isFetching),
    isError: active && !laneHasData && laneQuery.isError,
    /** A refresh of the lane, never the page loading behind the reader. */
    isFetching: laneQuery.isFetching && !laneQuery.isFetchingNextPage,
    refetch: laneQuery.refetch,
    retrySelection: selectionQuery.refetch,
    fetchNextPage,
    retryNextPage,
    hasNextPage: laneQuery.hasNextPage,
    isFetchingNextPage: laneQuery.isFetchingNextPage,
    isFetchNextPageError: laneQuery.isFetchNextPageError,
    feedSessionId: session.feedSessionId,
    algorithmVersion: session.algorithmVersion,
  };
}
