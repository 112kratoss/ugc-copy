import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  Archive,
  ArchiveRestore,
  Ban,
  Bookmark,
  BookmarkMinus,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus2,
  Flag,
  Info,
  LockKeyhole,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  UserRoundX,
  Wand2,
  type LucideIcon,
} from 'lucide-react-native';
import { Linking, Modal, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetActionGroup, SheetActionRow } from '@/components/sheet-action-group';
import { SheetBackdrop, SheetGrabber, SheetPanel, sheetPanelStyle, useSheetDismissDrag } from '@/components/sheet-chrome';
import { useAuth } from '@/lib/auth';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
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
import { refreshViewerMediaCaches } from '@/lib/viewer-media-cache';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import { immersiveViewerHref, type ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useReducedMotion } from '@/lib/motion';
import { haptic } from '@/lib/haptics';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import type { OwnerPostsResponse } from '@/lib/types';
import { getViewerActionGroupLabel, getViewerActionLabel, isDestructiveViewerAction } from '@/lib/viewer-actions';

export function ViewerActionSheet({
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
  visible,
}: {
  item: ImmersivePreviewItem;
  onClose: () => void;
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
  visible: boolean;
}) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
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
    // The profile grid pages its posts; the sales summary is still a single response.
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
    queryClient.setQueryData<OwnerPostsResponse>(['owner-posts-sales-summary', user?.id], removeFromOwnerPosts);
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
    onClose();

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
          if (outcome === 'done') await refreshMedia();
        });
        return;
      }
      confirmMutation(
        'Archive creation',
        'You can restore it later from your profile.',
        'Archive',
        () => api.archiveGeneration(item.id),
        true
      );
      return;
    }
    if (action === 'restore') {
      if (item.sourceType === 'owner-post') {
        void runRestorePost({ api, post: lifecyclePost }).then(async (outcome) => {
          if (outcome === 'done') await refreshMedia();
        });
        return;
      }
      confirmMutation(
        'Restore creation',
        'Return this item to your active media?',
        'Restore',
        () => api.restoreGeneration(item.id)
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

  return (
    <Modal animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose} transparent visible={visible}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <SheetBackdrop drag={drag} label="Close media actions" onPress={onClose} />
        <SheetPanel
          {...drag.contentPanHandlers}
          style={[
            sheetPanelStyle(),
            { maxHeight: '84%', paddingBottom: Math.max(bottomInset, appTheme.spacing.panel) },
            drag.dragStyle,
          ]}
        >
          <SheetGrabber drag={drag} />
          <ScrollView
            {...drag.scrollProps}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: appTheme.spacing.panel, gap: appTheme.spacing.gap }}
          >
            <View style={{ gap: 4, paddingBottom: 4 }}>
              <Text accessibilityRole="header" numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
                More options
              </Text>
              <Text numberOfLines={2} style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                {item.sourceType === 'showcase'
                  ? `Choose what you want to do with “${item.title}” or ${item.creatorLabel}.`
                  : `Choose what you want to do with “${item.title}”.`}
              </Text>
            </View>
            {groupViewerActions(Array.from(new Set(actions))).map((group) => (
              <View key={group.label} style={{ gap: 4 }}>
                <Text
                  accessibilityRole="header"
                  style={{
                    color: appTheme.colors.faint,
                    ...appTheme.type.caption,
                    textTransform: 'uppercase',
                    fontWeight: '800',
                    letterSpacing: 0.8,
                    paddingHorizontal: 4,
                    paddingTop: appTheme.spacing.compact,
                  }}
                >
                  {group.label}
                </Text>
                <SheetActionGroup testID={`viewer-action-group-${group.label}`}>
                  {group.actions.map((action) => {
                    const disabledReason = item.disabledActions[action];
                    return (
                      <SheetActionRow
                        key={action}
                        body={disabledReason ?? getViewerActionDescription(action, item)}
                        disabled={Boolean(disabledReason)}
                        icon={getViewerActionIcon(action)}
                        label={getViewerActionLabel(action, item.sourceType)}
                        onPress={() => handleAction(action)}
                        tone={isDestructiveViewerAction(action) ? 'danger' : 'default'}
                      />
                    );
                  })}
                </SheetActionGroup>
              </View>
            ))}
          </ScrollView>
        </SheetPanel>
      </View>
    </Modal>
  );
}

const VIEWER_ACTION_ICONS: Record<string, LucideIcon> = {
  save: Bookmark,
  unsave: BookmarkMinus,
  comment: MessageCircle,
  share: ShareGlyph,
  recreate: Wand2,
  'unlock-remix': LockKeyhole,
  publish: FilePlus2,
  archive: Archive,
  restore: ArchiveRestore,
  'delete-post': Trash2,
  'edit-post': Pencil,
  'change-visibility': Eye,
  'view-linked': ExternalLink,
  'edit-linked': Pencil,
  'edit-linked-resources': SlidersHorizontal,
  'change-linked-visibility': Eye,
  'open-original': ExternalLink,
  'view-details': Info,
  download: Download,
  'not-interested': EyeOff,
  'hide-creator': UserRoundX,
  'report-content': Flag,
  'report-user': ShieldAlert,
  'block-user': Ban,
  'report-ai-output': ShieldAlert,
};

function getViewerActionIcon(action: string) {
  return VIEWER_ACTION_ICONS[action] ?? MoreHorizontal;
}

function getViewerActionDescription(action: string, item: ImmersivePreviewItem) {
  switch (action) {
    case 'save':
      return 'Keep this post in your saved collection.';
    case 'unsave':
      return 'Remove this post from your saved collection.';
    case 'comment':
      return 'Open the conversation on this post.';
    case 'share':
      return 'Send this post or copy its link.';
    case 'recreate':
      return item.sourceType === 'showcase'
        ? 'Use this post as a starting point for your own creation.'
        : 'Create another result from the same setup.';
    case 'unlock-remix':
      return 'Unlock the creator’s recipe and make your own version.';
    case 'publish':
      return 'Turn this creation into a post for your profile.';
    case 'archive':
      return 'Move this item out of your active library.';
    case 'restore':
      return 'Return this item to your active library.';
    case 'delete-post':
      return 'Permanently remove this post and its media.';
    case 'edit-post':
      return 'Change the caption, media, or post settings.';
    case 'change-visibility':
    case 'change-linked-visibility':
      return 'Choose who can see this post.';
    case 'view-linked':
      return 'Open the post created from this media.';
    case 'edit-linked':
      return 'Edit the post created from this media.';
    case 'edit-linked-resources':
      return 'Choose what people receive when they unlock this post.';
    case 'open-original':
      return 'Open this media in its original post.';
    case 'view-details':
      return 'See the prompt, model, and creation information.';
    case 'download':
      return 'Open the original media file.';
    case 'not-interested':
      return 'Remove this post and show fewer recommendations like it.';
    case 'hide-creator':
      return `Remove posts from ${item.creatorLabel} from your recommendations.`;
    case 'report-content':
      return 'Send this post to the moderation team for review.';
    case 'report-user':
      return `Report ${item.creatorLabel} for unsafe or abusive behavior.`;
    case 'block-user':
      return `Hide ${item.creatorLabel}’s content and prevent future follows between you.`;
    case 'report-ai-output':
      return 'Send this generated result to the safety team for review.';
    default:
      return 'Choose this action for the current media.';
  }
}

function groupViewerActions(actions: string[]) {
  const groups: Array<{ label: string; actions: string[] }> = [];

  for (const action of actions) {
    const label = getViewerActionGroupLabel(action);
    const existing = groups.find((group) => group.label === label);
    if (existing) {
      existing.actions.push(action);
    } else {
      groups.push({ label, actions: [action] });
    }
  }

  return groups;
}
