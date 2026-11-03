import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { MagicbookletApiClient } from './api-client';
import { useAuth } from './auth';
import { setCachedCreatorProfileFollowing } from './creator-profile-view-model';
import type { CreatorFollowAttribution, CreatorProfileResponse } from './types';

const FOLLOW_STATE_STALE_MS = 1000 * 60 * 5;

export function creatorFollowStateQueryKey(creatorId: string | null) {
  return ['creator-follow-state', creatorId] as const;
}

type FollowStateQueryClient = Pick<QueryClient, 'getQueriesData' | 'getQueryState' | 'isMutating'>;

/**
 * Whether the reader follows a creator, as a cached page of that creator says
 * (`viewer.isFollowing`, which the reel's Follow and the page's own button both
 * keep current), and when that page was read: the freshest such page read
 * within the time the reel keeps an answer for. Null when there is none.
 *
 * Nothing while any mutation is in flight: the page's Follow writes its answer
 * into the page before the server has it, and puts the page back if it fails,
 * which the reel's copy of a seeded answer would never learn.
 *
 * The pages and the follow states are both forgotten whenever the person on
 * the phone changes: as a sign-in lands, and on every way out of a session
 * (`isViewerlessCreatorQuery` in `lib/auth.tsx`). Until this phone's sign-ins
 * did it too (review of #679), a guest's pages outlived its sign-in.
 */
export function cachedCreatorPageFollowState(
  queryClient: FollowStateQueryClient,
  creatorId: string,
  now = Date.now(),
): { state: { following: boolean }; updatedAt: number } | null {
  if (queryClient.isMutating() > 0) return null;
  let freshest: { state: { following: boolean }; updatedAt: number } | null = null;
  for (const [queryKey, data] of queryClient.getQueriesData<InfiniteData<CreatorProfileResponse>>({ queryKey: ['creator-profile'] })) {
    if (!Array.isArray(data?.pages)) continue;
    const page = data.pages.find((candidate) => candidate?.profile?.id === creatorId);
    if (typeof page?.viewer?.isFollowing !== 'boolean') continue;
    const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
    if (!(updatedAt > now - FOLLOW_STATE_STALE_MS)) continue;
    if (!freshest || updatedAt > freshest.updatedAt) {
      freshest = { state: { following: page.viewer.isFollowing }, updatedAt };
    }
  }
  return freshest;
}

/**
 * Asks ahead whether the signed-in reader follows a creator, into the cache
 * `useCreatorFollow` reads — as a finger lands on one of their tiles, so a
 * reel opening on the post already knows (`ZoomPostPreparer`). An answer still
 * fresh is not asked for again.
 *
 * A fresh page of the creator, read later than any answer held, is drawn as
 * the answer at once: a tile on a creator's page knows whom the reader follows
 * before the request answers. Asked for as the finger landed, the answer still
 * came 1.1–2.4 s after the reel had opened, and the Follow pill popped in under
 * the reader (device sweep, Pixel 9a emulator, 2026-11-03). Home and Explore
 * cards carry no follow state, so a tile there still waits for the request.
 *
 * The server is asked all the same: the page's answer is written as already
 * stale. A page can say no where the server says yes (one a guest read before
 * signing in, one whose follow lookup failed on the server, one whose age a
 * change in the app moved on), and kept as fresh as the page, it stood on the
 * pill for up to five minutes (review of #679). A page that says what the
 * answer held already says is no news, and asks nothing.
 */
export function prefetchCreatorFollowState(
  queryClient: QueryClient,
  api: Pick<MagicbookletApiClient, 'getCreatorFollowState'>,
  creatorId: string
) {
  const queryKey = creatorFollowStateQueryKey(creatorId);
  const fromPage = cachedCreatorPageFollowState(queryClient, creatorId);
  const held = queryClient.getQueryState<{ following: boolean }>(queryKey);
  if (
    fromPage
    && fromPage.updatedAt > (held?.dataUpdatedAt ?? 0)
    && fromPage.state.following !== held?.data?.following
  ) {
    queryClient.setQueryData(queryKey, fromPage.state, { updatedAt: 0 });
  }
  return queryClient.prefetchQuery({
    queryKey,
    queryFn: () => api.getCreatorFollowState(creatorId),
    staleTime: FOLLOW_STATE_STALE_MS,
  });
}

/**
 * Whether the signed-in viewer follows a creator, and a way to flip it.
 *
 * The reel asks this for whichever creator is on screen, so the state is
 * keyed by creator (not by post) and only fetched while `enabled` — an
 * off-screen slide never asks. The flip is optimistic: the button changes
 * under the thumb and the server answer settles it, the way the profile
 * screen's own follow button behaves. The same answer is written into the
 * creator's cached grid pages, so a creator page under the reel agrees
 * without reading its pages again.
 */
export function useCreatorFollow({
  creatorId,
  enabled,
  attribution = null,
}: {
  creatorId: string | null;
  enabled: boolean;
  /**
   * The post the Follow was pressed on and the feed delivery that showed it,
   * sent with the request so the server can credit the follow to them.
   */
  attribution?: CreatorFollowAttribution | null;
}) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = creatorFollowStateQueryKey(creatorId);
  const canFollow = Boolean(creatorId) && Boolean(user) && creatorId !== user?.id;

  const stateQuery = useQuery({
    queryKey,
    enabled: enabled && canFollow,
    queryFn: () => api.getCreatorFollowState(creatorId!),
    staleTime: FOLLOW_STATE_STALE_MS,
  });

  const mutation = useMutation({
    mutationFn: (following: boolean) => api.setCreatorFollowing(creatorId!, following, attribution),
    onMutate: async (following) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey }),
        // A creator page read set off before the press (a finger rested on the
        // creator's handle, then let go) would land after the answer below is
        // written into the cached pages, with the answer from before it (review
        // of #679). Dropped, as nobody is waiting on it: the page reads itself
        // when it opens. A read a page on screen is waiting on is left to land;
        // dropped, it would leave that page with nothing on its way.
        queryClient.cancelQueries({ queryKey: ['creator-profile'], type: 'inactive' }),
      ]);
      const previous = queryClient.getQueryData<{ following: boolean }>(queryKey);
      queryClient.setQueryData<{ following: boolean }>(queryKey, { following });
      setCachedCreatorProfileFollowing(queryClient, creatorId!, following);
      return { previous };
    },
    onSuccess: (result, following) => {
      // The server's answer, in case a grid page landed between the press and it.
      setCachedCreatorProfileFollowing(queryClient, creatorId!, result?.following ?? following);
    },
    onError: (_error, following, context) => {
      const restored = context?.previous ?? { following: !following };
      queryClient.setQueryData(queryKey, restored);
      setCachedCreatorProfileFollowing(queryClient, creatorId!, restored.following);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const following = stateQuery.data?.following ?? false;
  const { mutate } = mutation;
  const toggle = useCallback(() => {
    if (!canFollow) return;
    mutate(!following);
  }, [canFollow, following, mutate]);

  return {
    /** True only when the viewer is signed in and the creator is someone else. */
    canFollow,
    following,
    /** The first answer has not arrived; the button should not claim either state yet. */
    loading: enabled && canFollow && stateQuery.isPending,
    pending: mutation.isPending,
    toggle,
  };
}
