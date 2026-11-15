import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAuth } from './auth';
import { setCachedCreatorProfileFollowing } from './creator-profile-view-model';
import { openSignUpSheet } from './join-navigation';
import { searchCreatorFollowOffered } from './search-screen-view-model';
import { creatorFollowStateQueryKey } from './use-creator-follow';

export type SearchFollowCreator = { id: string; username: string; isFollowing: boolean };

/**
 * Follow on a creator row of search, results and the start's creators alike
 * (2026-11-15: follow from the list, as Pinterest, X and Instagram let a
 * person do), with the creator page's request and answer: the press is drawn
 * at once and put back if the server refuses it (`failed`, for the creator
 * page's sentence). It asks nothing to draw a row: the answer the row came in
 * says whom the viewer follows.
 *
 * What it writes, the creator page and the reel read: the follow state the
 * reel keeps for the creator (`creatorFollowStateQueryKey`) and the creator's
 * cached pages (`setCachedCreatorProfileFollowing`), as the reel's own Follow
 * writes them. And what another screen learns while the search stands under
 * it (the creator page's Follow, pressed on the profile pushed over the
 * search), the row draws: anything written to that follow state since the row
 * came on show. A newer answer (the search asked again) is newer than all of
 * it.
 *
 * A visitor and a guest follow nobody: a press asks them to sign up and comes
 * back to the creator's page, as the creator page's Follow does. The viewer's
 * own row offers nothing (`offered`).
 */
export function useSearchCreatorFollow(creator: SearchFollowCreator) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const creatorId = creator.id;
  const offered = searchCreatorFollowOffered({ viewerId: user?.id ?? null, creatorId });

  // What has been written to this creator's follow state since the row came
  // on show; null while nothing has. Forgotten when a newer answer comes,
  // adjusted while rendering as state that follows a prop is.
  const [learned, setLearned] = useState<boolean | null>(null);
  const [answered, setAnswered] = useState(creator.isFollowing);
  if (answered !== creator.isFollowing) {
    setAnswered(creator.isFollowing);
    setLearned(null);
  }
  useEffect(() => {
    const hash = hashKey(creatorFollowStateQueryKey(creatorId));
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryHash !== hash) return;
      const data = event.query.state.data as { following?: unknown } | undefined;
      if (typeof data?.following === 'boolean') setLearned(data.following);
    });
  }, [creatorId, queryClient]);
  const following = learned ?? creator.isFollowing;

  const mutation = useMutation({
    mutationFn: (next: boolean) => api.setCreatorFollowing(creatorId, next),
    onMutate: async (next) => {
      const queryKey = creatorFollowStateQueryKey(creatorId);
      // A read of the follow state still on its way would land with the answer from before.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, { following: next });
      setCachedCreatorProfileFollowing(queryClient, creatorId, next);
    },
    onSuccess: (result, next) => {
      // The server's answer, in case it differs from the press.
      const confirmed = typeof result?.following === 'boolean' ? result.following : next;
      queryClient.setQueryData(creatorFollowStateQueryKey(creatorId), { following: confirmed });
      setCachedCreatorProfileFollowing(queryClient, creatorId, confirmed);
    },
    onError: (_error, next) => {
      // Put back what the row showed before the press.
      queryClient.setQueryData(creatorFollowStateQueryKey(creatorId), { following: !next });
      setCachedCreatorProfileFollowing(queryClient, creatorId, !next);
    },
    onSettled: () => {
      // Read again by whoever shows it next (the reel); nothing here asks.
      void queryClient.invalidateQueries({ queryKey: creatorFollowStateQueryKey(creatorId) });
    },
  });

  const press = () => {
    if (!user) {
      openSignUpSheet(router, `/creators/${encodeURIComponent(creator.username)}`);
      return;
    }
    if (!offered || mutation.isPending) return;
    mutation.mutate(!following);
  };

  return {
    /** Follow is drawn on the row: anyone's but the viewer's own. */
    offered,
    following,
    /** The press is on its way to the server. */
    pending: mutation.isPending,
    /** The last press was refused and put back: the row says so until the next. */
    failed: mutation.isError,
    press,
  };
}
