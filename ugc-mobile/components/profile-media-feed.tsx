import { useIsFocused } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer } from 'expo-video';
import { ArrowLeft, Globe, ImageOff, Images, LockKeyhole, MoreVertical, Play, Repeat2, Share2, Wand2 } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { ActivityIndicator, Alert, FlatList, Linking, Modal, Platform, Pressable, ScrollView, Share, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { FeedVideoPreview } from '@/components/feed-video-preview';
import { SecondaryButton, StatusBlock } from '@/components/ui';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import {
  getImmersiveInitialIndex,
  immersiveViewerHref,
  type ImmersivePreviewItem,
} from '@/lib/immersive-preview-view-model';
import {
  buildViewerItems,
  type ImmersiveSourceData,
  loadImmersiveSourceData,
  normalizeParam,
  normalizeViewerSource,
  readCachedImmersiveSourceData,
  readCachedProfile,
} from '@/lib/immersive-preview-source-data';
import { getProfileHandle } from '@/lib/profile-view-model';
import { useReducedMotion } from '@/lib/motion';
import {
  IMMERSIVE_HORIZONTAL_LIST_TUNING,
  IMMERSIVE_VERTICAL_LIST_TUNING,
} from '@/lib/media-performance';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import {
  applyShowcaseSaveStateToFeedResponse,
  applyShowcaseSaveStateToInfiniteFeed,
  applyShowcaseSaveStateToPostResponse,
  applyShowcaseSaveStateToSourceData,
  scheduleShowcaseSaveCompletionEffects,
  type ShowcaseSaveStateResult,
} from '@/lib/showcase-save-cache';
import { appTheme } from '@/lib/theme';
import type { ShowcaseFeedResponse, ShowcaseMediaItem, ShowcasePostResponse } from '@/lib/types';
import { getNativeRemixCreateHref } from '@/lib/viewer-actions';

type ProfileMediaFeedParams = {
  source?: string | string[];
  initialId?: string | string[];
};

type SaveMutationVariables = {
  postId: string;
  previousSaveCount: number;
  shouldSave: boolean;
  sourceSurface: string;
};

export function ProfileMediaFeedScreen() {
  const params = useLocalSearchParams<ProfileMediaFeedParams>();
  const requestedSource = normalizeViewerSource(params.source);
  const source = requestedSource === 'profile-posts' ? 'profile-posts' : 'profile-creations';
  const initialId = normalizeParam(params.initialId);
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const topBarHeight = topInset + 54;
  const pageHeight = Math.max(360, height - topBarHeight);
  const listRef = useRef<FlatList<ImmersivePreviewItem>>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [actionsOpenItemId, setActionsOpenItemId] = useState<string | null>(null);
  const [detailsOpenItemId, setDetailsOpenItemId] = useState<string | null>(null);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    initialData: () => readCachedProfile(queryClient, user?.id),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });

  const sourceQueryKey = useMemo(
    () => ['immersive-preview-source', source, user?.id ?? 'guest', initialId] as const,
    [initialId, source, user?.id]
  );

  const sourceQuery = useQuery({
    queryKey: sourceQueryKey,
    enabled: Boolean(source),
    initialData: () => readCachedImmersiveSourceData(queryClient, source, user?.id, initialId),
    queryFn: () => loadImmersiveSourceData({ api, source, initialId }),
    staleTime: 1000 * 45,
  });

  useEffect(() => {
    if (!isFocused) return;
    void sourceQuery.refetch?.();
  }, [isFocused, sourceQuery.refetch]);

  const ownerInfo = useMemo(() => ({
    creatorLabel: user ? getProfileHandle(profileQuery.data, user.email) : '@creator',
    creatorAvatar: profileQuery.data?.avatarUrl ?? null,
  }), [profileQuery.data, user]);

  const items = useMemo(
    () => buildViewerItems(source, sourceQuery.data, ownerInfo),
    [source, sourceQuery.data, ownerInfo]
  );
  const initialIndex = useMemo(() => getImmersiveInitialIndex(items, initialId), [items, initialId]);
  const resolvedActiveIndex = activeIndex ?? initialIndex;
  const activeItem = items[resolvedActiveIndex] ?? items[initialIndex] ?? items[0];
  const title = source === 'profile-posts' ? 'Posts' : 'Creations';

  const refreshMediaSources = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
      queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
      queryClient.invalidateQueries({ queryKey: ['profile-generations', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['profile-owner-posts', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['home-generations', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['owner-posts-sales-summary', user?.id] }),
    ]);
    await sourceQuery.refetch();
  };

  useEffect(() => {
    if (!items.length) return;
    const frame = scheduleFrame(() => {
      setActiveIndex(initialIndex);
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
    });
    return () => cancelFrame(frame);
  }, [initialIndex, items.length]);

  const reconcileShowcaseSave = (
    result: ShowcaseSaveStateResult,
    options: { removeWhenUnsaved?: boolean } = {}
  ) => {
    queryClient.setQueryData<ImmersiveSourceData>(sourceQueryKey, (data) =>
      applyShowcaseSaveStateToSourceData(data, result, options)
    );
    queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>({ queryKey: ['showcase-feed'] }, (data) =>
      applyShowcaseSaveStateToInfiniteFeed(data, result)
    );
    queryClient.setQueriesData<ShowcasePostResponse>({ queryKey: ['showcase-post', result.postId] }, (data) =>
      applyShowcaseSaveStateToPostResponse(data, result)
    );
    queryClient.setQueryData<ShowcaseFeedResponse>(['profile-saved-media', user?.id], (data) =>
      applyShowcaseSaveStateToFeedResponse(data, result, {
        removeWhenUnsaved: true,
      })
    );
  };

  const saveMutation = useMutation({
    mutationFn: ({ postId, shouldSave, sourceSurface }: SaveMutationVariables) =>
      api.saveShowcasePost(postId, { shouldSave, sourceSurface }),
    onMutate: async (variables) => {
      reconcileShowcaseSave({
        postId: variables.postId,
        isSaved: variables.shouldSave,
        saveCount: Math.max(0, variables.previousSaveCount + (variables.shouldSave ? 1 : -1)),
      });
    },
    onError: (_error, variables) => {
      reconcileShowcaseSave({
        postId: variables.postId,
        isSaved: !variables.shouldSave,
        saveCount: variables.previousSaveCount,
      });
    },
    onSuccess: (result, variables) => {
      reconcileShowcaseSave({
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
    },
  });

  const linkedVisibilityMutation = useMutation({
    mutationFn: async ({ postId, visibility }: { postId: string; visibility: 'public' | 'private' }) =>
      api.updatePost(postId, { visibility }),
    onSuccess: async () => {
      await Haptics.selectionAsync();
      await refreshMediaSources();
    },
    onError: () => {
      Alert.alert('Could not update visibility', 'Please try again.');
    },
  });

  const saveItem = (item: ImmersivePreviewItem) => {
    if (!item.canSave || !item.showcasePostId) return;
    if (!user) {
      router.push('/auth');
      return;
    }
    saveMutation.mutate({
      postId: item.showcasePostId,
      previousSaveCount: item.saveCount,
      shouldSave: !item.isSaved,
      sourceSurface: 'mobile-profile-media-feed',
    });
  };

  const shareItem = async (item: ImmersivePreviewItem) => {
    if (!item.canShare) return;
    const url = item.sharePath ? `${env.siteUrl}${item.sharePath}` : null;
    await Share.share({
      title: item.title,
      message: url ? `${item.title}\n${url}` : `${item.title}\n${item.displayText}`,
      url: url ?? undefined,
    });
    if (item.showcasePostId) {
      await api.shareShowcasePost(item.showcasePostId, 'native-share').catch(() => null);
    }
  };

  const recreateItem = async (item: ImmersivePreviewItem) => {
    if (!user) {
      router.push('/auth');
      return;
    }

    if (item.sourceType === 'showcase' && item.showcasePostId) {
      const response = await api.remixShowcasePost(item.showcasePostId);
      const nativeHref = getNativeRemixCreateHref({
        redirectTo: response.redirectTo,
        recreateTool: item.recreateTool,
        prompt: response.prefill?.prompt ?? item.recreatePrompt,
      });
      if (nativeHref) {
        router.push(nativeHref as never);
        return;
      }
      if (response.redirectTo) {
        await Linking.openURL(`${env.siteUrl}${response.redirectTo}`);
        return;
      }
    }

    const fallbackHref = getNativeRemixCreateHref({
      recreateTool: item.recreateTool,
      prompt: item.recreatePrompt,
    });
    router.push((fallbackHref ?? `/create/${item.recreateTool}`) as never);
  };

  const publishItem = (item: ImmersivePreviewItem) => {
    if (!user) {
      router.push('/auth');
      return;
    }
    const generationId = item.generationId ?? item.id;
    router.push({ pathname: '/post/new', params: { generationId } } as never);
  };

  const manageUnlockItem = (item: ImmersivePreviewItem) => {
    const postId = item.linkedPostId ?? item.ownerPostId ?? item.showcasePostId;
    if (!postId) return;
    router.push({ pathname: '/post/new', params: { postId, focus: 'resources' } } as never);
  };

  const openLinkedPost = (item: ImmersivePreviewItem) => {
    if (!item.linkedPostId) return;
    router.push(immersiveViewerHref({ source: 'profile-posts', initialId: item.linkedPostId }) as never);
  };

  const confirmLinkedVisibilityChange = (item: ImmersivePreviewItem, visibility: 'public' | 'private') => {
    if (!user) {
      router.push('/auth');
      return;
    }
    if (!item.linkedPostId) return;

    const makePrivate = visibility === 'private';
    Alert.alert(
      makePrivate ? 'Make private?' : 'Make public?',
      makePrivate
        ? 'This linked post will leave public surfaces until you make it public again.'
        : 'This linked post will return to public surfaces.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: makePrivate ? 'Make private' : 'Make public',
          style: makePrivate ? 'destructive' : 'default',
          onPress: () => {
            if (item.linkedPostId) {
              linkedVisibilityMutation.mutate({ postId: item.linkedPostId, visibility });
            }
          },
        },
      ]
    );
  };

  if (!items.length && sourceQuery.isLoading) {
    return (
      <ProfileFeedShell topInset={topInset} bottomInset={bottomInset}>
        <ActivityIndicator accessibilityLabel="Loading profile media" color={appTheme.colors.primary} />
      </ProfileFeedShell>
    );
  }

  if (!items.length && sourceQuery.isError) {
    return (
      <ProfileFeedShell topInset={topInset} bottomInset={bottomInset}>
        <View style={{ width: '100%', maxWidth: 420, gap: 12 }}>
          <StatusBlock
            tone="danger"
            title={`Couldn't load ${title.toLowerCase()}`}
            body="Check your connection and try again."
          />
          <SecondaryButton
            label="Try again"
            onPress={() => void sourceQuery.refetch()}
          />
        </View>
      </ProfileFeedShell>
    );
  }

  if (!items.length) {
    return (
      <ProfileFeedShell topInset={topInset} bottomInset={bottomInset}>
        <Text selectable style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '700' }}>No items found in this section.</Text>
      </ProfileFeedShell>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <ProfileFeedTopBar
        activeItem={activeItem}
        sourceTitle={title}
        topInset={topInset}
        onActionsOpen={() => {
          if (activeItem) setActionsOpenItemId(activeItem.id);
        }}
      />
      <FlatList
        ref={listRef}
        data={items}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: pageHeight, offset: pageHeight * index, index })}
        initialNumToRender={IMMERSIVE_VERTICAL_LIST_TUNING.initialNumToRender}
        initialScrollIndex={initialIndex}
        keyExtractor={(item) => `${item.source}-${item.id}`}
        maxToRenderPerBatch={IMMERSIVE_VERTICAL_LIST_TUNING.maxToRenderPerBatch}
        onMomentumScrollEnd={(event) => {
          const nextIndex = Math.round(event.nativeEvent.contentOffset.y / pageHeight);
          setActiveIndex(Math.max(0, Math.min(items.length - 1, nextIndex)));
          setActionsOpenItemId(null);
          setDetailsOpenItemId(null);
        }}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset: pageHeight * index, animated: false });
          });
        }}
        pagingEnabled
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item, index }) => (
          <ProfileFeedPage
            active={isFocused && index === resolvedActiveIndex}
            bottomInset={bottomInset}
            height={pageHeight}
            item={item}
            onLinkedVisibilityChange={(visibility) => confirmLinkedVisibilityChange(item, visibility)}
            onManageUnlock={() => manageUnlockItem(item)}
            onOpenLinkedPost={() => openLinkedPost(item)}
            onPublish={() => publishItem(item)}
            onRecreate={() => void recreateItem(item)}
            onSave={() => saveItem(item)}
            onShare={() => void shareItem(item)}
            saveLoading={saveMutation.isPending && saveMutation.variables?.postId === item.showcasePostId}
            visibilityLoading={linkedVisibilityMutation.isPending && linkedVisibilityMutation.variables?.postId === item.linkedPostId}
            width={width}
          />
        )}
        showsVerticalScrollIndicator={false}
        snapToInterval={pageHeight}
        style={{ flex: 1, backgroundColor: appTheme.colors.background }}
        testID="profile-media-feed-list"
        windowSize={IMMERSIVE_VERTICAL_LIST_TUNING.windowSize}
      />
      {activeItem ? (
        <>
          <ViewerActionSheet
            item={activeItem}
            onClose={() => setActionsOpenItemId(null)}
            onDetails={() => {
              setActionsOpenItemId(null);
              setDetailsOpenItemId(activeItem.id);
            }}
            onRecreate={() => void recreateItem(activeItem)}
            onShare={() => void shareItem(activeItem)}
            onDeleted={() => {
              setActionsOpenItemId(null);
              setDetailsOpenItemId(null);
            }}
            onSourceRefresh={() => void sourceQuery.refetch()}
            visible={actionsOpenItemId === activeItem.id}
          />
          <ProfileFeedDetailsSheet
            bottomInset={bottomInset}
            item={activeItem}
            onClose={() => setDetailsOpenItemId(null)}
            visible={detailsOpenItemId === activeItem.id}
          />
        </>
      ) : null}
    </View>
  );
}

function ProfileFeedShell({ topInset, bottomInset, children }: { topInset: number; bottomInset: number; children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.background, paddingTop: topInset, paddingBottom: bottomInset, paddingHorizontal: 24 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={() => router.back()}
        style={{ position: 'absolute', left: 12, top: topInset + 7, width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.panelSoft }}
      >
        <ArrowLeft size={27} color={appTheme.colors.text} strokeWidth={2.4} />
      </Pressable>
      {children}
    </View>
  );
}

function ProfileFeedTopBar({
  activeItem,
  sourceTitle,
  topInset,
  onActionsOpen,
}: {
  activeItem?: ImmersivePreviewItem;
  sourceTitle: string;
  topInset: number;
  onActionsOpen: () => void;
}) {
  return (
    <View
      style={{
        height: topInset + 54,
        paddingTop: topInset,
        borderBottomWidth: 1,
        borderBottomColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.panel,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 8,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={() => router.back()}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
          opacity: pressed ? 0.68 : 1,
        })}
      >
        <ArrowLeft size={27} color={appTheme.colors.text} strokeWidth={2.4} />
      </Pressable>
      <Text numberOfLines={1} style={{ color: appTheme.colors.text, fontSize: 19, fontWeight: '700' }}>
        {sourceTitle}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open media options"
        disabled={!activeItem}
        onPress={onActionsOpen}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
          opacity: !activeItem ? 0.38 : pressed ? 0.68 : 1,
        })}
      >
        <MoreVertical size={25} color={appTheme.colors.text} strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}

function ProfileFeedPage({
  active,
  bottomInset,
  height,
  item,
  onLinkedVisibilityChange,
  onManageUnlock,
  onOpenLinkedPost,
  onPublish,
  onRecreate,
  onSave,
  onShare,
  saveLoading,
  visibilityLoading,
  width,
}: {
  active: boolean;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onLinkedVisibilityChange: (visibility: 'public' | 'private') => void;
  onManageUnlock: () => void;
  onOpenLinkedPost: () => void;
  onPublish: () => void;
  onRecreate: () => void;
  onSave: () => void;
  onShare: () => void;
  saveLoading: boolean;
  visibilityLoading: boolean;
  width: number;
}) {
  const displayText = shouldShowFeedBody(item.title, item.displayText) ? item.displayText : '';

  return (
    <ScrollView
      contentContainerStyle={{
        minHeight: height,
        paddingBottom: bottomInset + 30,
      }}
      nestedScrollEnabled
      showsVerticalScrollIndicator={false}
      style={{ width, height, backgroundColor: appTheme.colors.background }}
    >
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 }}>
        <ProfileFeedCreatorRow item={item} />
      </View>
      <ProfileFeedMediaCarousel active={active} item={item} width={width} />
      <ProfileFeedActionRow
        item={item}
        onLinkedVisibilityChange={onLinkedVisibilityChange}
        onManageUnlock={onManageUnlock}
        onOpenLinkedPost={onOpenLinkedPost}
        onPublish={onPublish}
        onRecreate={onRecreate}
        onSave={onSave}
        onShare={onShare}
        saveLoading={saveLoading}
        visibilityLoading={visibilityLoading}
      />
      <View style={{ paddingHorizontal: 14, paddingTop: 8, gap: 8 }}>
        <Text selectable numberOfLines={2} style={{ color: appTheme.colors.text, ...appTheme.type.sectionTitle, fontWeight: '800' }}>
          {item.title}
        </Text>
        {displayText ? (
          <Text selectable numberOfLines={4} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm, fontWeight: '600' }}>
            {displayText}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 3 }}>
          <ProfileFeedMetaPill label={item.badge} />
          <ProfileFeedMetaPill label={item.sourceType === 'generation' ? creationStateLabel(item) : postStateLabel(item)} />
        </View>
      </View>
    </ScrollView>
  );
}

function ProfileFeedCreatorRow({ item }: { item: ImmersivePreviewItem }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <ProfileFeedAvatar item={item} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: appTheme.colors.text, fontSize: 15, fontWeight: '700' }}>
          {item.creatorLabel}
        </Text>
        <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '700' }}>
          {item.sourceType === 'generation' ? creationStateLabel(item) : postStateLabel(item)}
        </Text>
      </View>
    </View>
  );
}

function ProfileFeedAvatar({ item }: { item: ImmersivePreviewItem }) {
  const initial = item.creatorLabel.replace(/^@/, '').trim()[0]?.toUpperCase() || 'C';

  return (
    <View style={{ width: 38, height: 38, borderRadius: 19, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.panelSoft, borderWidth: 1, borderColor: appTheme.colors.border }}>
      {item.creatorAvatar ? (
        <Image source={{ uri: item.creatorAvatar }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
      ) : (
        <Text style={{ color: appTheme.colors.text, fontSize: 15, fontWeight: '800' }}>{initial}</Text>
      )}
    </View>
  );
}

function ProfileFeedMediaCarousel({ active, item, width }: { active: boolean; item: ImmersivePreviewItem; width: number }) {
  const pages = item.previewKind === 'text' || !item.mediaItems.length
    ? []
    : item.mediaItems;
  const [currentIndex, setCurrentIndex] = useState(0);
  const frameWidth = Math.min(width, 430);
  const fallbackHeight = Math.round(frameWidth * 1.05);

  if (!pages.length) {
    return (
      <View style={{ width, paddingHorizontal: 14 }}>
        <View
          style={{
            minHeight: 360,
            borderRadius: appTheme.radii.lg,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: appTheme.colors.border,
            backgroundColor: appTheme.colors.panelSoft,
            justifyContent: 'center',
            padding: 18,
          }}
        >
          <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: `${appTheme.colors.motion}1f`, marginBottom: 14 }}>
            <Wand2 size={18} color={appTheme.colors.motion} />
          </View>
          <Text selectable numberOfLines={10} style={{ color: appTheme.colors.text, fontSize: 19, lineHeight: 26, fontWeight: '700' }}>
            {item.displayText || item.title}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View>
      <FlatList
        data={pages}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        horizontal
        initialNumToRender={IMMERSIVE_HORIZONTAL_LIST_TUNING.initialNumToRender}
        keyExtractor={(mediaItem) => mediaItem.id}
        maxToRenderPerBatch={IMMERSIVE_HORIZONTAL_LIST_TUNING.maxToRenderPerBatch}
        onMomentumScrollEnd={(event) => {
          const nextIndex = Math.round(event.nativeEvent.contentOffset.x / width);
          setCurrentIndex(Math.max(0, Math.min(pages.length - 1, nextIndex)));
        }}
        pagingEnabled
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item: mediaItem, index }) => (
          <View style={{ width, alignItems: 'center', backgroundColor: appTheme.colors.surfaceInset }}>
            <ProfileFeedMediaFrame
              active={active && index === currentIndex}
              mediaItem={mediaItem}
              width={frameWidth}
              height={mediaFrameHeight(mediaItem, frameWidth, fallbackHeight)}
            />
          </View>
        )}
        showsHorizontalScrollIndicator={false}
        windowSize={IMMERSIVE_HORIZONTAL_LIST_TUNING.windowSize}
      />
      {pages.length > 1 ? (
        <>
          <View style={{ position: 'absolute', top: 10, right: 12, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.58)', paddingHorizontal: 9, paddingVertical: 5 }}>
            <Text style={{ color: appTheme.colors.text, fontSize: 12, fontWeight: '700' }}>{currentIndex + 1}/{pages.length}</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 5, paddingTop: 10 }}>
            {pages.map((mediaItem, index) => (
              <View
                key={`dot-${mediaItem.id}`}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: index === currentIndex ? appTheme.colors.primary : appTheme.colors.borderStrong,
                }}
              />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function ProfileFeedMediaFrame({ active, mediaItem, width, height }: { active: boolean; mediaItem: ShowcaseMediaItem; width: number; height: number }) {
  if (mediaItem.mediaKind === 'video') {
    const posterUrl = mediaItem.previewUrl ?? null;
    if (active && mediaItem.url) {
      return (
        <ActiveProfileFeedVideo
          url={mediaItem.url}
          previewUrl={posterUrl}
          previewCacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
          previewThumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
          width={width}
          height={height}
          recyclingKey={`profile-feed:${mediaItem.id}`}
        />
      );
    }

    if (posterUrl) {
      return (
        <View style={{ width, height }}>
          <FeedMediaFrame
            kind="image"
            url={posterUrl}
            backdropUrl={posterUrl}
            cacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
            thumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
            recyclingKey={`profile-feed:${mediaItem.id}`}
            radius={0}
            style={{ width, height }}
          />
          <ProfileFeedPlayBadge />
        </View>
      );
    }

    return (
      <View style={{ width, height, backgroundColor: appTheme.colors.surfaceInset }}>
        <FeedVideoPreview
          url={mediaItem.url}
          active={false}
          height={height}
          radius={0}
          accent={appTheme.colors.video}
        />
        <ProfileFeedPlayBadge />
      </View>
    );
  }

  if (mediaItem.url) {
    return (
      <FeedMediaFrame
        kind="image"
        url={mediaItem.url}
        backdropUrl={mediaItem.previewUrl}
        cacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
        thumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
        recyclingKey={`profile-feed:${mediaItem.id}`}
        radius={0}
        style={{ width, height }}
      />
    );
  }

  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceInset }}>
      <ImageOff size={32} color={appTheme.colors.faint} />
    </View>
  );
}

function ActiveProfileFeedVideo({
  url,
  previewUrl,
  previewCacheKey,
  previewThumbhash,
  width,
  height,
  recyclingKey,
}: {
  url: string;
  previewUrl?: string | null;
  previewCacheKey?: string;
  previewThumbhash?: string | null;
  width: number;
  height: number;
  recyclingKey: string;
}) {
  const [hasFrame, setHasFrame] = useState(false);
  const [hasError, setHasError] = useState(false);
  const reducedMotion = useReducedMotion();
  const player = useVideoPlayer({ uri: url, useCaching: true }, (instance) => {
    instance.loop = true;
    instance.muted = false;
    instance.volume = 1.0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
  });
  const [isPlaying, setIsPlaying] = useState(player.playing);

  useEffect(() => {
    if (reducedMotion) {
      player.pause();
      setIsPlaying(false);
      return;
    }

    player.play();
    setIsPlaying(player.playing);
  }, [player, reducedMotion]);

  useEffect(() => {
    setHasFrame(false);
    setHasError(false);
  }, [player, url]);

  useEffect(() => {
    const subscription = player.addListener('playingChange', (event: { isPlaying: boolean }) => {
      setIsPlaying(event.isPlaying);
    });
    return () => {
      subscription.remove();
    };
  }, [player]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', (event) => {
      setHasError(event.status === 'error');
    });
    return () => {
      subscription.remove();
    };
  }, [player]);

  const togglePlayback = () => {
    if (player.playing) {
      player.pause();
      setIsPlaying(false);
      return;
    }
    player.play();
    setIsPlaying(true);
  };

  return (
    <View style={{ width, height, backgroundColor: appTheme.colors.surfaceInset }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
        onPress={togglePlayback}
        style={{ width, height, alignItems: 'center', justifyContent: 'center' }}
      >
        <FeedMediaFrame
          kind="video"
          player={player}
          backdropUrl={previewUrl}
          posterUrl={previewUrl}
          posterVisible={Boolean(previewUrl && (!hasFrame || hasError))}
          cacheKey={previewCacheKey}
          thumbhash={previewThumbhash}
          recyclingKey={recyclingKey}
          radius={0}
          style={{ width, height }}
          onFirstFrameRender={() => {
            setHasFrame(true);
            setHasError(false);
          }}
        />
        {!hasFrame && !hasError ? (
          <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(3,3,8,0.36)' }}>
            <ActivityIndicator color={appTheme.colors.primary} />
          </View>
        ) : null}
        {!isPlaying && hasFrame ? <ProfileFeedPlayBadge /> : null}
      </Pressable>
    </View>
  );
}

function ProfileFeedPlayBadge() {
  return (
    <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)' }}>
        <Play size={30} color="#fff" fill="#fff" strokeWidth={2.4} style={{ marginLeft: 4 }} />
      </View>
    </View>
  );
}

function ProfileFeedActionRow({
  item,
  onLinkedVisibilityChange,
  onManageUnlock,
  onOpenLinkedPost,
  onPublish,
  onRecreate,
  onSave,
  onShare,
  saveLoading,
  visibilityLoading,
}: {
  item: ImmersivePreviewItem;
  onLinkedVisibilityChange: (visibility: 'public' | 'private') => void;
  onManageUnlock: () => void;
  onOpenLinkedPost: () => void;
  onPublish: () => void;
  onRecreate: () => void;
  onSave: () => void;
  onShare: () => void;
  saveLoading: boolean;
  visibilityLoading: boolean;
}) {
  const isCreation = item.sourceType === 'generation';
  const isPublishedCreation = isCreation && Boolean(item.linkedPostId) && !item.archivedAt;
  const isUnpublishedCreation = isCreation && !item.linkedPostId && !item.archivedAt;
  const manageUnlockLabel = item.linkedPostBundle ? 'Manage unlock' : 'Add unlock';
  const linkedPostVisibility = item.linkedPostVisibility;
  const nextVisibility = linkedPostVisibility === 'public'
    ? 'private'
    : linkedPostVisibility === 'private'
      ? 'public'
      : null;
  const visibilityLabel = nextVisibility === 'private' ? 'Make private' : 'Make public';

  return (
    <View style={{ paddingHorizontal: 14, paddingTop: 12, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact, flexWrap: 'wrap', flex: 1 }}>
          {!item.archivedAt ? (
            <ProfileFeedActionChip
              accessibilityLabel="Recreate media"
              icon={<Repeat2 size={18} color={appTheme.colors.onPrimary} strokeWidth={2.8} />}
              label="Create"
              onPress={onRecreate}
              primary
            />
          ) : null}
          {isUnpublishedCreation ? (
            <>
              <ProfileFeedActionChip
                accessibilityLabel="Share media"
                icon={<Share2 size={18} color={appTheme.colors.text} strokeWidth={2.5} />}
                label="Share"
                onPress={onShare}
              />
              <ProfileFeedActionChip
                accessibilityLabel={`Publish ${item.title}`}
                icon={<Globe size={18} color={appTheme.colors.text} strokeWidth={2.5} />}
                label="Publish"
                onPress={onPublish}
              />
            </>
          ) : isPublishedCreation ? (
            <>
              <ProfileFeedActionChip
                accessibilityLabel={`${manageUnlockLabel} for ${item.title}`}
                icon={<Wand2 size={18} color={appTheme.colors.success} strokeWidth={2.6} />}
                label={manageUnlockLabel}
                onPress={onManageUnlock}
                tone="success"
              />
              {nextVisibility ? (
                <ProfileFeedActionChip
                  accessibilityLabel={`${visibilityLabel} for ${item.title}`}
                  disabled={visibilityLoading}
                  icon={nextVisibility === 'private'
                    ? <LockKeyhole size={18} color={appTheme.colors.warning} strokeWidth={2.5} />
                    : <Globe size={18} color={appTheme.colors.text} strokeWidth={2.5} />}
                  label={visibilityLabel}
                  onPress={() => onLinkedVisibilityChange(nextVisibility)}
                  tone={nextVisibility === 'private' ? 'private' : 'default'}
                />
              ) : (
                <ProfileFeedActionChip
                  accessibilityLabel={`Open linked post for ${item.title}`}
                  icon={<Globe size={18} color={appTheme.colors.text} strokeWidth={2.5} />}
                  label="Open post"
                  onPress={onOpenLinkedPost}
                />
              )}
            </>
          ) : (
            item.canShare ? (
              <ProfileFeedActionChip
                accessibilityLabel="Share media"
                icon={<Share2 size={18} color={appTheme.colors.text} strokeWidth={2.5} />}
                label="Share"
                onPress={onShare}
              />
            ) : null
          )}
        </View>
        {item.mediaItems.length > 1 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Images size={17} color={appTheme.colors.muted} />
            <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '700' }}>
              {item.mediaItems.length}
            </Text>
          </View>
        ) : null}
      </View>
      {item.canSave ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.isSaved ? 'Saved' : 'Save'}
          disabled={saveLoading}
          onPress={onSave}
          style={({ pressed }) => ({
            minHeight: appTheme.touch.default,
            alignSelf: 'flex-start',
            justifyContent: 'center',
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: item.isSaved ? appTheme.colors.primary : appTheme.colors.border,
            backgroundColor: item.isSaved ? appTheme.colors.selected : appTheme.colors.surface,
            paddingHorizontal: 14,
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <Text style={{ color: item.isSaved ? appTheme.colors.primary : appTheme.colors.text, fontSize: 13, fontWeight: '700' }}>{item.isSaved ? 'Saved' : 'Save'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ProfileFeedActionChip({
  accessibilityLabel,
  icon,
  label,
  onPress,
  primary = false,
  disabled = false,
  tone = 'default',
}: {
  accessibilityLabel: string;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'success' | 'private';
}) {
  const isSuccess = tone === 'success';
  const isPrivate = tone === 'private';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.compact,
        minWidth: primary || isSuccess ? 96 : 84,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 7,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: primary
          ? appTheme.colors.primary
          : isSuccess
            ? appTheme.semantic.success.border
            : isPrivate
              ? appTheme.semantic.warning.border
              : appTheme.colors.borderStrong,
        backgroundColor: primary
          ? appTheme.colors.primary
          : isSuccess
            ? appTheme.semantic.success.background
            : isPrivate
              ? appTheme.semantic.warning.background
              : appTheme.colors.surfaceStrong,
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: appTheme.spacing.gap,
      })}
    >
      {icon}
      <Text
        numberOfLines={1}
        style={{
          color: primary
            ? appTheme.colors.onPrimary
            : isSuccess
              ? appTheme.colors.success
              : isPrivate
                ? appTheme.colors.warning
                : appTheme.colors.text,
          ...appTheme.type.label,
          fontWeight: '700',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ProfileFeedMetaPill({ label }: { label: string }) {
  return (
    <View style={{ minHeight: 32, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.surfaceStrong, borderWidth: 1, borderColor: appTheme.colors.border, paddingHorizontal: appTheme.spacing.gap, alignItems: 'center', justifyContent: 'center' }}>
      <Text numberOfLines={1} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '700' }}>
        {label}
      </Text>
    </View>
  );
}

function ProfileFeedDetailsSheet({
  bottomInset,
  item,
  onClose,
  visible,
}: {
  bottomInset: number;
  item: ImmersivePreviewItem;
  onClose: () => void;
  visible: boolean;
}) {
  const details = item.details;
  const reducedMotion = useReducedMotion();

  return (
    <Modal animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose} transparent visible={visible}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.58)' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close media details"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          style={{
            maxHeight: '72%',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: appTheme.colors.border,
            backgroundColor: appTheme.colors.panel,
            paddingTop: 12,
            paddingBottom: bottomInset + 18,
          }}
        >
          <View style={{ width: 42, height: 4, borderRadius: 2, backgroundColor: appTheme.colors.borderStrong, alignSelf: 'center', marginBottom: 12 }} />
          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
            <Text style={{ color: appTheme.colors.text, fontSize: 22, lineHeight: 27, fontWeight: '800' }}>{item.title}</Text>
            <ProfileFeedDetailBlock title="Prompt" body={details?.prompt || item.recreatePrompt || item.displayText} emptyLabel="No prompt provided" />
            <ProfileFeedDetailBlock title="Caption" body={details?.body || ''} emptyLabel="No caption provided" />
            {details?.generationInfo ? (
              <ProfileFeedDetailBlock
                title="Generation"
                body={[
                  `Model: ${details.generationInfo.model}`,
                  `Created: ${new Date(details.generationInfo.createdAt).toLocaleDateString()}`,
                  details.generationInfo.duration ? `Duration: ${details.generationInfo.duration}s` : null,
                  details.generationInfo.cost ? `Cost: ${details.generationInfo.cost}` : null,
                ].filter(Boolean).join('\n')}
                emptyLabel=""
              />
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ProfileFeedDetailBlock({ title, body, emptyLabel }: { title: string; body: string; emptyLabel: string }) {
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ color: appTheme.colors.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>
      {body ? (
        <Text selectable style={{ color: appTheme.colors.textSecondary, fontSize: 14, lineHeight: 21 }}>{body}</Text>
      ) : (
        <Text style={{ color: appTheme.colors.faint, fontSize: 14 }}>{emptyLabel}</Text>
      )}
    </View>
  );
}

function mediaFrameHeight(mediaItem: ShowcaseMediaItem, width: number, fallbackHeight: number) {
  if (!mediaItem.width || !mediaItem.height) return fallbackHeight;
  const ratio = mediaItem.height / mediaItem.width;
  const clampedRatio = Math.max(0.72, Math.min(1.42, ratio));
  return Math.round(width * clampedRatio);
}

function creationStateLabel(item: ImmersivePreviewItem) {
  if (item.archivedAt) return 'Archived';
  if (item.linkedPostId) {
    if (item.linkedPostVisibility) return `${capitalize(item.linkedPostVisibility)} post`;
    return 'Linked post';
  }
  return 'Not posted';
}

function postStateLabel(item: ImmersivePreviewItem) {
  if (item.archivedAt) return 'Archived';
  if (item.visibility) return `${capitalize(item.visibility)} post`;
  return 'Published post';
}

function shouldShowFeedBody(title: string, body: string) {
  const normalizedTitle = normalizePreviewText(title);
  const normalizedBody = normalizePreviewText(body);
  if (!normalizedBody) return false;
  return normalizedBody !== normalizedTitle;
}

function normalizePreviewText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/g, '');
}

function capitalize(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return value;
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

type ScheduledFrameHandle =
  | { kind: 'animation-frame'; value: number }
  | { kind: 'timeout'; value: ReturnType<typeof globalThis.setTimeout> };

function scheduleFrame(callback: () => void): ScheduledFrameHandle {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return {
      kind: 'animation-frame',
      value: globalThis.requestAnimationFrame(callback),
    };
  }
  return {
    kind: 'timeout',
    value: globalThis.setTimeout(callback, 0),
  };
}

function cancelFrame(handle: ScheduledFrameHandle) {
  if (handle.kind === 'animation-frame') {
    globalThis.cancelAnimationFrame?.(handle.value);
    return;
  }
  globalThis.clearTimeout(handle.value);
}
