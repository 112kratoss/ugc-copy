import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { AccessibilityInfo, Linking } from 'react-native';

import type { createApiClient } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { showActionSheet } from '@/lib/action-sheet';
import { setCachedCreatorProfileBlocked } from '@/lib/creator-profile-view-model';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import { immersiveViewerHref, type ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import {
  archivePost as runArchivePost,
  changePostVisibility,
  deletePost as runDeletePost,
  pickPostVisibility,
  resolveLinkedLifecyclePost,
  restorePost as runRestorePost,
  toPostLifecyclePost,
  type PostLifecyclePost,
} from '@/lib/post-lifecycle';
import type { OwnerPostsResponse } from '@/lib/types';
import { adjustProfileStats, invalidateProfileStats } from '@/lib/profile-stats';
import { creatorFollowStateQueryKey } from '@/lib/use-creator-follow';
import { getViewerSafetyActions } from '@/lib/viewer-actions';
import { refreshViewerMediaCaches } from '@/lib/viewer-media-cache';

/**
 * What a screen hands the viewer's actions for one item: the parts of an action
 * that belong to the screen (opening comments or details, sharing, leaving the
 * reel after a delete) rather than to the item.
 */
export interface ViewerActionCallbacks {
  onComments?: () => void;
  onDetails: () => void;
  onHideCreator?: () => void;
  onNotInterested?: () => void;
  onRecreate: () => void;
  /**
   * The screen's own Save, where it has one: the reel's is optimistic and
   * tells the ranker. Without it the row saves through the API and refreshes
   * every cache that shows the item.
   */
  onSave?: (item: ImmersivePreviewItem) => void;
  onShare: () => void;
  onDeleted?: (postId: string) => void;
  /**
   * A block went through, and the screen takes the creator's posts out of what
   * it shows and of the feed lanes: the reel, which then moves on to the next
   * post by someone else. Without it, a block refreshes every cache instead.
   */
  onBlocked?: (userId: string) => void;
  /** A report about the post went through: the reel takes the post out and moves on, as the web's does. */
  onReported?: (item: ImmersivePreviewItem) => void;
  onUnlockRemix?: () => void;
  onSourceRefresh: () => void;
  /**
   * Where sign-in comes back to when a signed-out reader picks an action that
   * needs an account (Report, Block): the screen showing this item. Without
   * it, sign-in ends on Home and the reader has lost the post.
   */
  authReturnTo?: string;
}

/**
 * The actions a viewer item offers and what each one does, shared by the two
 * places they are drawn: the native menu on the item's ••• (`components/
 * viewer-actions-menu.tsx`) and `ViewerActionSheet`, its fallback where native
 * menus are missing. `onClose` is the sheet's: it runs before every action.
 */
type PostReportReason = Parameters<ReturnType<typeof createApiClient>['reportPost']>[1]['reason'];

const POST_REPORT_REASONS: Array<{ label: string; value: PostReportReason; aboutRecipe?: boolean }> = [
  { label: 'Spam', value: 'spam' },
  { label: 'Stolen content', value: 'stolen_content' },
  { label: 'Misleading recipe', value: 'misleading_unlock', aboutRecipe: true },
  { label: 'Unsafe content', value: 'unsafe_content' },
  { label: 'Payment issue', value: 'payment_issue', aboutRecipe: true },
  { label: 'Something else', value: 'other' },
];

export function useViewerActionHandlers({
  item,
  onClose,
  onComments,
  onDetails,
  onHideCreator,
  onNotInterested,
  onRecreate,
  onSave,
  onShare,
  onDeleted,
  onBlocked,
  onReported,
  onUnlockRemix,
  onSourceRefresh,
  authReturnTo,
}: ViewerActionCallbacks & { item: ImmersivePreviewItem; onClose?: () => void }) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const actions = [
    ...item.availableActions,
    ...(onNotInterested ? ['not-interested'] : []),
    ...(onHideCreator ? ['hide-creator'] : []),
    ...getViewerSafetyActions(item, user?.id),
  ];

  const refreshMedia = async () => {
    await refreshViewerMediaCaches(queryClient, user?.id);
    onSourceRefresh();
  };

  const removeDeletedPostFromCaches = (postId: string) => {
    const removeFromOwnerPosts = (data: OwnerPostsResponse | undefined): OwnerPostsResponse | undefined =>
      data ? { ...data, posts: data.posts.filter((post) => post.id !== postId) } : data;
    const removeFromOwnerPostPages = (
      data: InfiniteData<OwnerPostsResponse> | undefined
    ): InfiniteData<OwnerPostsResponse> | undefined => (
      data
        ? { ...data, pages: data.pages.map((page) => removeFromOwnerPosts(page) ?? page) }
        : data
    );
    const removeFromSource = (data: ImmersiveSourceData | undefined): ImmersiveSourceData | undefined =>
      data?.ownerPosts
        ? { ...data, ownerPosts: data.ownerPosts.filter((post) => post.id !== postId) }
        : data;

    queryClient.setQueryData<InfiniteData<OwnerPostsResponse>>(['profile-owner-posts', user?.id], removeFromOwnerPostPages);
    queryClient.setQueriesData<ImmersiveSourceData>({ queryKey: ['immersive-preview-source'] }, removeFromSource);
  };

  // The owner-post record the policy reasons about: its own visibility and
  // recipe for a post item, the linked post's for a creation item.
  const lifecyclePost = toPostLifecyclePost({
    id: item.id,
    visibility: item.visibility,
    archivedAt: item.archivedAt,
    bundle: item.ownerPostBundle ?? null,
  });
  const deletePost = async () => {
    const outcome = await runDeletePost({ api, post: lifecyclePost });
    if (outcome !== 'done') return;
    removeDeletedPostFromCaches(item.id);
    adjustProfileStats(queryClient, user?.id, item.archivedAt ? { archivedPosts: -1 } : { posts: -1 });
    await refreshMedia();
    onDeleted?.(item.id);
  };

  const confirmMutation = (
    title: string,
    message: string,
    confirmLabel: string,
    mutation: () => Promise<unknown>,
    destructive = false
  ) => {
    void showConfirmDialog({ title, message, confirmLabel, destructive }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await mutation();
        await refreshMedia();
      } catch {
        haptic.error();
        showMessageDialog({ title: 'Could not update media', message: 'Please try again.' });
      }
    });
  };

  const updateVisibility = async (post: PostLifecyclePost, visibility: 'public' | 'unlisted' | 'private') => {
    const outcome = await changePostVisibility({ api, post, visibility });
    if (outcome === 'done') {
      await refreshMedia();
    }
  };

  const handleAction = (action: string) => {
    onClose?.();

    const requireSignedIn = () => {
      if (user) return true;
      router.push((authReturnTo ? { pathname: '/auth', params: { returnTo: authReturnTo } } : '/auth') as never);
      return false;
    };

    if (action === 'save' || action === 'unsave') {
      if (onSave) {
        onSave(item);
        return;
      }
      // A bookmark is reversible in place: no dialog, like the web.
      const shouldSave = action === 'save';
      void (async () => {
        try {
          if (item.showcasePostId) {
            await api.saveShowcasePost(item.showcasePostId, {
              shouldSave,
              sourceSurface: item.source === 'profile-saved' ? 'mobile-profile-saved' : 'mobile-viewer-actions',
            });
          }
          await refreshMedia();
        } catch {
          haptic.error();
          showMessageDialog({ title: 'Could not update media', message: 'Please try again.' });
        }
      })();
      return;
    }
    if (action === 'archive') {
      if (item.sourceType === 'owner-post') {
        void runArchivePost({ api, post: lifecyclePost }).then(async (outcome) => {
          if (outcome !== 'done') return;
          adjustProfileStats(queryClient, user?.id, { posts: -1, archivedPosts: 1 });
          await refreshMedia();
        });
        return;
      }
      confirmMutation(
        'Archive creation',
        'You can restore it later from your profile.',
        'Archive',
        () => api.archiveGeneration(item.id).then((result) => {
          adjustProfileStats(queryClient, user?.id, { creations: -1 });
          return result;
        }),
        true
      );
      return;
    }
    if (action === 'restore') {
      if (item.sourceType === 'owner-post') {
        void runRestorePost({ api, post: lifecyclePost }).then(async (outcome) => {
          if (outcome !== 'done') return;
          adjustProfileStats(queryClient, user?.id, { posts: 1, archivedPosts: -1 });
          await refreshMedia();
        });
        return;
      }
      confirmMutation(
        'Restore creation',
        'Return this item to your active media?',
        'Restore',
        () => api.restoreGeneration(item.id).then((result) => {
          adjustProfileStats(queryClient, user?.id, { creations: 1 });
          return result;
        })
      );
      return;
    }
    if (action === 'delete-post') {
      void deletePost();
      return;
    }
    if (action === 'publish') {
      router.push({ pathname: '/post/new', params: { generationId: item.id } } as never);
      return;
    }
    if (action === 'edit-post') {
      router.push({ pathname: '/post/new', params: { postId: item.id } } as never);
      return;
    }
    if (action === 'view-linked' && item.linkedPostId) {
      router.push(immersiveViewerHref({ source: 'profile-posts', initialId: item.linkedPostId }) as never);
      return;
    }
    if (action === 'edit-linked-resources' && item.linkedPostId) {
      router.push({ pathname: '/post/new', params: { postId: item.linkedPostId, focus: 'resources' } } as never);
      return;
    }
    if (action === 'change-linked-visibility' && item.linkedPostId) {
      // Read the linked post first when its details never loaded: whether the
      // change needs a confirmation depends on its bundle.
      void resolveLinkedLifecyclePost({ api, item }).then((post) => {
        if (post) pickPostVisibility(post.visibility, (next) => void updateVisibility(post, next));
      });
      return;
    }
    if (action === 'change-visibility') {
      pickPostVisibility(lifecyclePost.visibility, (next) => void updateVisibility(lifecyclePost, next));
      return;
    }
    if (action === 'recreate') {
      onRecreate();
      return;
    }
    if (action === 'unlock-remix') {
      onUnlockRemix?.();
      return;
    }
    if (action === 'comment') {
      onComments?.();
      return;
    }
    if (action === 'share') {
      onShare();
      return;
    }
    if (action === 'download') {
      const mediaUrl = item.mediaItems[0]?.url ?? item.mediaUrl;
      if (mediaUrl) {
        void Linking.openURL(mediaUrl);
      } else {
        showMessageDialog({
          title: 'No media file',
          message: 'This item does not have an openable media file.',
        });
      }
      return;
    }
    if (action === 'not-interested') {
      onNotInterested?.();
      return;
    }
    if (action === 'hide-creator') {
      onHideCreator?.();
      return;
    }
    if (action === 'report-content' && item.showcasePostId) {
      if (!requireSignedIn()) return;
      const postId = item.showcasePostId;
      // The recipe's own id (`post_resource_bundles.id`), so a report about
      // it reaches moderation with the recipe it concerns, as the web's does.
      const bundleId = item.details?.unlock?.resourceId;
      // The delivery the reel's impression went to, so the ranker hears the
      // report against the same delivery. A post read on its own has none.
      const deliveryId = item.recommendation?.deliveryId;
      // The web post page's reasons, so a stolen-work or misleading-recipe
      // report reaches moderation filed as one. The two about a recipe are
      // offered only on a post that has one.
      showActionSheet({
        title: 'Why are you reporting this?',
        message: 'Choose the closest reason so the moderation team can review it correctly.',
        actions: POST_REPORT_REASONS.filter((reason) => bundleId || !reason.aboutRecipe).map((reason) => ({
          label: reason.label,
          onPress: () => {
            void (async () => {
              try {
                await api.reportPost(postId, {
                  reason: reason.value,
                  details: 'Reported from the mobile Showcase viewer.',
                  ...(reason.aboutRecipe && bundleId ? { bundleId } : {}),
                  ...(deliveryId ? { deliveryId } : {}),
                });
                haptic.success();
                onReported?.(item);
                showMessageDialog({
                  title: 'Report received',
                  message: 'Thank you. Our moderation team will review this content.',
                });
              } catch (error) {
                haptic.error();
                showErrorDialog('Could not report content', error);
              }
            })();
          },
        })),
      });
      return;
    }
    if (action === 'report-user' && item.creatorId) {
      if (!requireSignedIn()) return;
      void showConfirmDialog({
        title: 'Report user?',
        message: `Magicbooklet will review ${item.creatorLabel} for unsafe or abusive behavior.`,
        confirmLabel: 'Report user',
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed) return;
        try {
          await api.reportUser(item.creatorId!, {
            // The reason the web files a creator under from its feed, Explore
            // and reel (`src/lib/moderation-client.ts`), so moderators see one.
            reason: 'harassment',
            sourceSurface: 'showcase-reel',
            details: item.showcasePostId ? `Reported from post ${item.showcasePostId}.` : undefined,
          });
          haptic.success();
          showMessageDialog({
            title: 'Report received',
            message: 'Thank you. Our moderation team will review this user.',
          });
        } catch (error) {
          haptic.error();
          showErrorDialog('Could not report user', error);
        }
      });
      return;
    }
    if (action === 'block-user' && item.creatorId) {
      if (!requireSignedIn()) return;
      const creatorId = item.creatorId;
      void showConfirmDialog({
        title: `Block ${item.creatorLabel}?`,
        message: 'Their posts will be hidden, and neither of you will be able to follow the other.',
        confirmLabel: 'Block user',
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed) return;
        try {
          await api.blockUser(creatorId);
        } catch (error) {
          haptic.error();
          showErrorDialog('Could not block user', error);
          return;
        }
        // Each cached page of the creator becomes what the server now answers
        // for them, "You blocked @x", written rather than read again:
        // invalidating every creator's grid refetched each of their loaded
        // pages (audit 02-8). A block ends both follows, so the reel's Follow
        // must not remember one.
        setCachedCreatorProfileBlocked(queryClient, creatorId);
        queryClient.setQueryData(creatorFollowStateQueryKey(creatorId), { following: false });
        if (!onBlocked) {
          // A screen that takes no posts out itself (the text post page) still
          // refreshes every cache that may show the creator.
          await refreshMedia();
          return;
        }
        // The reel takes the creator's posts out of itself and the feed lanes
        // and moves on, as Explore's tile and the web reel do. Refreshing every
        // feed instead re-ranked the lanes behind the reel as new sessions
        // (audit 02-4), so only what a block changes is read again: the
        // reader's Saved list and its count, which leave out a blocked
        // creator's posts.
        onBlocked(creatorId);
        haptic.success();
        void AccessibilityInfo.announceForAccessibility(`${item.creatorLabel} blocked.`);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['profile-saved-media', user?.id] }),
          invalidateProfileStats(queryClient, user?.id),
        ]);
      });
      return;
    }
    if (action === 'report-ai-output' && item.generationId) {
      if (!requireSignedIn()) return;
      void showConfirmDialog({
        title: 'Report offensive AI output?',
        message: 'Send this generated result to the safety team so the model and provider output can be reviewed.',
        confirmLabel: 'Report AI output',
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed) return;
        try {
          await api.reportGeneration(item.generationId!, {
            reason: 'offensive_ai_output',
            sourceSurface: 'generation-viewer',
            details: 'Reported from the mobile generated-media viewer.',
          });
          haptic.success();
          showMessageDialog({
            title: 'Report received',
            message: 'Thank you. The generated output was sent to the safety team.',
          });
        } catch (error) {
          haptic.error();
          showErrorDialog('Could not report AI output', error);
        }
      });
      return;
    }
    if (action === 'view-details') {
      onDetails();
    }
  };

  return { actions, handleAction, lifecyclePost, updateVisibility };
}
