import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ArrowLeft, Heart, ImageOff, Play, Repeat2, Share2 } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, Share, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FantasyPortalArt } from '@/components/fantasy-portal-art';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import {
  buildImmersiveGenerationItems,
  buildImmersiveOwnerPostItems,
  buildImmersiveShowcaseItems,
  getImmersiveInitialIndex,
  selectActiveImmersiveVideoId,
  type ImmersivePreviewItem,
  type PreviewViewerSource,
} from '@/lib/immersive-preview-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { flattenShowcaseFeedPages } from '@/lib/showcase-feed-query';
import type {
  GenerationListItem,
  OwnerPostsResponse,
  ProfileResponse,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
} from '@/lib/types';
import { getProfileHandle } from '@/lib/profile-view-model';

const VIEWER_SOURCES: PreviewViewerSource[] = [
  'showcase-feed',
  'home-community',
  'profile-saved',
  'profile-posts',
  'profile-creations',
  'studio-creations',
  'home-creations',
];

type ImmersiveSourceData = {
  showcaseItems?: ShowcaseFeedItem[];
  generations?: GenerationListItem[];
  ownerPosts?: OwnerPostsResponse['posts'];
};

type ViewerParams = {
  source?: string | string[];
  initialId?: string | string[];
};

export default function ImmersivePreviewViewerScreen() {
  const params = useLocalSearchParams<ViewerParams>();
  const source = normalizeViewerSource(params.source);
  const initialId = normalizeParam(params.initialId);
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const listRef = useRef<FlatList<ImmersivePreviewItem>>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    initialData: () => queryClient.getQueryData<ProfileResponse>(['profile', user?.id])
      ?? queryClient.getQueryData<ProfileResponse>(['home-profile', user?.id]),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });

  const sourceQuery = useQuery({
    queryKey: ['immersive-preview-source', source, user?.id ?? 'guest', initialId],
    enabled: Boolean(source),
    initialData: () => readCachedSourceData(queryClient, source, user?.id, initialId),
    queryFn: () => loadSourceData({ api, source, initialId }),
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
  const activeVideoId = selectActiveImmersiveVideoId(items, activeIndex);
  const activeItem = items[activeIndex];

  useEffect(() => {
    if (!items.length) return;
    setActiveIndex(initialIndex);
    requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
    });
  }, [initialIndex, items.length]);

  const saveMutation = useMutation({
    mutationFn: (postId: string) => api.saveShowcasePost(postId),
    onSuccess: async (_result, postId) => {
      await Haptics.selectionAsync();
      await queryClient.invalidateQueries({ queryKey: ['showcase-feed'] });
      await queryClient.invalidateQueries({ queryKey: ['showcase-post', postId] });
      await queryClient.invalidateQueries({ queryKey: ['profile-saved-showcase', user?.id] });
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
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <ActivityIndicator accessibilityLabel="Loading preview" color="#6cff4a" />
      </ViewerShell>
    );
  }

  if (!items.length) {
    return (
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <Text selectable style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>Preview unavailable</Text>
        <Text selectable style={{ color: 'rgba(255,255,255,0.64)', marginTop: 8 }}>This item may have been removed or is still loading.</Text>
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
        initialScrollIndex={initialIndex}
        keyExtractor={(item) => `${item.source}-${item.id}`}
        onMomentumScrollEnd={(event) => {
          const nextIndex = Math.round(event.nativeEvent.contentOffset.y / height);
          setActiveIndex(Math.max(0, Math.min(items.length - 1, nextIndex)));
        }}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset: height * index, animated: false });
          });
        }}
        pagingEnabled
        renderItem={({ item, index }) => (
          <ImmersiveSlide
            active={index === activeIndex}
            activeVideoId={activeVideoId}
            bottomInset={bottomInset}
            height={height}
            item={item}
            onRecreate={recreateItem}
            onSave={saveItem}
            onShare={shareItem}
            saveLoading={saveMutation.isPending && saveMutation.variables === item.showcasePostId}
            topInset={topInset}
            width={width}
          />
        )}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: '#000' }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={() => router.back()}
        style={({ pressed }) => ({
          position: 'absolute',
          left: 16,
          top: topInset + 10,
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 22,
          backgroundColor: 'rgba(0,0,0,0.18)',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <ArrowLeft size={30} color="#ffffff" strokeWidth={2.4} />
      </Pressable>
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
        onPress={() => router.back()}
        style={{ position: 'absolute', left: 16, top: topInset + 10, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <ArrowLeft size={30} color="#ffffff" strokeWidth={2.4} />
      </Pressable>
      {children}
    </View>
  );
}

function ImmersiveSlide({
  active,
  activeVideoId,
  bottomInset,
  height,
  item,
  onRecreate,
  onSave,
  onShare,
  saveLoading,
  topInset,
  width,
}: {
  active: boolean;
  activeVideoId: string | null;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  saveLoading: boolean;
  topInset: number;
  width: number;
}) {
  return (
    <View style={{ width, height, backgroundColor: '#000' }}>
      <ImmersiveMedia item={item} active={active && activeVideoId === item.id} width={width} height={height} />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(0,0,0,0.42)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.78)']}
        locations={[0, 0.42, 1]}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          right: 15,
          bottom: bottomInset + 132,
          alignItems: 'center',
          gap: 22,
        }}
      >
        <CreatorBubble item={item} />
        <RailButton
          disabled={!item.canSave}
          icon={<Heart size={38} color="#ffffff" fill={item.isSaved ? '#ffffff' : 'transparent'} strokeWidth={2.6} />}
          label={item.saveLabel}
          loading={saveLoading}
          onPress={() => onSave(item)}
        />
        <RailButton
          icon={<Share2 size={38} color="#ffffff" fill="#ffffff" strokeWidth={2.4} />}
          label="Share"
          onPress={() => void onShare(item)}
        />
      </View>
      <View
        style={{
          position: 'absolute',
          left: 22,
          right: 110,
          bottom: bottomInset + 28,
          gap: 9,
          paddingTop: topInset,
        }}
      >
        <View style={{ alignSelf: 'flex-start', borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{item.badge}</Text>
        </View>
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 23, fontWeight: '700' }}>
          {item.creatorLabel}
        </Text>
        <Text numberOfLines={2} style={{ color: '#fff', fontSize: 17, lineHeight: 22, fontWeight: '500' }}>
          {item.title}
        </Text>
        <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.78)', fontSize: 15, lineHeight: 21 }}>
          {item.displayText}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Recreate"
        onPress={() => void onRecreate(item)}
        style={({ pressed }) => ({
          position: 'absolute',
          right: 20,
          bottom: bottomInset + 27,
          minWidth: 128,
          minHeight: 58,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 29,
          backgroundColor: '#67ff45',
          opacity: pressed ? 0.82 : 1,
          paddingHorizontal: 20,
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Repeat2 size={20} color="#050505" strokeWidth={2.8} />
          <Text numberOfLines={1} style={{ color: '#050505', fontSize: 18, fontWeight: '900' }}>Recreate</Text>
        </View>
      </Pressable>
    </View>
  );
}

function ImmersiveMedia({ item, active, width, height }: { item: ImmersivePreviewItem; active: boolean; width: number; height: number }) {
  if (item.previewKind === 'text') {
    return <TextSlide item={item} width={width} height={height} />;
  }

  if (item.mediaKind === 'video') {
    if (active && item.mediaUrl) {
      return <ActiveVideo url={item.mediaUrl} width={width} height={height} />;
    }

    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center', backgroundColor: '#020203' }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' }}>
          <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} />
        </View>
      </View>
    );
  }

  if (item.mediaUrl) {
    return (
      <Image
        source={{ uri: item.mediaUrl }}
        contentFit="contain"
        transition={120}
        style={{ width, height, backgroundColor: '#000' }}
      />
    );
  }

  return (
    <View style={{ width, height, backgroundColor: '#07070c' }}>
      <FantasyPortalArt variant="portal" muted />
      <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
        <ImageOff size={34} color="rgba(255,255,255,0.68)" />
      </View>
    </View>
  );
}

function ActiveVideo({ url, width, height }: { url: string; width: number; height: number }) {
  const player = useVideoPlayer(url, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.volume = 0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
  });

  useEffect(() => {
    player.play();
  }, [player]);

  return (
    <VideoView
      player={player}
      nativeControls={false}
      contentFit="contain"
      fullscreenOptions={{ enable: false }}
      allowsPictureInPicture={false}
      startsPictureInPictureAutomatically={false}
      useExoShutter={false}
      surfaceType="textureView"
      style={{ width, height, backgroundColor: '#000' }}
    />
  );
}

function TextSlide({ item, width, height }: { item: ImmersivePreviewItem; width: number; height: number }) {
  return (
    <LinearGradient
      colors={['#16051d', '#050506', '#0a1822']}
      style={{ width, height, justifyContent: 'center', paddingHorizontal: 28 }}
    >
      <View style={{ borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.07)', padding: 22 }}>
        <Text selectable style={{ color: '#fff', fontSize: 28, lineHeight: 36, fontWeight: '900' }}>
          {item.displayText}
        </Text>
      </View>
    </LinearGradient>
  );
}

function CreatorBubble({ item }: { item: ImmersivePreviewItem }) {
  const initial = item.creatorLabel.replace(/^@/, '').trim()[0]?.toUpperCase() || 'C';
  return (
    <View style={{ width: 58, height: 58, borderRadius: 29, padding: 2, backgroundColor: '#fff' }}>
      <View style={{ flex: 1, overflow: 'hidden', borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: '#27272a' }}>
        {item.creatorAvatar ? (
          <Image source={{ uri: item.creatorAvatar }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900' }}>{initial}</Text>
        )}
      </View>
    </View>
  );
}

function RailButton({
  disabled,
  icon,
  label,
  loading,
  onPress,
}: {
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: 'center',
        gap: 5,
        opacity: disabled ? 0.42 : pressed ? 0.72 : 1,
        minWidth: 62,
      })}
    >
      {loading ? <ActivityIndicator color="#fff" /> : icon}
      <Text numberOfLines={1} style={{ color: '#fff', fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
        {label}
      </Text>
    </Pressable>
  );
}

function normalizeViewerSource(value: string | string[] | undefined): PreviewViewerSource {
  const source = normalizeParam(value);
  return VIEWER_SOURCES.includes(source as PreviewViewerSource) ? source as PreviewViewerSource : 'showcase-feed';
}

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function buildViewerItems(
  source: PreviewViewerSource,
  data: ImmersiveSourceData | undefined,
  owner: { creatorLabel: string; creatorAvatar?: string | null }
) {
  if (isGenerationSource(source)) {
    return buildImmersiveGenerationItems(source, data?.generations ?? [], owner);
  }
  if (source === 'profile-posts') {
    return buildImmersiveOwnerPostItems(source, data?.ownerPosts ?? [], owner);
  }
  return buildImmersiveShowcaseItems(source, data?.showcaseItems ?? []);
}

function isGenerationSource(source: PreviewViewerSource) {
  return source === 'profile-creations' || source === 'studio-creations' || source === 'home-creations';
}

async function loadSourceData({
  api,
  source,
  initialId,
}: {
  api: ReturnType<typeof useAuth>['api'];
  source: PreviewViewerSource;
  initialId: string;
}): Promise<ImmersiveSourceData> {
  if (isGenerationSource(source)) {
    const response = await api.listGenerations(true);
    return { generations: response.generations };
  }

  if (source === 'profile-posts') {
    const response = await api.listOwnerPosts({ includeArchived: true, visibility: 'all' });
    return { ownerPosts: response.posts };
  }

  const response = await api.getShowcaseFeed({ limit: 48, sort: 'recent' }, { auth: source === 'profile-saved' });
  let showcaseItems = source === 'profile-saved'
    ? response.items.filter((item) => item.isSaved || item.id === initialId)
    : response.items;

  if (initialId && !showcaseItems.some((item) => item.id === initialId)) {
    const detail = await api.getShowcasePost(initialId).catch(() => null);
    if (detail?.item) {
      showcaseItems = [detail.item, ...showcaseItems];
    }
  }

  return { showcaseItems };
}

function readCachedSourceData(queryClient: QueryClient, source: PreviewViewerSource, userId: string | undefined, initialId: string): ImmersiveSourceData | undefined {
  if (isGenerationSource(source)) {
    const data = cachedGenerations(queryClient, userId);
    return sourceDataContains(data, initialId) ? data : undefined;
  }

  if (source === 'profile-posts') {
    const data = cachedOwnerPosts(queryClient, userId);
    return sourceDataContains(data, initialId) ? data : undefined;
  }

  const data = cachedShowcaseItems(queryClient, source, userId);
  return sourceDataContains(data, initialId) ? data : undefined;
}

function cachedShowcaseItems(queryClient: QueryClient, source: PreviewViewerSource, userId: string | undefined): ImmersiveSourceData | undefined {
  const items: ShowcaseFeedItem[] = [];
  const saved = queryClient.getQueryData<ShowcaseFeedResponse>(['profile-saved-showcase', userId]);
  if (saved?.items.length) {
    items.push(...saved.items);
  }

  const feedQueries = queryClient.getQueriesData<InfiniteData<ShowcaseFeedResponse>>({ queryKey: ['showcase-feed'] });
  for (const [, data] of feedQueries) {
    items.push(...flattenShowcaseFeedPages(data?.pages));
  }

  const deduped = dedupeById(items);
  const showcaseItems = source === 'profile-saved' ? deduped.filter((item) => item.isSaved) : deduped;
  return showcaseItems.length ? { showcaseItems } : undefined;
}

function cachedGenerations(queryClient: QueryClient, userId: string | undefined): ImmersiveSourceData | undefined {
  const all: GenerationListItem[] = [];
  for (const key of [['profile-generations', userId], ['home-generations', userId], ['generations', userId]] as const) {
    const data = queryClient.getQueryData<{ generations: GenerationListItem[] }>(key);
    if (data?.generations.length) all.push(...data.generations);
  }
  const generations = dedupeById(all);
  return generations.length ? { generations } : undefined;
}

function cachedOwnerPosts(queryClient: QueryClient, userId: string | undefined): ImmersiveSourceData | undefined {
  const all: OwnerPostsResponse['posts'] = [];
  for (const key of [['profile-owner-posts', userId], ['home-seller-posts', userId]] as const) {
    const data = queryClient.getQueryData<OwnerPostsResponse>(key);
    if (data?.posts.length) all.push(...data.posts);
  }
  const ownerPosts = dedupeById(all);
  return ownerPosts.length ? { ownerPosts } : undefined;
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

function sourceDataContains(data: ImmersiveSourceData | undefined, initialId: string) {
  if (!data || !initialId) return false;
  return Boolean(
    data.showcaseItems?.some((item) => item.id === initialId)
    || data.generations?.some((item) => item.id === initialId)
    || data.ownerPosts?.some((item) => item.id === initialId)
  );
}
