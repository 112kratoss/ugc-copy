import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback } from 'react';
import { AccessibilityInfo } from 'react-native';

import { useAuth } from '@/lib/auth';
import { adjustProfileStats } from '@/lib/profile-stats';
import { haptic } from '@/lib/haptics';
import { creatorSeesSaverFields } from '@/lib/saver-notice';
import {
  applyShowcaseSaveStateToInfiniteFeed,
  applyShowcaseSaveStateToPostResponse,
  scheduleShowcaseSaveCompletionEffects,
  type ShowcaseSaveStateResult,
} from '@/lib/showcase-save-cache';
import { SHOWCASE_SAVE_MUTATION_SCOPE, showcaseSaveIntents } from '@/lib/showcase-save-intent';
import type { ShowcaseFeedResponse, ShowcasePostResponse } from '@/lib/types';

interface SaveVariables {
  postId: string;
  previousSaveCount: number;
  shouldSave: boolean;
  /** Which tap this was, per post. See `createShowcaseSaveIntentLedger`. */
  intentSeq: number;
  /** Told the state the server settled on, unless a later tap overtook this one. */
  onSaved?: (isSaved: boolean) => void;
}

/**
 * The feed-surface half of the viewer's save flow: same optimistic fan-out and
 * completion effects, without the viewer-only immersive source reconciliation.
 */
export function useShowcaseSaveMutation({
  sourceSurface = 'mobile-home-feed',
  authReturnTo,
}: {
  sourceSurface?: string;
  /**
   * Where sign-in comes back to after a signed-out tap: the screen the post
   * is on. Without it, sign-in ends on Home and the post is lost.
   */
  authReturnTo?: string;
} = {}) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();

  const reconcile = useCallback((result: ShowcaseSaveStateResult) => {
    queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
      { queryKey: ['showcase-feed'] },
      (current) => applyShowcaseSaveStateToInfiniteFeed(current, result)
    );
    queryClient.setQueriesData<ShowcasePostResponse>(
      { queryKey: ['showcase-post', result.postId] },
      (current) => applyShowcaseSaveStateToPostResponse(current, result)
    );
  }, [queryClient]);

  // Only the newest tap for a post may settle it; see the ledger's own note.
  const hasBeenOvertaken = useCallback(
    (variables: SaveVariables) => showcaseSaveIntents.isOvertaken(variables.postId, variables.intentSeq),
    []
  );

  const mutation = useMutation({
    scope: SHOWCASE_SAVE_MUTATION_SCOPE,
    mutationFn: async ({ postId, shouldSave }: SaveVariables) =>
      api.saveShowcasePost(postId, { shouldSave, sourceSurface, ...(await creatorSeesSaverFields(shouldSave)) }),
    onMutate: (variables) => {
      reconcile({
        postId: variables.postId,
        isSaved: variables.shouldSave,
        saveCount: Math.max(0, variables.previousSaveCount + (variables.shouldSave ? 1 : -1)),
      });
      // The profile header's Saved count moves with the tap; the profile
      // refetch scheduled on success confirms it.
      adjustProfileStats(queryClient, user?.id, { saved: variables.shouldSave ? 1 : -1 });
    },
    onError: (_error, variables) => {
      if (hasBeenOvertaken(variables)) return;
      reconcile({
        postId: variables.postId,
        isSaved: !variables.shouldSave,
        saveCount: variables.previousSaveCount,
      });
      adjustProfileStats(queryClient, user?.id, { saved: variables.shouldSave ? -1 : 1 });
      haptic.error();
      void AccessibilityInfo.announceForAccessibility(
        variables.shouldSave
          ? 'Could not save. Please try again.'
          : 'Could not remove from saved. Please try again.'
      );
    },
    onSuccess: (result, variables) => {
      if (hasBeenOvertaken(variables)) return;
      reconcile({
        postId: variables.postId,
        isSaved: result.isSaved,
        saveCount: result.saveCount,
      });
      scheduleShowcaseSaveCompletionEffects({
        postId: variables.postId,
        userId: user?.id,
        invalidateQueries: (filters) => queryClient.invalidateQueries(filters),
      });
      void AccessibilityInfo.announceForAccessibility(result.isSaved ? 'Saved' : 'Removed from saved');
      // After the guard above, as the reel's own: an overtaken tap does not
      // report itself to ranking. A failed one never gets here.
      variables.onSaved?.(result.isSaved);
    },
    onSettled: (_result, _error, variables) => {
      showcaseSaveIntents.close(variables.postId, variables.intentSeq);
    },
  });

  const { mutate } = mutation;

  const toggleSave = useCallback((options: {
    postId: string;
    isSaved: boolean;
    saveCount: number;
    /**
     * Told the state the server settled on, once it has answered this tap and
     * no later tap overtook it: Home reports the save to the feed's ranking
     * here, as the reel does.
     */
    onSaved?: (isSaved: boolean) => void;
  }) => {
    if (!user) {
      router.push((authReturnTo ? { pathname: '/auth', params: { returnTo: authReturnTo } } : '/auth') as never);
      return;
    }

    // The tick belongs to the tap. Saving is optimistic — the heart has already
    // flipped by the time the request leaves — so firing from the mutation's
    // completion put the feedback a whole round trip behind the finger, and
    // gave a failed save a buzz it had not earned.
    haptic.light();
    const intentSeq = showcaseSaveIntents.open(options.postId);
    // `mutation.mutate` rather than `mutation`: React Query returns a fresh
    // result object every render, so depending on it made `toggleSave` a new
    // function each time — which made the home feed's `renderCard` unstable and
    // defeated memoization of every cell. `mutate` itself is bound to the
    // observer and stable for the hook's lifetime.
    mutate({
      postId: options.postId,
      previousSaveCount: options.saveCount,
      shouldSave: !options.isSaved,
      intentSeq,
      onSaved: options.onSaved,
    });
  }, [authReturnTo, mutate, user]);

  return { toggleSave, isSaving: mutation.isPending };
}
