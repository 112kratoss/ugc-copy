import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback } from 'react';
import { AccessibilityInfo } from 'react-native';

import { useAuth } from '@/lib/auth';
import {
  applyShowcaseSaveStateToInfiniteFeed,
  applyShowcaseSaveStateToPostResponse,
  scheduleShowcaseSaveCompletionEffects,
  type ShowcaseSaveStateResult,
} from '@/lib/showcase-save-cache';
import type { ShowcaseFeedResponse, ShowcasePostResponse } from '@/lib/types';

interface SaveVariables {
  postId: string;
  previousSaveCount: number;
  shouldSave: boolean;
}

/**
 * The feed-surface half of the viewer's save flow: same optimistic fan-out and
 * completion effects, without the viewer-only immersive source reconciliation.
 */
export function useShowcaseSaveMutation({
  sourceSurface = 'mobile-home-feed',
}: { sourceSurface?: string } = {}) {
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

  const mutation = useMutation({
    mutationFn: ({ postId, shouldSave }: SaveVariables) =>
      api.saveShowcasePost(postId, { shouldSave, sourceSurface }),
    onMutate: (variables) => {
      reconcile({
        postId: variables.postId,
        isSaved: variables.shouldSave,
        saveCount: Math.max(0, variables.previousSaveCount + (variables.shouldSave ? 1 : -1)),
      });
    },
    onError: (_error, variables) => {
      reconcile({
        postId: variables.postId,
        isSaved: !variables.shouldSave,
        saveCount: variables.previousSaveCount,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      void AccessibilityInfo.announceForAccessibility(
        variables.shouldSave
          ? 'Could not save. Please try again.'
          : 'Could not remove from saved. Please try again.'
      );
    },
    onSuccess: (result, variables) => {
      reconcile({
        postId: variables.postId,
        isSaved: result.isSaved,
        saveCount: result.saveCount,
      });
      scheduleShowcaseSaveCompletionEffects({
        postId: variables.postId,
        userId: user?.id,
        hapticFeedback: Haptics.selectionAsync,
        invalidateQueries: (filters) => queryClient.invalidateQueries(filters),
      });
      void AccessibilityInfo.announceForAccessibility(result.isSaved ? 'Saved' : 'Removed from saved');
    },
  });

  const toggleSave = useCallback((options: { postId: string; isSaved: boolean; saveCount: number }) => {
    if (!user) {
      router.push('/auth' as never);
      return;
    }

    mutation.mutate({
      postId: options.postId,
      previousSaveCount: options.saveCount,
      shouldSave: !options.isSaved,
    });
  }, [mutation, user]);

  return { toggleSave, isSaving: mutation.isPending };
}
