import type { QueryClient } from '@tanstack/react-query';

import { truncateInfiniteDataToFirstPage } from '@/lib/profile-media-query';

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
