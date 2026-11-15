import { hashKey, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAuth } from './auth';
import { setCachedCreatorProfileFollowing } from './creator-profile-view-model';
import { openSignUpSheet } from './join-navigation';
import { searchCreatorFollowOffered } from './search-screen-view-model';
import { cancelReadsBeforeFollowWrite, creatorFollowStateQueryKey } from './use-creator-follow';

export type SearchFollowCreator = { id: string; username: string; isFollowing: boolean };

/** What the follow state the reel keeps holds for a creator; null when it holds nothing. */
function heldFollowing(queryClient: QueryClient, creatorId: string): boolean | null {
  const data = queryClient.getQueryData<{ following?: unknown }>(creatorFollowStateQueryKey(creatorId));
  return typeof data?.following === 'boolean' ? data.following : null;
}

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
 * writes them. And what the app knows beyond the answer, the row draws: what
 * that follow state holds as the row comes on show, and anything written to it
 * while the row is on show. So a follow made on the start screen still reads
 * "Following" when the start screen comes back on the answer kept for the
 * opening, from before it (review of #828, S4), and so does one made on the
 * creator page pushed over the search. A newer answer (the search asked again)
 * is newer than all of it.
 *
 * A visitor and a guest follow nobody: a press asks them to sign up and comes
 * back to `returnTo`, the search the row is on (its words, tab, order and
 * filters), as the web's Follow comes back to its search (review of #828, S5).
 * The viewer's own row offers nothing (`offered`).
 */
export function useSearchCreatorFollow(creator: SearchFollowCreator, { returnTo }: { returnTo: string }) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const creatorId = creator.id;
  const offered = searchCreatorFollowOffered({ viewerId: user?.id ?? null, creatorId });

  // What the app knows of this follow beyond the row's answer: the follow
  // state as the row came on show, then anything written to it since; null
  // while it knows nothing. Forgotten when a newer answer comes, adjusted
  // while rendering as state that follows a prop is.
  const [learned, setLearned] = useState<boolean | null>(() => heldFollowing(queryClient, creatorId));
  const [answered, setAnswered] = useState({ creatorId, following: creator.isFollowing });
  if (answered.creatorId !== creatorId || answered.following !== creator.isFollowing) {
    setAnswered({ creatorId, following: creator.isFollowing });
    setLearned(answered.creatorId === creatorId ? null : heldFollowing(queryClient, creatorId));
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
      // Reads on their way would land with the answer from before the press.
      await cancelReadsBeforeFollowWrite(queryClient, creatorId);
      queryClient.setQueryData(creatorFollowStateQueryKey(creatorId), { following: next });
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

  // A refusal says the row was put back. Once the row shows what was pressed
  // for after all (followed on the creator page, or a newer answer says so),
  // it no longer holds, and is dropped for good rather than drawn again should
  // the state turn back (review of #828, N12). A read that agrees with the
  // put-back state leaves it standing.
  const refusalOutlived = mutation.isError && following === mutation.variables;
  const { reset } = mutation;
  useEffect(() => {
    if (refusalOutlived) reset();
  }, [refusalOutlived, reset]);

  const press = () => {
    if (!user) {
      openSignUpSheet(router, returnTo);
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
    /** The last press was refused and put back, and nothing has changed the state since. */
    failed: mutation.isError && !refusalOutlived,
    press,
  };
}
