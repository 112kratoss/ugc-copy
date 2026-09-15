import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';

import { truncateInfiniteDataToFirstPage } from '@/lib/profile-media-query';
import type { GenerationListResponse, OwnerPostsResponse } from '@/lib/types';

/**
 * A post's new visibility, written into every loaded profile page that holds it
 * — the post itself, and each creation linked to it — without collapsing the
 * libraries to their first page.
 *
 * Collapsing is how `refreshViewerMediaCaches` keeps an invalidation to one
 * request, but on the card feed it threw away every page the reader had scrolled
 * through and moved them off the card they had just changed (audit C8). The pages
 * keep their own age: patching one entity does not make the rest fresh.
 */
export async function applyPostVisibilityToCaches(
  queryClient: QueryClient,
  userId: string | undefined,
  postId: string,
  visibility: string
) {
  const patchPages = <TPage>(key: QueryKey, patch: (page: TPage) => TPage) => {
    const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt;
    queryClient.setQueryData<InfiniteData<TPage>>(
      key,
      (data) => (data ? { ...data, pages: data.pages.map(patch) } : data),
      updatedAt ? { updatedAt } : undefined
    );
  };

  patchPages<OwnerPostsResponse>(['profile-owner-posts', userId], (page) => ({
    ...page,
    posts: page.posts.map((post) => (post.id === postId ? { ...post, visibility } as typeof post : post)),
  }));
  patchPages<GenerationListResponse>(['profile-generations', userId], (page) => ({
    ...page,
    generations: page.generations.map((item) => (
      item.linked_post_id === postId ? { ...item, linked_post_visibility: visibility } : item
    )),
  }));

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
    queryClient.invalidateQueries({ queryKey: ['home-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['owner-posts-sales-summary', userId] }),
  ]);
}

/**
 * Publishing, archiving, or flipping visibility changes what belongs in every profile
 * surface at once, so all of them have to be invalidated together. Both the viewer's
 * rail and the action sheet mutate the same media, so they share this one path — a
 * second copy would inevitably miss a cache key and leave a stale tile behind.
 */
export async function refreshViewerMediaCaches(
  queryClient: QueryClient,
  userId: string | undefined
) {
  // Collapse the paginated profile caches so invalidation refetches one page, not all of them.
  queryClient.setQueryData(['profile-saved-media', userId], truncateInfiniteDataToFirstPage);
  queryClient.setQueryData(['profile-generations', userId], truncateInfiniteDataToFirstPage);
  queryClient.setQueryData(['profile-owner-posts', userId], truncateInfiniteDataToFirstPage);

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
    queryClient.invalidateQueries({ queryKey: ['profile-saved-media', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-owner-posts', userId] }),
    queryClient.invalidateQueries({ queryKey: ['home-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['owner-posts-sales-summary', userId] }),
  ]);
}
