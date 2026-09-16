import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import type { MagicbookletApiClient } from './api-client';
import { selectCreationLibraryItems } from './creation-library';
import {
  buildImmersiveGenerationItems,
  buildImmersiveOwnerPostItems,
  type ImmersivePreviewItem,
  type PreviewViewerSource,
} from './immersive-preview-view-model';
import {
  flattenProfileGenerationPages,
  flattenProfileOwnerPostPages,
  profileGenerationsQueryOptions,
  profileOwnerPostsQueryOptions,
} from './profile-media-query';
import { isOwnerPostLibraryMember, type ProfilePostsScope } from './profile-view-model';
import type { GenerationListItem, OwnerPostListItem } from './types';

export type ProfileLibrarySource = 'profile-creations' | 'profile-posts';

export function isProfileLibrarySource(source: PreviewViewerSource): source is ProfileLibrarySource {
  return source === 'profile-creations' || source === 'profile-posts';
}

/**
 * Where the item a route named stands: `none` when it named nothing, `found`,
 * `loading` while that cannot be known yet, `missing` when the owner-scoped
 * lookup proved it is not the reader's to open, `error` when the lookup failed.
 */
export type ProfileLibrarySelection = 'none' | 'found' | 'loading' | 'missing' | 'error';

type LibraryApi = Pick<MagicbookletApiClient, 'listGenerations' | 'listOwnerPosts' | 'getOwnerPost'>;

/**
 * The owned library a profile card feed or reel shows: the same infinite queries
 * the Profile grid pages, read in the grid's order, filtered by the grid's rule.
 *
 * These screens used to load their own 48-item snapshot per opened item — a
 * wider request than the grid's (it included archived creations), a copy of
 * cached data that lost its age, no way past the 48th item, and a refresh that
 * could replace a larger loaded library with that smaller window (audit C3, C4,
 * C8). Sharing the grid's cache makes the three agree by construction: one set
 * of pages, one freshness, and continuation through the grid's own cursor.
 *
 * The item the route named is looked up on its own only when it is not in the
 * loaded pages — an older tile, an archived creation, a deep link — and then
 * stays at the head of the list for this visit, so a later page or refresh that
 * brings it in does not move it under the reader.
 *
 * For Creations the owner posts are enrichment (linked-post details), loaded by
 * their own query: a failing post list cannot hide creations (audit C5).
 */
export function useProfileLibrarySource({
  api,
  userId,
  source,
  initialId,
  postsScope = 'active',
  owner,
  enabled = true,
}: {
  api: LibraryApi;
  userId: string | undefined;
  source: PreviewViewerSource;
  initialId: string;
  postsScope?: ProfilePostsScope;
  owner: { creatorLabel: string; creatorAvatar?: string | null; creatorId?: string | null };
  enabled?: boolean;
}) {
  const active = enabled && Boolean(userId) && isProfileLibrarySource(source);
  const creations = source === 'profile-creations';

  const generationsQuery = useInfiniteQuery({
    ...profileGenerationsQueryOptions(api, userId),
    enabled: active && creations,
  });
  const postsQuery = useInfiniteQuery({
    ...profileOwnerPostsQueryOptions(api, userId),
    enabled: active,
  });
  const primaryQuery = creations ? generationsQuery : postsQuery;

  const generations = useMemo(
    () => flattenProfileGenerationPages(generationsQuery.data?.pages),
    [generationsQuery.data]
  );
  const ownerPosts = useMemo(
    () => flattenProfileOwnerPostPages(postsQuery.data?.pages),
    [postsQuery.data]
  );
  const primaryHasData = Boolean(primaryQuery.data);
  const selectedInLoaded = Boolean(initialId)
    && (creations ? generations : ownerPosts).some((item) => item.id === initialId);

  const selectionQuery = useQuery({
    queryKey: ['profile-library-selection', source, userId, initialId],
    enabled: active && Boolean(initialId) && primaryHasData && !selectedInLoaded,
    staleTime: 1000 * 60,
    retry: false,
    queryFn: async (): Promise<GenerationListItem | OwnerPostListItem | null> => {
      if (creations) {
        const response = await api.listGenerations(true, { id: initialId, limit: 1 });
        return response.generations.find((item) => item.id === initialId) ?? null;
      }
      try {
        const response = await api.getOwnerPost(initialId);
        return response.success && response.post.id === initialId ? response.post : null;
      } catch (error) {
        // Not found, or not this reader's: the item is missing, not unreachable.
        const status = (error as { status?: unknown }).status;
        if (status === 403 || status === 404) return null;
        throw error;
      }
    },
  });

  // Pinned for this visit only, and only when it had to be fetched on its own.
  const [selectionPinned, setSelectionPinned] = useState(false);
  useEffect(() => {
    if (selectionQuery.data && !selectedInLoaded) setSelectionPinned(true);
  }, [selectedInLoaded, selectionQuery.data]);

  const items = useMemo((): ImmersivePreviewItem[] => {
    if (!active) return [];
    if (creations) {
      const pinned = selectionPinned
        ? generations.find((item) => item.id === initialId) ?? (selectionQuery.data as GenerationListItem | null | undefined) ?? null
        : null;
      const ordered = pinned ? [pinned, ...generations.filter((item) => item.id !== initialId)] : generations;
      return buildImmersiveGenerationItems(source, selectCreationLibraryItems(ordered, initialId), owner, ownerPosts);
    }
    const pinned = selectionPinned
      ? ownerPosts.find((item) => item.id === initialId) ?? (selectionQuery.data as OwnerPostListItem | null | undefined) ?? null
      : null;
    const ordered = pinned ? [pinned, ...ownerPosts.filter((item) => item.id !== initialId)] : ownerPosts;
    return buildImmersiveOwnerPostItems(
      source,
      ordered.filter((item) => item.id === initialId || isOwnerPostLibraryMember(item, postsScope)),
      owner
    );
  }, [active, creations, generations, initialId, owner, ownerPosts, postsScope, selectionPinned, selectionQuery.data, source]);

  const selectionFound = Boolean(initialId) && items.some((item) => item.id === initialId);
  const selection: ProfileLibrarySelection = !initialId
    ? 'none'
    : selectionFound
      ? 'found'
      : !primaryHasData || selectionQuery.fetchStatus === 'fetching' || (selectionQuery.data && !selectionPinned)
        ? 'loading'
        : selectionQuery.isError
          ? 'error'
          : selectionQuery.isSuccess
            ? 'missing'
            : 'loading';

  return {
    items,
    selection,
    hasData: primaryHasData,
    isLoading: !primaryHasData && primaryQuery.isLoading,
    isError: !primaryHasData && primaryQuery.isError,
    isStale: primaryQuery.isStale,
    isFetching: primaryQuery.isFetching,
    refetch: primaryQuery.refetch,
    retrySelection: selectionQuery.refetch,
    fetchNextPage: primaryQuery.fetchNextPage,
    hasNextPage: primaryQuery.hasNextPage,
    isFetchingNextPage: primaryQuery.isFetchingNextPage,
    isFetchNextPageError: primaryQuery.isFetchNextPageError,
    pageCount: primaryQuery.data?.pages.length ?? 0,
    /** Linked-post details failed for Creations; the creations themselves are fine. */
    enrichmentFailed: creations && postsQuery.isError && !postsQuery.data,
    retryEnrichment: postsQuery.refetch,
  };
}
