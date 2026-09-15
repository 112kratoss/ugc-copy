import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { MagicbookletApiClient } from './api-client';
import { PROFILE_MEDIA_PAGE_SIZE } from './profile-media-query';
import {
  PROFILE_GENERATION_PAGES,
  PROFILE_OWNER_POST_PAGES,
  PROFILE_SAVED_MEDIA_PAGES,
  mergeRefreshedFirstPage,
} from './profile-media-refresh';
import type { ProfileMediaTab } from './profile-view-model';
import type { GenerationListResponse, OwnerPostsResponse, ShowcaseFeedResponse } from './types';

type LibraryApi = Pick<MagicbookletApiClient, 'listGenerations' | 'listOwnerPosts' | 'getSavedMedia'>;

/**
 * Fetches one profile library's first page and merges it into whatever the
 * reader has loaded, instead of refetching every loaded page.
 *
 * The request is the one the library's infinite query makes for its first page,
 * so the merged page is exactly what a full refresh would have put there.
 */
export async function refreshProfileLibraryHead({
  api,
  queryClient,
  userId,
  library,
}: {
  api: LibraryApi;
  queryClient: Pick<QueryClient, 'setQueryData'>;
  userId: string | undefined;
  library: ProfileMediaTab;
}) {
  if (library === 'Creations') {
    const fresh = await api.listGenerations(false, { limit: PROFILE_MEDIA_PAGE_SIZE });
    if (!fresh) return;
    queryClient.setQueryData<InfiniteData<GenerationListResponse, string | null>>(
      ['profile-generations', userId],
      (current) => mergeRefreshedFirstPage(current, fresh, null, PROFILE_GENERATION_PAGES)
    );
    return;
  }

  if (library === 'Posts') {
    const fresh = await api.listOwnerPosts({
      includeArchived: true,
      includeSummary: true,
      limit: PROFILE_MEDIA_PAGE_SIZE,
      offset: 0,
      visibility: 'all',
    });
    if (!fresh) return;
    queryClient.setQueryData<InfiniteData<OwnerPostsResponse, number>>(
      ['profile-owner-posts', userId],
      (current) => mergeRefreshedFirstPage(current, fresh, 0, PROFILE_OWNER_POST_PAGES)
    );
    return;
  }

  const fresh = await api.getSavedMedia({ limit: PROFILE_MEDIA_PAGE_SIZE, offset: 0 });
  if (!fresh) return;
  queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse, number>>(
    ['profile-saved-media', userId],
    (current) => mergeRefreshedFirstPage(current, fresh, 0, PROFILE_SAVED_MEDIA_PAGES)
  );
}
