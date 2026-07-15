import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Alert, Linking, Modal, Pressable, ScrollView, View } from 'react-native';

import { AppText } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import { immersiveViewerHref, type ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import type { OwnerPostsResponse } from '@/lib/types';
import { getViewerActionGroupLabel, getViewerActionLabel, isDestructiveViewerAction } from '@/lib/viewer-actions';

export function ViewerActionSheet({
  item,
  onClose,
  onDetails,
  onHideCreator,
  onNotInterested,
  onRecreate,
  onShare,
  onDeleted,
  onUnlockRemix,
  onSourceRefresh,
  visible,
}: {
  item: ImmersivePreviewItem;
  onClose: () => void;
  onDetails: () => void;
  onHideCreator?: () => void;
  onNotInterested?: () => void;
  onRecreate: () => void;
  onShare: () => void;
  onDeleted?: (postId: string) => void;
  onUnlockRemix?: () => void;
  onSourceRefresh: () => void;
  visible: boolean;
}) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const actions = [
    ...item.availableActions,
    ...(onNotInterested ? ['not-interested'] : []),
    ...(onHideCreator ? ['hide-creator'] : []),
  ];

  const refreshMedia = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
      queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
      queryClient.invalidateQueries({ queryKey: ['profile-saved-media', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['profile-generations', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['profile-owner-posts', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['home-generations', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['owner-posts-sales-summary', user?.id] }),
    ]);
    onSourceRefresh();
  };

  const removeDeletedPostFromCaches = (postId: string) => {
    const removeFromOwnerPosts = (data: OwnerPostsResponse | undefined): OwnerPostsResponse | undefined =>
      data ? { ...data, posts: data.posts.filter((post) => post.id !== postId) } : data;
    const removeFromSource = (data: ImmersiveSourceData | undefined): ImmersiveSourceData | undefined =>
      data?.ownerPosts
        ? { ...data, ownerPosts: data.ownerPosts.filter((post) => post.id !== postId) }
        : data;

    queryClient.setQueryData<OwnerPostsResponse>(['profile-owner-posts', user?.id], removeFromOwnerPosts);
    queryClient.setQueryData<OwnerPostsResponse>(['owner-posts-sales-summary', user?.id], removeFromOwnerPosts);
    queryClient.setQueriesData<ImmersiveSourceData>({ queryKey: ['immersive-preview-source'] }, removeFromSource);
  };

  const deletePost = async (force = false) => {
    try {
      if (force) {
        await api.deletePost(item.id, { force: true });
      } else {
        await api.deletePost(item.id);
      }
      removeDeletedPostFromCaches(item.id);
      await refreshMedia();
      onDeleted?.(item.id);
    } catch (error) {
      if (!force && isForceDeleteRequired(error)) {
        Alert.alert(
          'Delete post with paid unlocks?',
          'This post has paid unlock sales. Permanent delete removes the post for everyone and cannot be undone.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete permanently',
              style: 'destructive',
              onPress: () => {
                void deletePost(true);
              },
            },
          ]
        );
        return;
      }

      Alert.alert('Could not delete post', error instanceof Error ? error.message : 'Please try again.');
    }
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
            Alert.alert('Could not update media', 'Please try again.');
          }
        },
      },
    ]);
  };

  const updateVisibility = async (visibility: 'public' | 'unlisted' | 'private') => {
    try {
      await api.updatePost(item.id, { visibility });
      await refreshMedia();
    } catch {
      Alert.alert('Could not update visibility', 'Please try again.');
    }
  };

  const handleAction = (action: string) => {
    onClose();

    if (action === 'save' || action === 'unsave') {
      const shouldSave = action === 'save';
      confirmMutation(
        shouldSave ? 'Save post' : 'Unsave post',
        shouldSave ? 'Add this post to your saved media?' : 'Remove this post from your saved media?',
        shouldSave ? 'Save' : 'Unsave',
        () => item.showcasePostId
          ? api.saveShowcasePost(item.showcasePostId, {
              shouldSave,
              sourceSurface: item.source === 'profile-saved' ? 'mobile-profile-saved' : 'mobile-viewer-actions',
            })
          : Promise.resolve(),
        !shouldSave
      );
      return;
    }
    if (action === 'archive') {
      const isPost = item.sourceType === 'owner-post';
      confirmMutation(
        `Archive ${isPost ? 'post' : 'creation'}`,
        'You can restore it later from your profile.',
        'Archive',
        () => isPost ? api.archivePost(item.id) : api.archiveGeneration(item.id),
        true
      );
      return;
    }
    if (action === 'restore') {
      const isPost = item.sourceType === 'owner-post';
      confirmMutation(
        `Restore ${isPost ? 'post' : 'creation'}`,
        'Return this item to your active media?',
        'Restore',
        () => isPost ? api.restorePost(item.id) : api.restoreGeneration(item.id)
      );
      return;
    }
    if (action === 'delete-post') {
      Alert.alert(
        'Delete post permanently?',
        'This will permanently delete this post. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void deletePost();
            },
          },
        ]
      );
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
    if ((action === 'make-private' || action === 'make-public') && item.linkedPostId) {
      const nextVisibility = action === 'make-private' ? 'private' : 'public';
      const label = action === 'make-private' ? 'Make private' : 'Make public';
      confirmMutation(
        `${label}?`,
        action === 'make-private'
          ? 'This linked post will leave public surfaces until you make it public again.'
          : 'This linked post will return to public surfaces.',
        label,
        () => item.linkedPostId ? api.updatePost(item.linkedPostId, { visibility: nextVisibility }) : Promise.resolve()
      );
      return;
    }
    if (action === 'change-visibility') {
      Alert.alert('Change visibility', 'Choose who can see this post.', [
        { text: 'Public', onPress: () => void updateVisibility('public') },
        { text: 'Unlisted', onPress: () => void updateVisibility('unlisted') },
        { text: 'Private', onPress: () => void updateVisibility('private') },
        { text: 'Cancel', style: 'cancel' },
      ]);
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
            {groupViewerActions(actions).map((group) => (
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
                      accessibilityLabel={getViewerActionLabel(action)}
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
                        {getViewerActionLabel(action)}
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

function isForceDeleteRequired(error: unknown) {
  return error instanceof ApiError
    && error.status === 409
    && isRecord(error.details)
    && error.details.requiresForceDelete === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
