import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer } from 'expo-video';
import { ArrowLeft, Copy, Download, ExternalLink, FileText, Heart, ImageOff, Images, Lock, MoreVertical, Play, Repeat2, Share2, Volume2, VolumeX, X } from 'lucide-react-native';
import { useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, FlatList, Linking, Modal, Platform, Pressable, ScrollView, Share, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { FeedVideoPreview } from '@/components/feed-video-preview';
import { PostResourceReferences } from '@/components/post-resource-references';
import { Pill, SecondaryButton, StatusBlock } from '@/components/ui';
import { UnlockRemixPrompt } from '@/components/unlock-remix-prompt';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import {
  getImmersiveInitialIndex,
  hasImmersiveDetailsPage,
  selectActiveImmersiveVideoId,
  type ImmersivePreviewItem,
} from '@/lib/immersive-preview-view-model';
import {
  buildImmersiveSlidePages,
  getImmersiveSlideHint,
  getImmersiveVideoBlockerId,
  isImmersiveDetailsSlidePageIndex,
  type ImmersiveSlidePage,
} from '@/lib/immersive-slide-pages';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
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
  applyShowcaseSaveStateToFeedResponse,
  applyShowcaseSaveStateToInfiniteFeed,
  applyShowcaseSaveStateToPostResponse,
  applyShowcaseSaveStateToSourceData,
  scheduleShowcaseSaveCompletionEffects,
  type ShowcaseSaveStateResult,
} from '@/lib/showcase-save-cache';
import { IMMERSIVE_HORIZONTAL_LIST_TUNING, IMMERSIVE_VERTICAL_LIST_TUNING } from '@/lib/media-performance';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import type { MarketplaceResourceDetail, PostResourceAttachment, PostResourceKind, ShowcaseFeedResponse, ShowcaseMediaItem, ShowcasePostResponse } from '@/lib/types';
import { getNativeRemixCreateHref, getRailActionOpacity, getSaveHeartIconProps, getSaveHeartTapAnimationSpec, type SaveHeartTapAnimationSpec } from '@/lib/viewer-actions';

type ViewerParams = {
  creatorUsername?: string | string[];
  source?: string | string[];
  initialId?: string | string[];
};

type SaveMutationVariables = {
  postId: string;
  previousSaveCount: number;
  shouldSave: boolean;
  sourceSurface: string;
};

export default function ImmersivePreviewViewerScreen() {
  const params = useLocalSearchParams<ViewerParams>();
  const source = normalizeViewerSource(params.source);
  const initialId = normalizeParam(params.initialId);
  const creatorUsername = normalizeParam(params.creatorUsername) || null;
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const listRef = useRef<FlatList<ImmersivePreviewItem>>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [detailsPageOpenItemId, setDetailsPageOpenItemId] = useState<string | null>(null);
  const [detailsSheetOpenItemId, setDetailsSheetOpenItemId] = useState<string | null>(null);
  const [actionsOpenItemId, setActionsOpenItemId] = useState<string | null>(null);
  const [unlockRemixOpenItemId, setUnlockRemixOpenItemId] = useState<string | null>(null);
  const [isHorizontalScrolling, setIsHorizontalScrolling] = useState(false);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    initialData: () => readCachedProfile(queryClient, user?.id),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });

  const sourceQueryKey = useMemo(
    () => ['immersive-preview-source', source, user?.id ?? 'guest', initialId, creatorUsername ?? ''] as const,
    [creatorUsername, initialId, source, user?.id]
  );

  const sourceQuery = useQuery({
    queryKey: sourceQueryKey,
    enabled: Boolean(source),
    initialData: () => readCachedImmersiveSourceData(queryClient, source, user?.id, initialId),
    queryFn: () => loadImmersiveSourceData({ api, source, initialId, creatorUsername }),
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
  const openCreatorProfile = useCallback((item: ImmersivePreviewItem) => {
    if (!item.creatorUsername) return;
    router.push(`/creators/${encodeURIComponent(item.creatorUsername)}` as never);
  }, []);
  const initialIndex = useMemo(() => getImmersiveInitialIndex(items, initialId), [items, initialId]);
  const overlayOpenItemId = getImmersiveVideoBlockerId({
    actionsOpenItemId,
    detailsPageOpenItemId,
    detailsSheetOpenItemId,
    unlockRemixOpenItemId,
  });
  const activeVideoId = isFocused
    ? selectActiveImmersiveVideoId(items, activeIndex, overlayOpenItemId)
    : null;
  const activeItem = items[activeIndex];
  const unlockRemixItem = useMemo(
    () => items.find((item) => item.id === unlockRemixOpenItemId) ?? null,
    [items, unlockRemixOpenItemId]
  );

  useEffect(() => {
    if (!items.length) return;
    const frame = requestAnimationFrame(() => {
      setActiveIndex(initialIndex);
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialIndex, items.length]);

  const reconcileShowcaseSave = useCallback((
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
  }, [queryClient, sourceQueryKey, user?.id]);

  const saveMutation = useMutation({
    mutationFn: ({ postId, shouldSave, sourceSurface }: SaveMutationVariables) =>
      api.saveShowcasePost(postId, { shouldSave, sourceSurface }),
    onMutate: async (variables) => {
      const optimisticSaveCount = Math.max(
        0,
        variables.previousSaveCount + (variables.shouldSave ? 1 : -1)
      );
      reconcileShowcaseSave({
        postId: variables.postId,
        isSaved: variables.shouldSave,
        saveCount: optimisticSaveCount,
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
      }, {
        removeWhenUnsaved: source === 'profile-saved' && !result.isSaved,
      });
      scheduleShowcaseSaveCompletionEffects({
        postId: variables.postId,
        userId: user?.id,
        hapticFeedback: Haptics.selectionAsync,
        invalidateQueries: (filters) => queryClient.invalidateQueries(filters),
      });
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
      sourceSurface: source === 'profile-saved' ? 'mobile-profile-saved' : 'mobile-viewer',
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

  if (!items.length && sourceQuery.isLoading) {
    return (
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <ActivityIndicator accessibilityLabel="Loading preview" color={appTheme.colors.primary} />
      </ViewerShell>
    );
  }

  if (!items.length && sourceQuery.isError) {
    return (
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <View style={{ width: '100%', maxWidth: 420, gap: 12 }}>
          <StatusBlock
            tone="danger"
            title="Couldn't load this preview"
            body="Check your connection and try again."
          />
          <SecondaryButton
            label="Try again"
            onPress={() => void sourceQuery.refetch()}
          />
        </View>
      </ViewerShell>
    );
  }

  if (!items.length) {
    return (
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <Text selectable style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '800' }}>Preview unavailable</Text>
        <Text selectable style={{ color: appTheme.colors.muted, marginTop: 8 }}>This item may have been removed or is still loading.</Text>
      </ViewerShell>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        ref={listRef}
        data={items}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
        initialNumToRender={IMMERSIVE_VERTICAL_LIST_TUNING.initialNumToRender}
        initialScrollIndex={initialIndex}
        keyExtractor={(item) => `${item.source}-${item.id}`}
        maxToRenderPerBatch={IMMERSIVE_VERTICAL_LIST_TUNING.maxToRenderPerBatch}
        onMomentumScrollEnd={(event) => {
          const nextIndex = Math.round(event.nativeEvent.contentOffset.y / height);
          setActiveIndex(Math.max(0, Math.min(items.length - 1, nextIndex)));
          setDetailsPageOpenItemId(null);
          setDetailsSheetOpenItemId(null);
          setActionsOpenItemId(null);
          setUnlockRemixOpenItemId(null);
        }}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset: height * index, animated: false });
          });
        }}
        pagingEnabled
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item, index }) => (
          <ImmersiveSlide
            active={index === activeIndex}
            activeVideoId={activeVideoId}
            bottomInset={bottomInset}
            height={height}
            item={item}
            onActionsOpen={() => setActionsOpenItemId(item.id)}
            onCreatorOpen={openCreatorProfile}
            onDetailsPageOpenChange={(open) => setDetailsPageOpenItemId(open ? item.id : null)}
            onHorizontalScrollToggle={setIsHorizontalScrolling}
            onRecreate={recreateItem}
            onSave={saveItem}
            onShare={shareItem}
            onUnlockRemix={(nextItem) => setUnlockRemixOpenItemId(nextItem.id)}
            saveLoading={saveMutation.isPending && saveMutation.variables?.postId === item.showcasePostId}
            topInset={topInset}
            width={width}
          />
        )}
        scrollEnabled={!overlayOpenItemId && !isHorizontalScrolling}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: '#000' }}
        windowSize={IMMERSIVE_VERTICAL_LIST_TUNING.windowSize}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={leaveViewer}
        style={({ pressed }) => ({
          position: 'absolute',
          left: 16,
          top: topInset + 10,
          width: 48,
          height: 48,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 24,
          backgroundColor: 'rgba(0,0,0,0.18)',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <ArrowLeft size={30} color="#ffffff" strokeWidth={2.4} />
      </Pressable>
      {activeItem && hasImmersiveDetailsPage(activeItem) ? (
        <ViewerDetailsSheet
          bottomInset={bottomInset}
          height={height}
          item={activeItem}
          onClose={() => setDetailsSheetOpenItemId(null)}
          onRecreate={recreateItem}
          onSave={saveItem}
          onShare={shareItem}
          onUnlockRemix={(item) => setUnlockRemixOpenItemId(item.id)}
          saveLoading={saveMutation.isPending && saveMutation.variables?.postId === activeItem.showcasePostId}
          topInset={topInset}
          visible={detailsSheetOpenItemId === activeItem.id}
          width={width}
        />
      ) : null}
      {activeItem ? (
        <ViewerActionSheet
          item={activeItem}
          onClose={() => setActionsOpenItemId(null)}
          onDetails={() => {
            setActionsOpenItemId(null);
            setDetailsSheetOpenItemId(activeItem.id);
          }}
          onRecreate={() => void recreateItem(activeItem)}
          onShare={() => void shareItem(activeItem)}
          onUnlockRemix={() => {
            setActionsOpenItemId(null);
            setUnlockRemixOpenItemId(activeItem.id);
          }}
          onDeleted={() => {
            setActionsOpenItemId(null);
            router.replace({
              pathname: '/(tabs)/profile',
              params: { tab: 'posts' },
            } as never);
          }}
          onSourceRefresh={() => void sourceQuery.refetch()}
          visible={actionsOpenItemId === activeItem.id}
        />
      ) : null}
      <UnlockRemixPrompt
        bottomInset={bottomInset}
        item={unlockRemixItem}
        onClose={() => setUnlockRemixOpenItemId(null)}
        onUnlocked={(item) => recreateItem(item)}
        visible={Boolean(unlockRemixOpenItemId)}
      />
      {sourceQuery.isFetching && activeItem ? (
        <View style={{ position: 'absolute', top: topInset + 24, right: 20 }}>
          <ActivityIndicator color="rgba(255,255,255,0.72)" />
        </View>
      ) : null}
    </View>
  );
}

function ViewerShell({ topInset, bottomInset, children }: { topInset: number; bottomInset: number; children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', paddingTop: topInset, paddingBottom: bottomInset, paddingHorizontal: 24 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={leaveViewer}
        style={{ position: 'absolute', left: 16, top: topInset + 10, width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.18)' }}
      >
        <ArrowLeft size={30} color="#ffffff" strokeWidth={2.4} />
      </Pressable>
      {children}
    </View>
  );
}

function leaveViewer() {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/(tabs)/showcase' as never);
}

function ImmersiveSlide({
  active,
  activeVideoId,
  bottomInset,
  height,
  item,
  onActionsOpen,
  onCreatorOpen,
  onDetailsPageOpenChange,
  onRecreate,
  onSave,
  onShare,
  onUnlockRemix,
  saveLoading,
  topInset,
  width,
  onHorizontalScrollToggle,
}: {
  active: boolean;
  activeVideoId: string | null;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onActionsOpen: () => void;
  onCreatorOpen: (item: ImmersivePreviewItem) => void;
  onDetailsPageOpenChange: (open: boolean) => void;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onUnlockRemix: (item: ImmersivePreviewItem) => void;
  saveLoading: boolean;
  topInset: number;
  width: number;
  onHorizontalScrollToggle?: (scrolling: boolean) => void;
}) {
  const horizontalRef = useRef<FlatList<ImmersiveSlidePage>>(null);
  const [currentHorizontalIndex, setCurrentHorizontalIndex] = useState(0);
  const prevActiveRef = useRef(active);

  const pages = useMemo(() => buildImmersiveSlidePages(item), [item]);
  const currentPageIsDetails = isImmersiveDetailsSlidePageIndex(pages, currentHorizontalIndex);
  const slideHint = getImmersiveSlideHint({ item, pages, currentHorizontalIndex });
  const canOpenCreator = Boolean(item.creatorUsername);
  const updateCurrentHorizontalIndex = useCallback((pageIndex: number) => {
    setCurrentHorizontalIndex(pageIndex);
    onDetailsPageOpenChange(isImmersiveDetailsSlidePageIndex(pages, pageIndex));
  }, [onDetailsPageOpenChange, pages]);

  const openDetailsPage = useCallback(() => {
    const detailsIndex = pages.findIndex((page) => page.type === 'details');
    if (detailsIndex < 0) return;

    updateCurrentHorizontalIndex(detailsIndex);
    horizontalRef.current?.scrollToIndex({ index: detailsIndex, animated: true });
  }, [pages, updateCurrentHorizontalIndex]);

  useEffect(() => {
    if (!active) {
      prevActiveRef.current = active;
      return;
    }

    const becameActive = !prevActiveRef.current;
    prevActiveRef.current = active;

    if (becameActive && currentHorizontalIndex !== 0) {
      const frame = requestAnimationFrame(() => {
        updateCurrentHorizontalIndex(0);
        horizontalRef.current?.scrollToIndex({ index: 0, animated: false });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [active, currentHorizontalIndex, updateCurrentHorizontalIndex]);

  const mediaCount = item.mediaItems?.length ?? 0;
  const isTextPost = item.previewKind === 'text';
  const canRecreate = item.availableActions.includes('recreate');
  const canUnlockRemix = item.availableActions.includes('unlock-remix');
  const videoPlaybackActive = active && activeVideoId === item.id && !currentPageIsDetails;

  const renderOverlays = () => {
    if (currentPageIsDetails) {
      return (
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
          {slideHint ? (
            <View
              style={{
                position: 'absolute',
                left: 18,
                bottom: bottomInset + 28,
                borderRadius: 999,
                backgroundColor: 'rgba(255,255,255,0.10)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.14)',
                paddingHorizontal: 11,
                paddingVertical: 7,
              }}
            >
              <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 15, fontWeight: '800' }}>
                {slideHint}
              </Text>
            </View>
          ) : null}
        </View>
      );
    }

    return (
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          inset: 0,
        }}
      >
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(0,0,0,0.36)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.82)']}
          locations={[0, 0.48, 1]}
          style={{ position: 'absolute', inset: 0 }}
        />

        {/* Media count indicator */}
        {!isTextPost && mediaCount > 1 ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              right: 18,
              top: 68,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.14)',
              backgroundColor: 'rgba(3,3,6,0.68)',
              paddingHorizontal: 10,
              paddingVertical: 5,
            }}
          >
            <Images size={14} color="#ffffff" />
            <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '800' }}>
              {Math.min(currentHorizontalIndex + 1, mediaCount)} / {mediaCount}
            </Text>
          </View>
        ) : null}

        {/* Right rail buttons */}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            right: 14,
            bottom: bottomInset + 104,
            alignItems: 'center',
            gap: 17,
          }}
        >
          <ViewerCreatorAvatar
            item={item}
            onPress={canOpenCreator ? () => onCreatorOpen(item) : undefined}
            size={56}
          />
          <RailActionButton
            icon={<MoreVertical size={27} color="#ffffff" strokeWidth={2.5} />}
            label="More"
            onPress={onActionsOpen}
          />
          <RailActionButton
            disabled={!item.canSave}
            icon={<Heart size={27} {...getSaveHeartIconProps({ isSaved: item.isSaved, enabled: item.canSave })} />}
            label={item.isSaved ? 'Saved' : item.saveLabel}
            loading={saveLoading}
            onPress={() => onSave(item)}
            preserveIconWhileLoading
            showDisabledAsActive={item.isSaved && !item.canSave}
            tapAnimationSpec={getSaveHeartTapAnimationSpec({ willSave: !item.isSaved, enabled: item.canSave })}
          />
          <RailActionButton
            icon={<Share2 size={27} color="#ffffff" strokeWidth={2.4} />}
            label="Share"
            onPress={() => void onShare(item)}
          />
          {hasImmersiveDetailsPage(item) ? (
            <RailActionButton
              icon={<FileText size={27} color="#ffffff" strokeWidth={2.4} />}
              label="Details"
              onPress={openDetailsPage}
            />
          ) : null}
          {canRecreate || canUnlockRemix ? (
            <RailActionButton
              primary
              icon={<Repeat2 size={27} color="#050505" strokeWidth={2.8} />}
              label={canUnlockRemix ? 'Remix' : 'Create'}
              onPress={canUnlockRemix ? () => onUnlockRemix(item) : () => void onRecreate(item)}
            />
          ) : null}
        </View>

        {/* Bottom text descriptions */}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: 18,
            right: 96,
            bottom: bottomInset + 28,
            gap: 8,
          }}
        >
          <View pointerEvents="none" style={{ alignSelf: 'flex-start', borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 10, paddingVertical: 6 }}>
            <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
              {item.badge}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.creatorLabel} profile`}
            disabled={!canOpenCreator}
            onPress={() => onCreatorOpen(item)}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              opacity: pressed ? 0.72 : canOpenCreator ? 1 : 0.86,
            })}
          >
            <Text numberOfLines={1} style={{ color: '#fff', fontSize: 18, lineHeight: 22, fontWeight: '800' }}>
              {item.creatorLabel}
            </Text>
          </Pressable>
          <Text numberOfLines={2} style={{ color: '#fff', fontSize: 22, lineHeight: 26, fontWeight: '800' }}>
            {item.title}
          </Text>
          <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.78)', fontSize: 14, lineHeight: 20, fontWeight: '700' }}>
            {item.displayText}
          </Text>
          {slideHint ? (
            <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 15, fontWeight: '800' }}>
              {slideHint}
            </Text>
          ) : null}
        </View>
      </View>
    );
  };

  if (pages.length <= 1) {
    return (
      <View style={{ width, height }}>
        <MediaSlidePage
          active={videoPlaybackActive}
          bottomInset={bottomInset}
          height={height}
          item={item}
          onRecreate={onRecreate}
          onSave={onSave}
          onShare={onShare}
          onUnlockRemix={onUnlockRemix}
          page={pages[0] ?? { type: 'text' }}
          saveLoading={saveLoading}
          topInset={topInset}
          width={width}
        />
        {renderOverlays()}
      </View>
    );
  }

  return (
    <View style={{ width, height, backgroundColor: '#000' }}>
      <FlatList
        ref={horizontalRef}
        data={pages}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        horizontal
        initialNumToRender={IMMERSIVE_HORIZONTAL_LIST_TUNING.initialNumToRender}
        initialScrollIndex={0}
        keyExtractor={(page, index) => page.type === 'media' ? `media-${page.mediaItem.id}` : `${page.type}-${index}`}
        maxToRenderPerBatch={IMMERSIVE_HORIZONTAL_LIST_TUNING.maxToRenderPerBatch}
        onScrollBeginDrag={() => onHorizontalScrollToggle?.(true)}
        onScrollEndDrag={() => onHorizontalScrollToggle?.(false)}
        onMomentumScrollEnd={(event) => {
          const page = Math.round(event.nativeEvent.contentOffset.x / width);
          updateCurrentHorizontalIndex(Math.max(0, Math.min(pages.length - 1, page)));
          onHorizontalScrollToggle?.(false);
        }}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => {
            horizontalRef.current?.scrollToOffset({ offset: width * index, animated: false });
          });
        }}
        pagingEnabled
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item: page, index: pageIndex }) => (
          <MediaSlidePage
            active={active && currentHorizontalIndex === pageIndex && (page.type !== 'media' || videoPlaybackActive)}
            bottomInset={bottomInset}
            height={height}
            item={item}
            onRecreate={onRecreate}
            onSave={onSave}
            onShare={onShare}
            onUnlockRemix={onUnlockRemix}
            page={page}
            saveLoading={saveLoading}
            topInset={topInset}
            width={width}
          />
        )}
        scrollEnabled={active}
        showsHorizontalScrollIndicator={false}
        style={{ width, height, backgroundColor: '#000' }}
        windowSize={IMMERSIVE_HORIZONTAL_LIST_TUNING.windowSize}
      />
      {renderOverlays()}
    </View>
  );
}

function MediaSlidePage({
  active,
  bottomInset,
  height,
  item,
  onRecreate,
  onSave,
  onShare,
  onUnlockRemix,
  page,
  saveLoading,
  topInset,
  width,
}: {
  active: boolean;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onUnlockRemix: (item: ImmersivePreviewItem) => void;
  page: ImmersiveSlidePage;
  saveLoading: boolean;
  topInset: number;
  width: number;
}) {
  return (
    <View style={{ width, height, backgroundColor: '#000' }}>
      {page.type === 'details' ? (
        <PostDetailsPage
          active={active}
          bottomInset={bottomInset}
          height={height}
          item={item}
          onRecreate={onRecreate}
          onSave={onSave}
          onShare={onShare}
          onUnlockRemix={onUnlockRemix}
          saveLoading={saveLoading}
          sheet={false}
          topInset={topInset}
          width={width}
        />
      ) : page.type === 'text' ? (
        <TextSlide item={item} width={width} height={height} />
      ) : (
        <ImmersiveMedia
          mediaItem={page.mediaItem}
          active={active}
          width={width}
          height={height}
        />
      )}
    </View>
  );
}

function ViewerDetailsSheet({
  bottomInset,
  height,
  item,
  onClose,
  onRecreate,
  onSave,
  onShare,
  onUnlockRemix,
  saveLoading,
  topInset,
  visible,
  width,
}: {
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onClose: () => void;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onUnlockRemix: (item: ImmersivePreviewItem) => void;
  saveLoading: boolean;
  topInset: number;
  visible: boolean;
  width: number;
}) {
  const sheetHeight = Math.min(height * 0.9, height - topInset - 12);
  const reducedMotion = useReducedMotion();

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.56)' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close details"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          style={{
            height: sheetHeight,
            overflow: 'hidden',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: 'rgba(255,255,255,0.14)',
            backgroundColor: '#050506',
          }}
        >
          <View
            style={{
              height: 58,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 18,
              borderBottomWidth: 1,
              borderBottomColor: 'rgba(255,255,255,0.1)',
            }}
          >
            <View style={{ width: 48 }} />
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800' }}>Details</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close details"
              onPress={onClose}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                borderRadius: 24,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(255,255,255,0.08)',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <X size={22} color="#fff" />
            </Pressable>
          </View>
          <PostDetailsPage
            active={visible}
            bottomInset={bottomInset}
            height={sheetHeight - 58}
            item={item}
            onRecreate={onRecreate}
            onSave={onSave}
            onShare={onShare}
            onUnlockRemix={onUnlockRemix}
            saveLoading={saveLoading}
            sheet
            topInset={0}
            width={width}
          />
        </View>
      </View>
    </Modal>
  );
}

function PostDetailsPage({
  active,
  bottomInset,
  height,
  item,
  onRecreate,
  onSave,
  onShare,
  onUnlockRemix,
  saveLoading,
  sheet = false,
  topInset,
  width,
}: {
  active: boolean;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  onUnlockRemix: (item: ImmersivePreviewItem) => void;
  saveLoading: boolean;
  sheet?: boolean;
  topInset: number;
  width: number;
}) {
  const details = item.details;
  const unlock = details?.unlock ?? null;
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);

  const resourceQuery = useQuery({
    queryKey: ['post-resource-bundle', unlock?.postId, unlock?.resourceId],
    enabled: active && Boolean(unlock),
    queryFn: async () => {
      if (!unlock) throw new Error('Missing unlock details');
      return api.getMarketplaceResourceDetail(unlock.resourceId, { postId: unlock.postId });
    },
    staleTime: 1000 * 60,
  });

  const unlockMutation = useMutation({
    mutationFn: async () => {
      if (!unlock) return null;
      if (unlock.accessMode === 'free') {
        return api.unlockFreeBundle(unlock.postId);
      }
      return api.unlockBundleWithCredits(unlock.postId);
    },
    onSuccess: async () => {
      if (unlock) {
        await queryClient.invalidateQueries({ queryKey: ['post-resource-bundle', unlock.postId, unlock.resourceId] });
        await queryClient.invalidateQueries({ queryKey: ['marketplace-resource', unlock.resourceId] });
        await queryClient.invalidateQueries({ queryKey: ['marketplace-resources'] });
      }
      await Haptics.selectionAsync();
    },
  });

  const resolveReferenceFileUrl = useCallback(async (storagePath: string) => {
    const postId = item.showcasePostId ?? item.ownerPostId ?? item.id;
    const response = await api.getPostResourceFileUrl(postId, storagePath);
    return response.signedUrl;
  }, [api, item.id, item.ownerPostId, item.showcasePostId]);

  const openReferenceUrl = useCallback(async (url: string) => {
    setResourceError(null);
    await Linking.openURL(url);
  }, []);

  if (!details) {
    return <View style={{ width, height, backgroundColor: '#000' }} />;
  }

  const bundle = resourceQuery.data?.bundle;
  const canAccess = Boolean(bundle?.viewerCanAccess);
  const resources = canAccess ? bundle?.resources ?? null : null;
  const resourceKinds = bundle?.resourceKinds ?? unlock?.resourceKinds ?? [];

  const copyText = async (text: string) => {
    await Clipboard.setStringAsync(text);
    await Haptics.selectionAsync();
  };

  const openAttachment = async (attachment: PostResourceAttachment) => {
    try {
      setResourceError(null);
      if (attachment.url) {
        await Linking.openURL(attachment.url);
        return;
      }
      if (attachment.storagePath) {
        setFileLoadingPath(attachment.storagePath);
        const postId = item.showcasePostId ?? item.ownerPostId ?? item.id;
        const response = await api.getPostResourceFileUrl(postId, attachment.storagePath);
        await Linking.openURL(response.signedUrl);
        return;
      }
      Alert.alert('Attachment unavailable', 'This attachment does not have an openable link.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open this resource.';
      setResourceError(message);
    } finally {
      setFileLoadingPath(null);
    }
  };

  const unlockError = unlockMutation.error instanceof Error ? unlockMutation.error.message : null;
  const unlockAccent: ToolAccent = unlock?.accessMode === 'free' ? 'workflow' : 'commerce';
  const unlockPriceLabel = unlock ? bundle?.priceQuote?.formatted ?? unlock.priceLabel : null;
  const canRecreate = item.availableActions.includes('recreate');
  const canUnlockRemix = item.availableActions.includes('unlock-remix');

  return (
    <View style={{ width, height, backgroundColor: appTheme.colors.app }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: sheet ? 20 : topInset + 80,
          paddingBottom: bottomInset + 36,
          paddingHorizontal: 22,
          gap: appTheme.spacing.panel,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 8 }}>
          <Text style={{ color: appTheme.colors.faint, ...appTheme.type.label, textTransform: 'uppercase' }}>
            Post details
          </Text>
          <Text selectable style={{ color: appTheme.colors.text, ...appTheme.type.pageTitle, fontWeight: '800' }}>
            {details.title}
          </Text>
          <Text style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm, fontWeight: '700' }}>
            {details.creatorLabel} · {details.categoryLabel}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <DetailStat label="Saves" value={formatCount(details.saveCount)} />
          <DetailStat label="Remixes" value={formatCount(details.remixCount)} />
          <DetailStat label="Source" value={details.sourceLabel} />
        </View>

        <DetailSection title="Prompt" emptyLabel="No prompt provided">
          {details.prompt ? (
            <CopyableText text={details.prompt} onCopy={copyText} />
          ) : null}
        </DetailSection>

        <DetailSection title="Caption" emptyLabel="No caption provided">
          {details.body ? (
            <CopyableText text={details.body} onCopy={copyText} />
          ) : null}
        </DetailSection>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {canRecreate ? (
            <DetailActionButton
              label="Recreate"
              icon={<Repeat2 size={18} color="#050505" strokeWidth={2.8} />}
              primary
              onPress={() => void onRecreate(item)}
            />
          ) : null}
          {canUnlockRemix && unlock ? (
            <DetailActionButton
              label="Remix"
              icon={<Repeat2 size={18} color="#050505" strokeWidth={2.8} />}
              primary
              onPress={() => onUnlockRemix(item)}
            />
          ) : null}
          <DetailActionButton
            disabled={!item.canSave}
            label={item.isSaved ? 'Saved' : 'Save'}
            icon={<Heart size={18} {...getSaveHeartIconProps({ isSaved: item.isSaved, enabled: item.canSave })} />}
            loading={saveLoading}
            onPress={() => onSave(item)}
          />
          <DetailActionButton
            disabled={!item.canShare}
            label="Share"
            icon={<Share2 size={18} color={item.canShare ? '#fff' : 'rgba(255,255,255,0.5)'} strokeWidth={2.5} />}
            onPress={() => void onShare(item)}
          />
        </View>

        <View style={{ borderRadius: appTheme.radii.xl, borderCurve: 'continuous', borderWidth: 1, borderColor: unlock ? `${accentColor(unlockAccent)}55` : appTheme.colors.border, backgroundColor: appTheme.colors.surfaceStrong, padding: appTheme.spacing.card, gap: appTheme.spacing.gap }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>Creator unlocks</Text>
              {unlock ? (
                <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                  {bundle?.previewText ?? unlock.previewText ?? 'Reusable resources are attached to this post.'}
                </Text>
              ) : (
                <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                  No unlock attached.
                </Text>
              )}
            </View>
            {unlock && unlockPriceLabel ? <Pill label={unlockPriceLabel} accent={unlockAccent} /> : null}
          </View>

          {unlock ? (
            <>
              <ResourceKindRow kinds={resourceKinds} />
              {resourceQuery.isLoading ? <ActivityIndicator color={appTheme.colors.primary} /> : null}
              {resourceQuery.error instanceof Error ? (
                <Text selectable style={{ color: '#ff8a9a', fontSize: 13, fontWeight: '700' }}>{resourceQuery.error.message}</Text>
              ) : null}
              {resources ? (
                <UnlockedResources
                  fileLoadingPath={fileLoadingPath}
                  onCopy={copyText}
                  onOpenReferenceUrl={openReferenceUrl}
                  onOpenAttachment={openAttachment}
                  onReferenceError={setResourceError}
                  resolveReferenceFileUrl={resolveReferenceFileUrl}
                  resources={resources}
                />
              ) : (
                <View style={{ gap: 10 }}>
                  {bundle?.lockedPreview?.promptPreview ? (
                    <LockedPreviewText label="Prompt preview" value={bundle.lockedPreview.promptPreview} />
                  ) : null}
                  {bundle?.lockedPreview?.notesPreview ? (
                    <LockedPreviewText label="Notes preview" value={bundle.lockedPreview.notesPreview} />
                  ) : null}
                  {bundle?.lockedPreview?.attachmentPreviews?.length ? (
                    <View style={{ gap: 8 }}>
                      {bundle.lockedPreview.attachmentPreviews.map((attachment) => (
                        <Text key={`${attachment.kind}-${attachment.label}`} style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13 }}>
                          {attachment.kind === 'file' ? 'File' : 'Link'} · {attachment.label}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  <DetailActionButton
                    label={!user ? 'Sign in to unlock' : unlock.accessMode === 'free' ? 'Unlock free' : 'Unlock with credits'}
                    icon={<Lock size={18} color="#050505" strokeWidth={2.8} />}
                    loading={unlockMutation.isPending}
                    primary
                    onPress={() => {
                      if (!user) {
                        router.push('/auth');
                        return;
                      }
                      unlockMutation.mutate();
                    }}
                  />
                  {unlockError ? <Text selectable style={{ color: '#ff8a9a', fontSize: 13, fontWeight: '700' }}>{unlockError}</Text> : null}
                </View>
              )}
              {resourceError ? <Text selectable style={{ color: '#ff8a9a', fontSize: 13, fontWeight: '700' }}>{resourceError}</Text> : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function LockedPreviewText({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: appTheme.colors.surface, padding: appTheme.spacing.gap, gap: 5 }}>
      <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption, textTransform: 'uppercase' }}>{label}</Text>
      <Text selectable numberOfLines={4} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>{value}</Text>
    </View>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: appTheme.colors.surfaceStrong, padding: appTheme.spacing.gap, gap: 4 }}>
      <Text numberOfLines={1} style={{ color: appTheme.colors.faint, ...appTheme.type.caption, textTransform: 'uppercase' }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

function DetailSection({ title, emptyLabel, children }: { title: string; emptyLabel: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>{title}</Text>
      {children || <Text style={{ color: appTheme.colors.faint, ...appTheme.type.bodySm }}>{emptyLabel}</Text>}
    </View>
  );
}

function CopyableText({ text, onCopy }: { text: string; onCopy: (text: string) => Promise<void> }) {
  return (
    <View style={{ borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: appTheme.colors.surface, padding: appTheme.spacing.gap, gap: appTheme.spacing.gap }}>
      <Text selectable style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>{text}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy text"
        onPress={() => void onCopy(text)}
        style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: appTheme.touch.compact, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: pressed ? 0.7 : 1, paddingHorizontal: 4 })}
      >
        <Copy size={15} color={appTheme.colors.success} strokeWidth={2.4} />
        <Text style={{ color: appTheme.colors.success, ...appTheme.type.caption, fontWeight: '800' }}>Copy</Text>
      </Pressable>
    </View>
  );
}

function DetailActionButton({
  disabled,
  icon,
  label,
  loading,
  onPress,
  primary,
}: {
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  loading?: boolean;
  onPress: () => void;
  primary?: boolean;
}) {
  const primaryColor = appTheme.colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.compact,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 22,
        backgroundColor: primary ? primaryColor : appTheme.colors.surfaceStrong,
        opacity: disabled ? 0.45 : pressed ? 0.76 : 1,
        paddingHorizontal: 15,
      })}
    >
      {loading ? <ActivityIndicator color={primary ? appTheme.colors.textInverse : appTheme.colors.text} /> : icon}
      <Text numberOfLines={1} style={{ color: primary ? appTheme.colors.textInverse : appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function ResourceKindRow({ kinds }: { kinds: PostResourceKind[] }) {
  if (!kinds.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {kinds.map((kind) => (
        <View key={kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.surfaceStrong, paddingHorizontal: 10, paddingVertical: 6 }}>
          <FileText size={13} color={appTheme.colors.textSecondary} strokeWidth={2.5} />
          <Text style={{ color: appTheme.colors.text, ...appTheme.type.caption, fontWeight: '800' }}>{resourceKindLabel(kind)}</Text>
        </View>
      ))}
    </View>
  );
}

function UnlockedResources({
  fileLoadingPath,
  onCopy,
  onOpenAttachment,
  onOpenReferenceUrl,
  onReferenceError,
  resolveReferenceFileUrl,
  resources,
}: {
  fileLoadingPath: string | null;
  onCopy: (text: string) => Promise<void>;
  onOpenAttachment: (attachment: PostResourceAttachment) => Promise<void>;
  onOpenReferenceUrl: (url: string) => Promise<void>;
  onReferenceError: (message: string) => void;
  resolveReferenceFileUrl: (storagePath: string) => Promise<string>;
  resources: NonNullable<MarketplaceResourceDetail['resources']>;
}) {
  return (
    <View style={{ gap: 12 }}>
      {resources.promptText ? (
        <DetailSection title="Unlocked prompt" emptyLabel="">
          <CopyableText text={resources.promptText} onCopy={onCopy} />
        </DetailSection>
      ) : null}
      <PostResourceReferences
        items={resources.items}
        onError={onReferenceError}
        onOpenUrl={onOpenReferenceUrl}
        resolveFileUrl={resolveReferenceFileUrl}
      />
      {resources.notesMarkdown ? (
        <DetailSection title="Creator notes" emptyLabel="">
          <CopyableText text={resources.notesMarkdown} onCopy={onCopy} />
        </DetailSection>
      ) : null}
      {resources.workflowShareUrl ? (
        <DetailActionButton
          label="Open workflow"
          icon={<ExternalLink size={18} color="#fff" strokeWidth={2.5} />}
          onPress={() => void Linking.openURL(resources.workflowShareUrl as string)}
        />
      ) : null}
      {resources.attachments.length ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Files and links</Text>
          {resources.attachments.map((attachment) => {
            const loading = Boolean(attachment.storagePath && attachment.storagePath === fileLoadingPath);
            return (
              <DetailActionButton
                key={`${attachment.label}-${attachment.url ?? attachment.storagePath ?? 'attachment'}`}
                label={attachment.label}
                icon={attachment.kind === 'file'
                  ? <Download size={18} color="#fff" strokeWidth={2.5} />
                  : <ExternalLink size={18} color="#fff" strokeWidth={2.5} />}
                loading={loading}
                onPress={() => void onOpenAttachment(attachment)}
              />
            );
          })}
        </View>
      ) : null}
      {resources.allowRemix ? (
        <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14, lineHeight: 20 }}>
          Remix access is included with this unlock.
        </Text>
      ) : null}
    </View>
  );
}

function resourceKindLabel(kind: PostResourceKind) {
  if (kind === 'prompt') return 'Prompt';
  if (kind === 'workflow') return 'Workflow';
  if (kind === 'files') return 'Files';
  if (kind === 'notes') return 'Notes';
  return 'Remix';
}

function formatCount(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
  return String(value);
}

function ImmersiveMedia({ mediaItem, active, width, height }: { mediaItem: ShowcaseMediaItem; active: boolean; width: number; height: number }) {
  if (mediaItem.mediaKind === 'video') {
    if (active && mediaItem.url) {
      return <ActiveVideo
        url={mediaItem.url}
        previewUrl={mediaItem.previewUrl}
        previewCacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
        previewThumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
        width={width}
        height={height}
      />;
    }

    if (mediaItem.previewUrl) {
      return (
        <View style={{ width, height }}>
          <FeedMediaFrame
            kind="image"
            url={mediaItem.previewUrl}
            backdropUrl={mediaItem.previewUrl}
            cacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
            thumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
            recyclingKey={`viewer:${mediaItem.id}`}
            style={{ width, height }}
          />
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.42)' }}>
              <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} />
            </View>
          </View>
        </View>
      );
    }

    return mediaItem.url ? (
      <View style={{ width, height, backgroundColor: '#020203' }}>
        <FeedVideoPreview
          url={mediaItem.url}
          active={false}
          height={height}
          radius={0}
          accent="#ffffff"
        />
        <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} />
          </View>
        </View>
      </View>
    ) : (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center', backgroundColor: '#020203' }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' }}>
          <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} />
        </View>
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
        transition={120}
        recyclingKey={`viewer:${mediaItem.id}`}
        style={{ width, height }}
      />
    );
  }

  return (
    <View style={{ width, height, backgroundColor: '#07070c' }}>
      <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
        <ImageOff size={34} color="rgba(255,255,255,0.68)" />
      </View>
    </View>
  );
}

function ActiveVideo({
  url,
  previewUrl,
  previewCacheKey,
  previewThumbhash,
  width,
  height,
}: {
  url: string;
  previewUrl?: string | null;
  previewCacheKey?: string;
  previewThumbhash?: string | null;
  width: number;
  height: number;
}) {
  const [hasFrame, setHasFrame] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const reducedMotion = useReducedMotion();
  const player = useVideoPlayer({ uri: url, useCaching: true }, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.volume = 1.0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
  });

  const [isPlaying, setIsPlaying] = useState(player.playing);

  useEffect(() => {
    if (reducedMotion) player.pause();
    else player.play();
    setIsPlaying(player.playing);
  }, [player, reducedMotion]);

  useEffect(() => {
    setHasFrame(false);
    setHasError(false);
  }, [url]);

  useEffect(() => {
    player.muted = isMuted;
  }, [isMuted, player]);

  useEffect(() => {
    const subscription = player.addListener('playingChange', (event) => {
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
    } else {
      player.play();
    }
  };

  const toggleMuted = () => {
    setIsMuted((current) => !current);
  };

  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
        accessibilityHint={reducedMotion ? 'Playback is paused because reduced motion is enabled' : 'Toggles video playback'}
        accessibilityState={{ selected: isPlaying }}
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
          onFirstFrameRender={() => {
            setHasFrame(true);
            setHasError(false);
          }}
          style={{ width, height }}
        />
        {!isPlaying && hasFrame && !hasError ? (
          <View pointerEvents="none" style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} style={{ marginLeft: 4 }} />
          </View>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isMuted ? 'Unmute video' : 'Mute video'}
        accessibilityHint="Toggles video sound without changing playback"
        accessibilityState={{ selected: !isMuted }}
        onPress={toggleMuted}
        style={({ pressed }) => ({
          position: 'absolute',
          top: 112,
          left: 18,
          width: 48,
          height: 48,
          borderRadius: 24,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.18)',
          backgroundColor: pressed ? 'rgba(255,255,255,0.22)' : 'rgba(12,12,16,0.56)',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.82 : 1,
        })}
      >
        {isMuted ? <VolumeX size={22} color="#ffffff" /> : <Volume2 size={22} color="#ffffff" />}
      </Pressable>
    </View>
  );
}

function TextSlide({ item, width, height }: { item: ImmersivePreviewItem; width: number; height: number }) {
  return (
    <View
      style={{ width, height, justifyContent: 'center', paddingLeft: 22, paddingRight: 90, paddingBottom: 120, backgroundColor: appTheme.colors.app }}
    >
      <View style={{ borderRadius: 28, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.panel, padding: 20, gap: 13, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: appTheme.colors.primary }} />
        <View style={{ alignSelf: 'flex-start', borderRadius: 999, backgroundColor: appTheme.colors.surfaceStrong, paddingHorizontal: 11, paddingVertical: 6 }}>
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
            {item.badge}
          </Text>
        </View>
        <Text numberOfLines={3} style={{ color: '#fff', fontSize: 25, lineHeight: 31, fontWeight: '800' }}>
          {item.title}
        </Text>
        <Text numberOfLines={8} style={{ color: appTheme.colors.textSecondary, fontSize: 16, lineHeight: 23, fontWeight: '700' }}>
          {item.displayText}
        </Text>
      </View>
    </View>
  );
}

function ViewerCreatorAvatar({
  item,
  onPress,
  size = 40,
}: {
  item: ImmersivePreviewItem;
  onPress?: () => void;
  size?: number;
}) {
  const initial = item.creatorLabel.replace(/^@/, '').trim()[0]?.toUpperCase() || 'C';
  const innerSize = size - 3;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.creatorLabel} profile`}
      disabled={!onPress}
      onPress={onPress}
      hitSlop={Math.max(0, (appTheme.touch.compact - size) / 2)}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        padding: 1.5,
        backgroundColor: 'rgba(255,255,255,0.9)',
        opacity: pressed ? 0.76 : onPress ? 1 : 0.9,
      })}
    >
      <View style={{ flex: 1, overflow: 'hidden', borderRadius: innerSize / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: '#27272a' }}>
        {item.creatorAvatar ? (
          <Image source={{ uri: item.creatorAvatar }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <Text style={{ color: '#fff', fontSize: size > 44 ? 20 : 15, fontWeight: '800' }}>{initial}</Text>
        )}
      </View>
    </Pressable>
  );
}

function RailActionButton({
  disabled,
  icon,
  label,
  loading,
  onPress,
  primary,
  preserveIconWhileLoading,
  showDisabledAsActive,
  tapAnimationSpec,
}: {
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  loading?: boolean;
  onPress: () => void;
  primary?: boolean;
  preserveIconWhileLoading?: boolean;
  showDisabledAsActive?: boolean;
  tapAnimationSpec?: SaveHeartTapAnimationSpec;
}) {
  const tapProgress = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();
  const [activeTapAnimationSpec, setActiveTapAnimationSpec] = useState(tapAnimationSpec);
  const animationSpec = activeTapAnimationSpec ?? tapAnimationSpec;
  const iconScale = tapProgress.interpolate({
    inputRange: [0, 0.32, 0.66, 1],
    outputRange: [
      1,
      animationSpec?.pressInScale ?? 1,
      animationSpec?.peakScale ?? 1,
      1,
    ],
  });
  const haloOpacity = tapProgress.interpolate({
    inputRange: [0, 0.36, 1],
    outputRange: [0, animationSpec?.haloPeakOpacity ?? 0, 0],
  });
  const haloScale = tapProgress.interpolate({
    inputRange: [0, 0.44, 1],
    outputRange: [0.92, animationSpec?.haloPeakScale ?? 1, (animationSpec?.haloPeakScale ?? 1) + 0.04],
  });

  const runTapAnimation = useCallback(() => {
    if (!tapAnimationSpec || reducedMotion) {
      return;
    }

    setActiveTapAnimationSpec(tapAnimationSpec);
    tapProgress.stopAnimation();
    tapProgress.setValue(0);
    Animated.sequence([
      Animated.timing(tapProgress, {
        toValue: 0.32,
        duration: tapAnimationSpec.pressInDurationMs,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(tapProgress, {
        toValue: 1,
        duration: tapAnimationSpec.settleDurationMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [reducedMotion, tapAnimationSpec, tapProgress]);

  const handlePress = useCallback(() => {
    runTapAnimation();
    onPress();
  }, [onPress, runTapAnimation]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      disabled={disabled || loading}
      onPress={handlePress}
      style={({ pressed }) => ({
        alignItems: 'center',
        gap: 5,
        opacity: getRailActionOpacity({
          disabled: disabled || loading,
          pressed,
          showAsActive: showDisabledAsActive || (Boolean(loading) && Boolean(preserveIconWhileLoading)),
        }),
        minWidth: 64,
      })}
    >
      <View
        style={{
          width: 54,
          height: 54,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 27,
          borderWidth: primary ? 0 : 1,
          borderColor: 'rgba(255,255,255,0.16)',
          backgroundColor: primary ? appTheme.colors.primary : 'rgba(12,12,16,0.42)',
        }}
      >
        {tapAnimationSpec && animationSpec ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: 54,
              height: 54,
              borderRadius: 27,
              backgroundColor: animationSpec.haloColor,
              opacity: haloOpacity,
              transform: [{ scale: haloScale }],
            }}
          />
        ) : null}
        {loading && !preserveIconWhileLoading ? (
          <ActivityIndicator color={primary ? '#050505' : '#fff'} />
        ) : (
          <Animated.View style={{ transform: [{ scale: iconScale }] }}>
            {icon}
          </Animated.View>
        )}
      </View>
      <Text
        numberOfLines={1}
        style={{
          color: '#fff',
          fontSize: 12,
          lineHeight: 15,
          fontWeight: '800',
          textShadowColor: 'rgba(0,0,0,0.6)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 6,
          fontVariant: ['tabular-nums'],
        }}
      >
        {label === '0' ? 'Save' : label}
      </Text>
    </Pressable>
  );
}
