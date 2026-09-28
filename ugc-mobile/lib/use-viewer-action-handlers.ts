import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Linking } from 'react-native';

import { useAuth } from '@/lib/auth';
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
import { adjustProfileStats } from '@/lib/profile-stats';
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
  onShare: () => void;
  onDeleted?: (postId: string) => void;
  onBlocked?: (userId: string) => void;
  onUnlockRemix?: () => void;
  onSourceRefresh: () => void;
}

/**
 * The actions a viewer item offers and what each one does, shared by the two
 * places they are drawn: the native menu on the item's ••• (`components/
 * viewer-actions-menu.tsx`) and `ViewerActionSheet`, its fallback where native
 * menus are missing. `onClose` is the sheet's: it runs before every action.
 */
export function useViewerActionHandlers({
  item,
  onClose,
  onComments,
  onDetails,
  onHideCreator,
  onNotInterested,
  onRecreate,
  onShare,
  onDeleted,
  onBlocked,
  onUnlockRemix,
  onSourceRefresh,
}: ViewerActionCallbacks & { item: ImmersivePreviewItem; onClose?: () => void }) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const canModerateCreator = item.sourceType === 'showcase'
    && Boolean(item.creatorId)
    && item.creatorId !== user?.id;
  const actions = [
    ...item.availableActions,
    ...(onNotInterested ? ['not-interested'] : []),
    ...(onHideCreator ? ['hide-creator'] : []),
    ...(item.sourceType === 'showcase' ? ['report-content'] : []),
    ...(canModerateCreator ? ['report-user', 'block-user'] : []),
    ...(item.sourceType === 'generation' && item.generationId ? ['report-ai-output'] : []),
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
      router.push('/auth');
      return false;
    };

    if (action === 'save' || action === 'unsave') {
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
    if (action === 'edit-linked' && item.linkedPostId) {
      router.push({ pathname: '/post/new', params: { postId: item.linkedPostId } } as never);
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
    if (action === 'open-original' && item.showcasePostId) {
      router.push(immersiveViewerHref({ source: 'showcase-feed', initialId: item.showcasePostId }) as never);
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
      void showConfirmDialog({
        title: 'Report content?',
        message: 'Magicbooklet will send this post to the moderation team for a safety review.',
        confirmLabel: 'Report content',
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed) return;
        try {
          await api.reportPost(item.showcasePostId!, {
            reason: 'unsafe_content',
            details: 'Reported from the mobile Showcase viewer.',
          });
          haptic.success();
          showMessageDialog({
            title: 'Report received',
            message: 'Thank you. Our moderation team will review this content.',
          });
        } catch (error) {
          haptic.error();
          showErrorDialog('Could not report content', error);
        }
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
            reason: 'unsafe_content',
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
          await refreshMedia();
          onBlocked?.(creatorId);
        } catch (error) {
          haptic.error();
          showErrorDialog('Could not block user', error);
        }
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
