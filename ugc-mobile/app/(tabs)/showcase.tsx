import { FlashList, type ListRenderItem, type ViewToken } from '@shopify/flash-list';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Heart, Play, RefreshCw, Search, SlidersHorizontal } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeedVideoPreview } from '@/components/feed-video-preview';
import { TextPreviewCard } from '@/components/text-preview-card';
import { StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { isShowcaseVideoPreviewCandidate, selectActiveShowcaseVideoIds } from '@/lib/showcase-display';
import {
  SHOWCASE_FEED_STALE_TIME_MS,
  createShowcaseFeedQueryKey,
  createShowcasePostQueryKey,
  flattenShowcaseFeedPages,
  getNextShowcaseFeedOffset,
  getShowcaseFeedPageParams,
} from '@/lib/showcase-feed-query';
import {
  buildShowcaseMasonry,
  getShowcaseGridLayout,
  type ShowcaseGridLayout,
  type ShowcaseMasonryCard,
} from '@/lib/showcase-feed-view-model';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { accentColor, appTheme } from '@/lib/theme';
import type { ShowcaseFeedItem, ShowcaseFeedResponse } from '@/lib/types';

const FILTERS = ['For you', 'UGC', 'Beauty', 'Food', 'Prompts', 'Remixable'];
const SKELETON_HEIGHTS = [
  [196, 230, 244],
  [230, 260, 196],
];
const LOAD_MORE_COOLDOWN_MS = 800;
const MAX_ACTIVE_VIDEO_PREVIEWS = 3;
const FEED_HORIZONTAL_PADDING = 8;

export default function ShowcaseScreen() {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const gridLayout = getShowcaseGridLayout(width);
  const queryKey = useMemo(() => createShowcaseFeedQueryKey(), []);
  const [activeVideoIds, setActiveVideoIds] = useState<string[]>([]);
  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMoreItemCountRef = useRef(0);
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 55,
    minimumViewTime: 180,
  }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<ViewToken<ShowcaseMasonryCard>> }) => {
    const visibleItems = getVisibleCardItems(viewableItems);
    const nextVideoIds = selectActiveShowcaseVideoIds(visibleItems, MAX_ACTIVE_VIDEO_PREVIEWS);
    setActiveVideoIds((current) => (sameStringList(current, nextVideoIds) ? current : nextVideoIds));
  }).current;
  const showcaseQuery = useInfiniteQuery({
    queryKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.getShowcaseFeed(getShowcaseFeedPageParams({ offset: pageParam })),
    getNextPageParam: getNextShowcaseFeedOffset,
    staleTime: SHOWCASE_FEED_STALE_TIME_MS,
  });
  const showcaseItems = useMemo(() => flattenShowcaseFeedPages(showcaseQuery.data?.pages), [showcaseQuery.data?.pages]);
  const cards = useMemo(() => buildShowcaseMasonry(showcaseItems), [showcaseItems]);
  const hasItems = showcaseItems.length > 0;
  const isFirstLoad = showcaseQuery.isLoading && !hasItems;
  const isRefreshing = showcaseQuery.isRefetching && !showcaseQuery.isFetchingNextPage;

  const requestNextPage = () => {
    const now = Date.now();
    if (
      !showcaseQuery.hasNextPage ||
      showcaseQuery.isFetchingNextPage ||
      showcaseQuery.isLoading ||
      loadingMoreRef.current ||
      lastLoadMoreItemCountRef.current === showcaseItems.length ||
      now - lastLoadMoreAtRef.current < LOAD_MORE_COOLDOWN_MS
    ) {
      return;
    }

    loadingMoreRef.current = true;
    lastLoadMoreAtRef.current = now;
    lastLoadMoreItemCountRef.current = showcaseItems.length;
    void showcaseQuery.fetchNextPage().finally(() => {
      loadingMoreRef.current = false;
    });
  };

  const handleRefresh = () => {
    lastLoadMoreItemCountRef.current = 0;
    lastLoadMoreAtRef.current = 0;
    queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(queryKey, (current) => {
      if (!current?.pages.length) return current;
      return {
        pages: current.pages.slice(0, 1),
        pageParams: current.pageParams.slice(0, 1),
      };
    });
    void showcaseQuery.refetch();
  };

  const openPost = (item: ShowcaseFeedItem) => {
    queryClient.setQueryData(createShowcasePostQueryKey(item.id, user?.id), item);
    router.push(immersiveViewerHref({ source: 'showcase-feed', initialId: item.id }) as never);
  };

  const renderCard: ListRenderItem<ShowcaseMasonryCard> = ({ item, target }) => {
    return (
      <MasonryCardCell layout={gridLayout}>
        <MasonryPin
          card={item}
          layout={gridLayout}
          activeVideoIds={target === 'Cell' ? activeVideoIds : []}
          onOpenPost={openPost}
        />
      </MasonryCardCell>
    );
  };

  return (
    <FlashList
      contentInsetAdjustmentBehavior="never"
      data={isFirstLoad ? [] : cards}
      drawDistance={900}
      extraData={activeVideoIds}
      getItemType={(item) => item.item.category === 'text' || item.item.postFormat === 'text' ? 'text' : item.mediaKind ?? item.item.category}
      keyExtractor={(item) => item.id}
      masonry
      numColumns={2}
      optimizeItemArrangement={false}
      onEndReached={requestNextPage}
      onEndReachedThreshold={0.32}
      onRefresh={handleRefresh}
      onViewableItemsChanged={onViewableItemsChanged}
      refreshing={isRefreshing}
      renderItem={renderCard}
      showsVerticalScrollIndicator={false}
      style={{ flex: 1, backgroundColor: appTheme.colors.background }}
      contentContainerStyle={{
        paddingTop: topInset + appTheme.spacing.screen,
        paddingHorizontal: FEED_HORIZONTAL_PADDING,
        paddingBottom: tabBarMetrics.contentBottomPadding,
      }}
      ListHeaderComponent={
        <View style={{ gap: appTheme.spacing.section, paddingBottom: appTheme.spacing.section }}>
          <View style={{ gap: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <View style={{ gap: 4, flex: 1 }}>
                <Text selectable style={{ color: appTheme.colors.text, fontSize: 34, lineHeight: 38, fontWeight: '900' }}>
                  Showcase
                </Text>
                <Text selectable style={{ color: appTheme.colors.muted, fontSize: 13, fontWeight: '600' }}>
                  Fresh creator pins
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 9 }}>
                <IconButton label="Search showcase">
                  <Search size={19} color={appTheme.colors.text} strokeWidth={2.4} />
                </IconButton>
                <IconButton label="Filter showcase">
                  <SlidersHorizontal size={19} color={appTheme.colors.text} strokeWidth={2.4} />
                </IconButton>
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {FILTERS.map((filter, index) => (
                <Pressable
                  key={filter}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    minHeight: 34,
                    justifyContent: 'center',
                    borderRadius: appTheme.radii.pill,
                    borderWidth: 1,
                    borderColor: index === 0 ? 'rgba(56,189,248,0.55)' : appTheme.colors.border,
                    backgroundColor: index === 0 ? 'rgba(56,189,248,0.14)' : appTheme.colors.panelSoft,
                    opacity: pressed ? 0.75 : 1,
                    paddingHorizontal: 13,
                  })}
                >
                  <Text style={{ color: index === 0 ? appTheme.colors.text : appTheme.colors.muted, fontSize: 12, fontWeight: '800' }}>
                    {filter}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh showcase"
                disabled={showcaseQuery.isFetching && !showcaseQuery.isFetchingNextPage}
                onPress={handleRefresh}
                style={({ pressed }) => ({
                  width: 34,
                  height: 34,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: appTheme.radii.pill,
                  borderWidth: 1,
                  borderColor: appTheme.colors.border,
                  backgroundColor: appTheme.colors.panelSoft,
                  opacity: pressed ? 0.75 : showcaseQuery.isFetching && !showcaseQuery.isFetchingNextPage ? 0.52 : 1,
                })}
              >
                <RefreshCw size={15} color={appTheme.colors.muted} strokeWidth={2.5} />
              </Pressable>
            </View>
          </View>
          {showcaseQuery.error ? (
            <StatusBlock
              tone="danger"
              title="Could not load showcase"
              body={showcaseQuery.error instanceof Error ? showcaseQuery.error.message : 'Try again.'}
            />
          ) : null}
          {isFirstLoad ? <ShowcaseSkeletonGrid layout={gridLayout} /> : null}
        </View>
      }
      ListEmptyComponent={
        !isFirstLoad && !showcaseQuery.error && !hasItems ? (
          <StatusBlock title="No posts loaded" body="Check the API URL or try again in a moment." />
        ) : null
      }
      ListFooterComponent={!isFirstLoad && showcaseQuery.isFetchingNextPage ? <BottomLoader /> : null}
      viewabilityConfig={viewabilityConfig}
    />
  );
}

function getVisibleCardItems(viewableItems: Array<ViewToken<ShowcaseMasonryCard>>) {
  const items: ShowcaseFeedItem[] = [];

  for (const token of viewableItems) {
    if (!token.isViewable || !token.item) continue;
    items.push(token.item.item);
  }

  return items;
}

function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function MasonryCardCell({ children, layout }: { children: React.ReactNode; layout: ShowcaseGridLayout }) {
  return (
    <View style={{ paddingHorizontal: layout.columnGap / 2, paddingBottom: layout.pinGap }}>
      {children}
    </View>
  );
}

function IconButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panelSoft,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function ShowcaseSkeletonGrid({ layout }: { layout: ShowcaseGridLayout }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: layout.columnGap }}>
      {SKELETON_HEIGHTS.map((column, columnIndex) => (
        <View key={columnIndex} style={{ flex: 1, minWidth: 0, gap: layout.pinGap }}>
          {column.map((height, index) => (
            <SkeletonPin key={`${columnIndex}-${height}-${index}`} height={height} layout={layout} />
          ))}
        </View>
      ))}
    </View>
  );
}

function SkeletonPin({ height, layout }: { height: number; layout: ShowcaseGridLayout }) {
  return (
    <View
      style={{
        gap: 9,
      }}
    >
      <View
        style={{
          height,
          borderRadius: layout.mediaRadius,
          borderCurve: 'continuous',
          backgroundColor: 'rgba(255,255,255,0.07)',
        }}
      >
        <View
          style={{
            position: 'absolute',
            right: 9,
            top: 9,
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: 'rgba(255,255,255,0.12)',
          }}
        />
      </View>
      <View style={{ gap: 8, paddingBottom: 8 }}>
        <View style={{ width: '90%', height: 17, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.11)' }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.10)' }} />
          <View style={{ flex: 1, height: 13, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)' }} />
          <View style={{ width: 34, height: 13, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)' }} />
        </View>
      </View>
    </View>
  );
}

function BottomLoader() {
  return (
    <View style={{ minHeight: 52, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#d946ef" />
    </View>
  );
}

function MasonryPin({
  card,
  layout,
  activeVideoIds,
  onOpenPost,
}: {
  card: ShowcaseMasonryCard;
  layout: ShowcaseGridLayout;
  activeVideoIds: string[];
  onOpenPost: (item: ShowcaseFeedItem) => void;
}) {
  const accent = accentColor(card.accent);
  const isVideoCard = isShowcaseVideoPreviewCandidate(card.item);
  const showActiveVideo = isVideoCard && activeVideoIds.includes(card.id) && Boolean(card.mediaUrl);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      onPress={() => onOpenPost(card.item)}
      style={({ pressed }) => ({
        gap: 8,
        opacity: pressed ? 0.88 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <View
        style={{
          borderRadius: layout.mediaRadius,
          borderCurve: 'continuous',
          overflow: 'hidden',
          backgroundColor: '#050506',
        }}
      >
        {card.mediaUrl && !isVideoCard ? (
          <Image
            source={{ uri: card.mediaUrl }}
            contentFit="cover"
            transition={120}
            style={{
              width: '100%',
              height: card.height,
              backgroundColor: '#050506',
            }}
          />
        ) : showActiveVideo && card.mediaUrl ? (
          <FeedVideoPreview url={card.mediaUrl} active height={card.height} radius={layout.mediaRadius} accent={accent} />
        ) : isVideoCard ? (
          <VideoPinPreview accent={accent} height={card.height} radius={layout.mediaRadius} />
        ) : (
          <TextPreviewCard text={card.prompt} accent={accent} height={card.height} radius={layout.mediaRadius} />
        )}
        {isVideoCard ? <VideoCornerPlay /> : null}
      </View>

      <View style={{ gap: 7, paddingBottom: 8 }}>
        <Text numberOfLines={2} style={{ color: appTheme.colors.text, fontSize: 19, lineHeight: 23, fontWeight: '500' }}>
          {card.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <CreatorAvatar uri={card.creatorAvatar} name={card.creatorLabel} />
            <Text numberOfLines={1} style={{ color: appTheme.colors.muted, flex: 1, fontSize: 16, fontWeight: '500' }}>
              {card.creatorLabel}
            </Text>
            <CreatorKBadge />
          </View>
          <PinStat icon={<Heart size={24} color={appTheme.colors.text} strokeWidth={2.3} />} label={card.saveLabel} />
        </View>
      </View>
    </Pressable>
  );
}

function CreatorAvatar({ uri, name }: { uri: string | null; name: string }) {
  const initial = name.trim()[0]?.toUpperCase() || 'C';

  return (
    <View
      style={{
        width: 25,
        height: 25,
        borderRadius: 12.5,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#27272a',
      }}
    >
      {uri ? (
        <Image source={{ uri }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
      ) : (
        <Text style={{ color: appTheme.colors.text, fontSize: 11, fontWeight: '800' }}>{initial}</Text>
      )}
    </View>
  );
}

function CreatorKBadge() {
  return (
    <View
      accessibilityLabel="Creator badge"
      style={{
        width: 21,
        height: 21,
        borderRadius: 10.5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f59e0b',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.32)',
      }}
    >
      <Text style={{ color: '#fff7ed', fontSize: 13, lineHeight: 16, fontWeight: '900' }}>K</Text>
    </View>
  );
}

function VideoCornerPlay() {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        width: 31,
        height: 31,
        borderRadius: 15.5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.42)',
      }}
    >
      <Play size={16} color="#ffffff" fill="#ffffff" strokeWidth={2.5} />
    </View>
  );
}

function VideoPinPreview({ accent, height, radius }: { accent: string; height: number; radius: number }) {
  return (
    <View
      style={{
        height,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: `${accent}4d`,
        backgroundColor: '#07070c',
        overflow: 'hidden',
      }}
    >
      <View style={{ position: 'absolute', inset: 0, backgroundColor: `${accent}12` }} />
      <View
        style={{
          width: 46,
          height: 46,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 23,
          backgroundColor: `${accent}24`,
          borderWidth: 1,
          borderColor: `${accent}66`,
        }}
      >
        <Play size={21} color={accent} fill={accent} strokeWidth={2.4} />
      </View>
    </View>
  );
}

function PinStat({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {icon}
      <Text style={{ color: appTheme.colors.muted, fontSize: 16, fontWeight: '500', fontVariant: ['tabular-nums'] }}>
        {label}
      </Text>
    </View>
  );
}
