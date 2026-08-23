import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useAuth } from './auth';

export function creatorFollowStateQueryKey(creatorId: string | null) {
  return ['creator-follow-state', creatorId] as const;
}

/**
 * Whether the signed-in viewer follows a creator, and a way to flip it.
 *
 * The reel asks this for whichever creator is on screen, so the state is
 * keyed by creator (not by post) and only fetched while `enabled` — an
 * off-screen slide never asks. The flip is optimistic: the button changes
 * under the thumb and the server answer settles it, the way the profile
 * screen's own follow button behaves. The creator profile's cache is
 * invalidated afterwards so the two surfaces agree.
 */
export function useCreatorFollow({ creatorId, enabled }: { creatorId: string | null; enabled: boolean }) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = creatorFollowStateQueryKey(creatorId);
  const canFollow = Boolean(creatorId) && Boolean(user) && creatorId !== user?.id;

  const stateQuery = useQuery({
    queryKey,
    enabled: enabled && canFollow,
    queryFn: () => api.getCreatorFollowState(creatorId!),
    staleTime: 1000 * 60 * 5,
  });

  const mutation = useMutation({
    mutationFn: (following: boolean) => api.setCreatorFollowing(creatorId!, following),
    onMutate: async (following) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<{ following: boolean }>(queryKey);
      queryClient.setQueryData<{ following: boolean }>(queryKey, { following });
      return { previous };
    },
    onError: (_error, _following, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? { following: false });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ['creator-profile'] });
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
