import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';

import type { MagicbookletApiClient } from '@/lib/api-client';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import {
  refreshProfileArchivedCreationsHead,
  refreshProfileFailedCreationsHead,
  refreshProfileLibraryHead,
} from '@/lib/profile-library-head';
import {
  profileArchivedGenerationsQueryKey,
  profileFailedGenerationsQueryKey,
  truncateInfiniteDataToFirstPage,
} from '@/lib/profile-media-query';
import { applyArchivedScopeChange } from '@/lib/profile-media-refresh';
import { invalidateProfileStats } from '@/lib/profile-stats';
import type { GenerationListItem, GenerationListResponse, OwnerPostsResponse } from '@/lib/types';

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
  for (const key of [['profile-generations', userId], profileArchivedGenerationsQueryKey(userId)]) {
    patchPages<GenerationListResponse>(key, (page) => ({
      ...page,
      generations: page.generations.map((item) => (
        item.linked_post_id === postId ? { ...item, linked_post_visibility: visibility } : item
      )),
    }));
  }

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
    // The header counts and the seller total ride on the profile.
    invalidateProfileStats(queryClient, userId),
  ]);
}

/** A creation as the first cache that holds it has it: the pages, a looked-up one, a reel's window. */
function findCachedGeneration(
  queryClient: QueryClient,
  userId: string | undefined,
  generationId: string
): GenerationListItem | null {
  for (const key of [
    ['profile-generations', userId],
    profileFailedGenerationsQueryKey(userId),
    profileArchivedGenerationsQueryKey(userId),
  ]) {
    const data = queryClient.getQueryData<InfiniteData<GenerationListResponse>>(key);
    const found = data?.pages.flatMap((page) => page.generations ?? []).find((item) => item.id === generationId);
    if (found) return found;
  }
  const selected = queryClient.getQueryData<GenerationListItem | null>(
    ['profile-library-selection', 'profile-creations', userId, generationId]
  );
  if (selected) return selected;
  for (const [, data] of queryClient.getQueriesData<ImmersiveSourceData>({ queryKey: ['immersive-preview-source'] })) {
    const found = data?.generations?.find((item) => item.id === generationId);
    if (found) return found;
  }
  return null;
}

/**
 * One creation rewritten in every cache that lists it, each keeping its own age:
 * the Profile library's loaded pages and the Failed and Archived scopes', a
 * creation a screen looked up on its own (`useProfileLibrarySource`), and the
 * window a reel opened from an alert or from Home loaded for itself. `change`
 * returns the new row, or null to take the row out. The Archived scope's pages
 * also take in a run archived anew, from whichever cache holds it.
 */
function rewriteCachedGeneration(
  queryClient: QueryClient,
  userId: string | undefined,
  generationId: string,
  change: (item: GenerationListItem) => GenerationListItem | null
) {
  const rewrite = (items: GenerationListItem[]) => items.flatMap((item) => {
    if (item.id !== generationId) return [item];
    const next = change(item);
    return next ? [next] : [];
  });
  const keepingAge = <T>(key: QueryKey, update: (data: T) => T) => {
    const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt;
    queryClient.setQueryData<T>(key, (data) => (data === undefined ? data : update(data)), updatedAt ? { updatedAt } : undefined);
  };
  // Read before any cache is rewritten.
  const cached = findCachedGeneration(queryClient, userId, generationId);
  keepingAge<InfiniteData<GenerationListResponse, string | null>>(
    profileArchivedGenerationsQueryKey(userId),
    (data) => applyArchivedScopeChange(data, generationId, cached ? change(cached) : null)
  );

  for (const key of [['profile-generations', userId], profileFailedGenerationsQueryKey(userId)]) {
    keepingAge<InfiniteData<GenerationListResponse>>(key, (data) => ({
      ...data,
      pages: data.pages.map((page) => ({ ...page, generations: rewrite(page.generations ?? []) })),
    }));
  }
  for (const [key, data] of queryClient.getQueriesData<GenerationListItem | null>({
    queryKey: ['profile-library-selection', 'profile-creations', userId],
  })) {
    if (data?.id === generationId) keepingAge<GenerationListItem | null>(key, (item) => (item ? change(item) : item));
  }
  for (const [key, data] of queryClient.getQueriesData<ImmersiveSourceData>({ queryKey: ['immersive-preview-source'] })) {
    if (data?.generations?.some((item) => item.id === generationId)) {
      keepingAge<ImmersiveSourceData>(key, (source) => ({ ...source, generations: rewrite(source.generations ?? []) }));
    }
  }
}

/**
 * A creation archived or restored, written into the pages already loaded.
 *
 * It used to go through `refreshViewerMediaCaches`: Creations, Posts and Saved
 * cut to their first page, and every loaded page of Explore and Home read
 * again, for a change to one private creation that none of those feeds list.
 * A reader who archived the fortieth card lost their place as the library
 * shrank to its first 24 (audit 01-8). Now the row changes where it is; then
 * the library's first page is read again and merged, and the profile's counts,
 * which is all an archive can move. The Failed scope's first page is read
 * again too, once it has been opened: a restored failure belongs back on it.
 * So is the Archived scope's for an archive, but not for a restore: the
 * restored row stays where the reader left it in a card feed opened from
 * Archived, and a first page read now would take it out from under them.
 */
export async function applyGenerationArchiveToCaches({
  api,
  queryClient,
  userId,
  generationId,
  archivedAt,
}: {
  api: Pick<MagicbookletApiClient, 'listGenerations' | 'listOwnerPosts' | 'getSavedMedia'>;
  queryClient: QueryClient;
  userId: string | undefined;
  generationId: string;
  archivedAt: string | null;
}) {
  rewriteCachedGeneration(queryClient, userId, generationId, (item) => ({ ...item, archived_at: archivedAt }));
  await Promise.all([
    refreshProfileLibraryHead({ api, queryClient, userId, library: 'Creations' }).catch(() => undefined),
    refreshProfileFailedCreationsHead({ api, queryClient, userId }).catch(() => undefined),
    archivedAt ? refreshProfileArchivedCreationsHead({ api, queryClient, userId }).catch(() => undefined) : undefined,
    invalidateProfileStats(queryClient, userId),
  ]);
}

/**
 * A deleted creation, taken out of every cache that lists it, and its details
 * with it. Nothing is read again: there is nothing left to read.
 */
export function removeGenerationFromCaches(queryClient: QueryClient, userId: string | undefined, generationId: string) {
  rewriteCachedGeneration(queryClient, userId, generationId, () => null);
  // Known gone. A screen opened on it looks a creation outside the loaded pages
  // up on its own, and would only have asked the server to say so.
  queryClient.setQueryData(['profile-library-selection', 'profile-creations', userId, generationId], null);
  queryClient.removeQueries({ queryKey: ['owner-generation-details', userId, generationId] });
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
  queryClient.setQueryData(profileFailedGenerationsQueryKey(userId), truncateInfiniteDataToFirstPage);
  queryClient.setQueryData(profileArchivedGenerationsQueryKey(userId), truncateInfiniteDataToFirstPage);
  queryClient.setQueryData(['profile-owner-posts', userId], truncateInfiniteDataToFirstPage);

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
    // Home's shelf draws posts too, and leaves out what the feed leaves out.
    queryClient.invalidateQueries({ queryKey: ['home-shelf'] }),
    queryClient.invalidateQueries({ queryKey: ['profile-saved-media', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: profileFailedGenerationsQueryKey(userId) }),
    queryClient.invalidateQueries({ queryKey: profileArchivedGenerationsQueryKey(userId) }),
    queryClient.invalidateQueries({ queryKey: ['profile-owner-posts', userId] }),
    // The header counts and the seller total ride on the profile.
    invalidateProfileStats(queryClient, userId),
  ]);
}
