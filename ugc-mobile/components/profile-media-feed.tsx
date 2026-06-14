import { useIsFocused } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer } from 'expo-video';
import { ArrowLeft, FileText, ImageOff, Images, MoreVertical, Play, Repeat2, Share2 } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { ActivityIndicator, FlatList, Linking, Modal, Platform, Pressable, ScrollView, Share, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FantasyPortalArt } from '@/components/fantasy-portal-art';
import { FeedMediaFrame } from '@/components/feed-media-frame';
import { FeedVideoPreview } from '@/components/feed-video-preview';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import {
  getImmersiveInitialIndex,
  type ImmersivePreviewItem,
} from '@/lib/immersive-preview-view-model';
import {
  buildViewerItems,
  loadImmersiveSourceData,
  normalizeParam,
  normalizeViewerSource,
  readCachedImmersiveSourceData,
  readCachedProfile,
} from '@/lib/immersive-preview-source-data';
import { getProfileHandle } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import type { ShowcaseMediaItem } from '@/lib/types';

type ProfileMediaFeedParams = {
  source?: string | string[];
  initialId?: string | string[];
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

  const sourceQuery = useQuery({
    queryKey: ['immersive-preview-source', source, user?.id ?? 'guest', initialId],
    enabled: Boolean(source),
    initialData: () => readCachedImmersiveSourceData(queryClient, source, user?.id, initialId),
    queryFn: () => loadImmersiveSourceData({ api, source, initialId }),
    staleTime: 1000 * 45,
  });

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

  useEffect(() => {
    if (!items.length) return;
    const frame = scheduleFrame(() => {
      setActiveIndex(initialIndex);
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
    });
    return () => cancelFrame(frame);
  }, [initialIndex, items.length]);

  const saveMutation = useMutation({
    mutationFn: (postId: string) => api.saveShowcasePost(postId),
    onSuccess: async (_result, postId) => {
      await Haptics.selectionAsync();
      await queryClient.invalidateQueries({ queryKey: ['showcase-feed'] });
      await queryClient.invalidateQueries({ queryKey: ['showcase-post', postId] });
      await queryClient.invalidateQueries({ queryKey: ['profile-saved-media', user?.id] });
    },
  });

  const saveItem = (item: ImmersivePreviewItem) => {
    if (!item.canSave || !item.showcasePostId) return;
    if (!user) {
      router.push('/auth');
      return;
    }
    saveMutation.mutate(item.showcasePostId);
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
      const prompt = response.prefill?.prompt ?? item.recreatePrompt;
      if (prompt) {
        router.push(`/create/${item.recreateTool}?prompt=${encodeURIComponent(prompt)}` as never);
        return;
      }
      if (response.redirectTo) {
        await Linking.openURL(`${env.siteUrl}${response.redirectTo}`);
        return;
      }
    }

    router.push(`/create/${item.recreateTool}?prompt=${encodeURIComponent(item.recreatePrompt)}` as never);
  };

  if (!items.length && sourceQuery.isLoading) {
    return (
      <ProfileFeedShell topInset={topInset} bottomInset={bottomInset}>
        <ActivityIndicator accessibilityLabel="Loading profile media" color="#d946ef" />
      </ProfileFeedShell>
    );
  }

  if (!items.length) {
    return (
      <ProfileFeedShell topInset={topInset} bottomInset={bottomInset}>
        <Text selectable style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>No items found in this section.</Text>
      </ProfileFeedShell>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#05050c' }}>
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
        initialScrollIndex={initialIndex}
        keyExtractor={(item) => `${item.source}-${item.id}`}
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
            onDetails={() => setDetailsOpenItemId(item.id)}
            onRecreate={() => void recreateItem(item)}
            onSave={() => saveItem(item)}
            onShare={() => void shareItem(item)}
            saveLoading={saveMutation.isPending && saveMutation.variables === item.showcasePostId}
            width={width}
          />
        )}
        showsVerticalScrollIndicator={false}
        snapToInterval={pageHeight}
        style={{ flex: 1, backgroundColor: '#05050c' }}
        testID="profile-media-feed-list"
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
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#05050c', paddingTop: topInset, paddingBottom: bottomInset, paddingHorizontal: 24 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={() => router.back()}
        style={{ position: 'absolute', left: 12, top: topInset + 7, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <ArrowLeft size={29} color="#ffffff" strokeWidth={2.4} />
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
        borderBottomColor: 'rgba(255,255,255,0.08)',
        backgroundColor: '#0b0a13',
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
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.68 : 1,
        })}
      >
        <ArrowLeft size={29} color="#ffffff" strokeWidth={2.4} />
      </Pressable>
      <Text numberOfLines={1} style={{ color: '#fff', fontSize: 19, fontWeight: '900' }}>
        {sourceTitle}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open media options"
        disabled={!activeItem}
        onPress={onActionsOpen}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: !activeItem ? 0.38 : pressed ? 0.68 : 1,
        })}
      >
        <MoreVertical size={27} color="#ffffff" strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}

function ProfileFeedPage({
  active,
  bottomInset,
  height,
  item,
  onDetails,
  onRecreate,
  onSave,
  onShare,
  saveLoading,
  width,
}: {
  active: boolean;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onDetails: () => void;
  onRecreate: () => void;
  onSave: () => void;
  onShare: () => void;
  saveLoading: boolean;
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
      style={{ width, height, backgroundColor: '#05050c' }}
    >
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 }}>
        <ProfileFeedCreatorRow item={item} />
      </View>
      <ProfileFeedMediaCarousel active={active} item={item} width={width} />
      <ProfileFeedActionRow
        item={item}
        onDetails={onDetails}
        onRecreate={onRecreate}
        onSave={onSave}
        onShare={onShare}
        saveLoading={saveLoading}
      />
      <View style={{ paddingHorizontal: 14, paddingTop: 8, gap: 8 }}>
        <Text selectable numberOfLines={2} style={{ color: '#fff', fontSize: 17, lineHeight: 21, fontWeight: '900' }}>
          {item.title}
        </Text>
        {displayText ? (
          <Text selectable numberOfLines={4} style={{ color: 'rgba(255,255,255,0.76)', fontSize: 14, lineHeight: 20, fontWeight: '600' }}>
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
        <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 15, fontWeight: '900' }}>
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
    <View style={{ width: 38, height: 38, borderRadius: 19, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: '#27272a' }}>
      {item.creatorAvatar ? (
        <Image source={{ uri: item.creatorAvatar }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
      ) : (
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '900' }}>{initial}</Text>
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
        <LinearGradient
          colors={['#17051d', '#060609', '#07171f']}
          style={{ minHeight: 360, borderRadius: 6, borderCurve: 'continuous', justifyContent: 'center', padding: 18 }}
        >
          <Text selectable numberOfLines={10} style={{ color: '#fff', fontSize: 19, lineHeight: 26, fontWeight: '900' }}>
            {item.displayText || item.title}
          </Text>
        </LinearGradient>
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
        keyExtractor={(mediaItem) => mediaItem.id}
        onMomentumScrollEnd={(event) => {
          const nextIndex = Math.round(event.nativeEvent.contentOffset.x / width);
          setCurrentIndex(Math.max(0, Math.min(pages.length - 1, nextIndex)));
        }}
        pagingEnabled
        renderItem={({ item: mediaItem, index }) => (
          <View style={{ width, alignItems: 'center', backgroundColor: '#030308' }}>
            <ProfileFeedMediaFrame
              active={active && index === currentIndex}
              mediaItem={mediaItem}
              width={frameWidth}
              height={mediaFrameHeight(mediaItem, frameWidth, fallbackHeight)}
            />
          </View>
        )}
        showsHorizontalScrollIndicator={false}
      />
      {pages.length > 1 ? (
        <>
          <View style={{ position: 'absolute', top: 10, right: 12, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.58)', paddingHorizontal: 9, paddingVertical: 5 }}>
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>{currentIndex + 1}/{pages.length}</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 5, paddingTop: 10 }}>
            {pages.map((mediaItem, index) => (
              <View
                key={`dot-${mediaItem.id}`}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: index === currentIndex ? '#7c3cff' : 'rgba(255,255,255,0.26)',
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
            recyclingKey={`profile-feed:${mediaItem.id}`}
            radius={0}
            style={{ width, height }}
          />
          <ProfileFeedPlayBadge />
        </View>
      );
    }

    return (
      <View style={{ width, height, backgroundColor: '#090914' }}>
        <FeedVideoPreview
          url={mediaItem.url}
          active={false}
          height={height}
          radius={0}
          accent="#67e8f9"
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
        recyclingKey={`profile-feed:${mediaItem.id}`}
        radius={0}
        style={{ width, height }}
      />
    );
  }

  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center', backgroundColor: '#090914' }}>
      <ImageOff size={32} color="rgba(255,255,255,0.58)" />
    </View>
  );
}

function ActiveProfileFeedVideo({
  url,
  previewUrl,
  width,
  height,
  recyclingKey,
}: {
  url: string;
  previewUrl?: string | null;
  width: number;
  height: number;
  recyclingKey: string;
}) {
  const [hasFrame, setHasFrame] = useState(false);
  const [hasError, setHasError] = useState(false);
  const player = useVideoPlayer({ uri: url, useCaching: true }, (instance) => {
    instance.loop = true;
    instance.muted = false;
    instance.volume = 1.0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
  });
  const [isPlaying, setIsPlaying] = useState(player.playing);

  useEffect(() => {
    player.play();
    setIsPlaying(player.playing);
  }, [player]);

  useEffect(() => {
    setHasFrame(false);
    setHasError(false);
  }, [url]);

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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
      onPress={togglePlayback}
      style={{ width, height, alignItems: 'center', justifyContent: 'center', backgroundColor: '#030308' }}
    >
      <FeedMediaFrame
        kind="video"
        player={player}
        backdropUrl={previewUrl}
        posterUrl={previewUrl}
        posterVisible={Boolean(previewUrl && (!hasFrame || hasError))}
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
          <ActivityIndicator color="#f97316" />
        </View>
      ) : null}
      {!isPlaying && hasFrame ? <ProfileFeedPlayBadge /> : null}
    </Pressable>
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
  onDetails,
  onRecreate,
  onSave,
  onShare,
  saveLoading,
}: {
  item: ImmersivePreviewItem;
  onDetails: () => void;
  onRecreate: () => void;
  onSave: () => void;
  onShare: () => void;
  saveLoading: boolean;
}) {
  return (
    <View style={{ paddingHorizontal: 14, paddingTop: 12, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <ProfileFeedIconButton
            accessibilityLabel="Recreate media"
            icon={<Repeat2 size={28} color="#ffffff" strokeWidth={2.6} />}
            onPress={onRecreate}
          />
          <ProfileFeedIconButton
            accessibilityLabel="Share media"
            icon={<Share2 size={27} color="#ffffff" strokeWidth={2.5} />}
            onPress={onShare}
          />
          <ProfileFeedIconButton
            accessibilityLabel="View media details"
            icon={<FileText size={27} color="#ffffff" strokeWidth={2.4} />}
            onPress={onDetails}
          />
        </View>
        {item.mediaItems.length > 1 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Images size={17} color="rgba(255,255,255,0.64)" />
            <Text style={{ color: 'rgba(255,255,255,0.64)', fontSize: 12, fontWeight: '900' }}>
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
          style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.72 : 1 })}
        >
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '900' }}>{item.isSaved ? 'Saved' : 'Save'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ProfileFeedIconButton({ accessibilityLabel, icon, onPress }: { accessibilityLabel: string; icon: React.ReactNode; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 34,
        height: 34,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.68 : 1,
      })}
    >
      {icon}
    </Pressable>
  );
}

function ProfileFeedMetaPill({ label }: { label: string }) {
  return (
    <View style={{ borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', paddingHorizontal: 9, paddingVertical: 5 }}>
      <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.74)', fontSize: 11, fontWeight: '900' }}>
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

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
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
            borderColor: 'rgba(255,255,255,0.12)',
            backgroundColor: '#0c0c16',
            paddingTop: 12,
            paddingBottom: bottomInset + 18,
          }}
        >
          <View style={{ width: 42, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)', alignSelf: 'center', marginBottom: 12 }} />
          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
            <Text style={{ color: '#fff', fontSize: 22, lineHeight: 27, fontWeight: '900' }}>{item.title}</Text>
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
      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{title}</Text>
      {body ? (
        <Text selectable style={{ color: 'rgba(255,255,255,0.78)', fontSize: 14, lineHeight: 21 }}>{body}</Text>
      ) : (
        <Text style={{ color: 'rgba(255,255,255,0.48)', fontSize: 14 }}>{emptyLabel}</Text>
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

function scheduleFrame(callback: () => void) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 0);
}

function cancelFrame(handle: number) {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}
