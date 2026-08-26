import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Alert, Linking, Modal, Pressable, ScrollView, View } from 'react-native';

import { AppText } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  archivePost as runArchivePost,
  changePostVisibility,
  deletePost as runDeletePost,
  pickPostVisibility,
  restorePost as runRestorePost,
  toPostLifecyclePost,
} from '@/lib/post-lifecycle';
import { refreshViewerMediaCaches } from '@/lib/viewer-media-cache';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import { immersiveViewerHref, type ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useReducedMotion } from '@/lib/motion';
import { haptic } from '@/lib/haptics';
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
  const linkedLifecyclePost = item.linkedPostId
    ? toPostLifecyclePost({
        id: item.linkedPostId,
        visibility: item.linkedPostVisibility,
        archivedAt: item.linkedPostArchivedAt,
        bundle: item.linkedPostBundle ?? null,
      })
    : null;

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
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: confirmLabel,
        style: destructive ? 'destructive' : 'default',
        onPress: async () => {
          try {
            await mutation();
            await refreshMedia();
          } catch {
            haptic.error();
            Alert.alert('Could not update media', 'Please try again.');
          }
        },
      },
    ]);
  };

  const updateVisibility = async (post: NonNullable<typeof linkedLifecyclePost>, visibility: 'public' | 'unlisted' | 'private') => {
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
          Alert.alert('Could not update media', 'Please try again.');
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
    if (action === 'change-linked-visibility' && linkedLifecyclePost) {
      pickPostVisibility(linkedLifecyclePost.visibility, (next) => void updateVisibility(linkedLifecyclePost, next));
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
        Alert.alert('No media file', 'This item does not have an openable media file.');
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
      Alert.alert(
        'Report content?',
        'Magicbooklet will send this post to the moderation team for a safety review.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Report content',
            style: 'destructive',
            onPress: async () => {
              try {
                await api.reportPost(item.showcasePostId!, {
                  reason: 'unsafe_content',
                  details: 'Reported from the mobile Showcase viewer.',
                });
                haptic.success();
                Alert.alert('Report received', 'Thank you. Our moderation team will review this content.');
              } catch (error) {
                haptic.error();
                Alert.alert('Could not report content', error instanceof Error ? error.message : 'Please try again.');
              }
            },
          },
        ]
      );
      return;
    }
    if (action === 'report-user' && item.creatorId) {
      if (!requireSignedIn()) return;
      Alert.alert(
        'Report user?',
        `Magicbooklet will review ${item.creatorLabel} for unsafe or abusive behavior.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Report user',
            style: 'destructive',
            onPress: async () => {
              try {
                await api.reportUser(item.creatorId!, {
                  reason: 'unsafe_content',
                  sourceSurface: 'showcase-reel',
                  details: item.showcasePostId ? `Reported from post ${item.showcasePostId}.` : undefined,
                });
                haptic.success();
                Alert.alert('Report received', 'Thank you. Our moderation team will review this user.');
              } catch (error) {
                haptic.error();
                Alert.alert('Could not report user', error instanceof Error ? error.message : 'Please try again.');
              }
            },
          },
        ]
      );
      return;
    }
    if (action === 'block-user' && item.creatorId) {
      if (!requireSignedIn()) return;
      const creatorId = item.creatorId;
      Alert.alert(
        `Block ${item.creatorLabel}?`,
        'Their posts will be hidden, and neither of you will be able to follow the other.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Block user',
            style: 'destructive',
            onPress: async () => {
              try {
                await api.blockUser(creatorId);
                await refreshMedia();
                onBlocked?.(creatorId);
              } catch (error) {
                haptic.error();
                Alert.alert('Could not block user', error instanceof Error ? error.message : 'Please try again.');
              }
            },
          },
        ]
      );
      return;
    }
    if (action === 'report-ai-output' && item.generationId) {
      if (!requireSignedIn()) return;
      Alert.alert(
        'Report offensive AI output?',
        'Send this generated result to the safety team so the model and provider output can be reviewed.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Report AI output',
            style: 'destructive',
            onPress: async () => {
              try {
                await api.reportGeneration(item.generationId!, {
                  reason: 'offensive_ai_output',
                  sourceSurface: 'generation-viewer',
                  details: 'Reported from the mobile generated-media viewer.',
                });
                haptic.success();
                Alert.alert('Report received', 'Thank you. The generated output was sent to the safety team.');
              } catch (error) {
                haptic.error();
                Alert.alert('Could not report AI output', error instanceof Error ? error.message : 'Please try again.');
              }
            },
          },
        ]
      );
      return;
    }
    if (action === 'view-details') {
      onDetails();
    }
  };

  return (
    <Modal animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose} transparent visible={visible}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.58)' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close media actions"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          style={{
            maxHeight: '62%',
            borderTopLeftRadius: appTheme.radii.xl,
            borderTopRightRadius: appTheme.radii.xl,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: appTheme.colors.borderStrong,
            backgroundColor: appTheme.colors.panel,
            paddingTop: appTheme.spacing.gap,
            paddingBottom: 34,
          }}
        >
          <View
            style={{
              width: 42,
              height: 4,
              borderRadius: 2,
              backgroundColor: appTheme.colors.borderStrong,
              alignSelf: 'center',
              marginBottom: appTheme.spacing.gap,
            }}
          />
          <ScrollView showsVerticalScrollIndicator={false}>
            {groupViewerActions(Array.from(new Set(actions))).map((group) => (
              <View key={group.label} style={{ paddingBottom: appTheme.spacing.compact }}>
                <AppText
                  selectable={false}
                  variant="caption"
                  color="faint"
                  style={{
                    paddingHorizontal: appTheme.spacing.panel,
                    paddingTop: appTheme.spacing.gap,
                    paddingBottom: 4,
                    textTransform: 'uppercase',
                    fontWeight: '800',
                    letterSpacing: 0.8,
                  }}
                >
                  {group.label}
                </AppText>
                {group.actions.map((action) => {
                  const disabledReason = item.disabledActions[action];
                  return (
                    <Pressable
                      key={action}
                      accessibilityRole="button"
                      accessibilityLabel={getViewerActionLabel(action, item.sourceType)}
                      disabled={Boolean(disabledReason)}
                      onPress={() => handleAction(action)}
                      style={({ pressed }) => ({
                        minHeight: 56,
                        paddingHorizontal: appTheme.spacing.panel,
                        paddingVertical: appTheme.spacing.gap,
                        justifyContent: 'center',
                        backgroundColor: pressed ? appTheme.colors.surface : 'transparent',
                        opacity: disabledReason ? appTheme.opacity.disabled : 1,
                      })}
                    >
                      <AppText
                        selectable={false}
                        variant="body"
                        color={isDestructiveViewerAction(action) ? appTheme.colors.danger : appTheme.colors.text}
                        style={{ fontWeight: '800' }}
                      >
                        {getViewerActionLabel(action, item.sourceType)}
                      </AppText>
                      {disabledReason ? (
                        <AppText variant="caption" color="faint" style={{ marginTop: 3 }}>
                          {disabledReason}
                        </AppText>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
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
