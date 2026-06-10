import { FlashList, type ListRenderItem, type ViewToken } from '@shopify/flash-list';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { FileText, Heart, Images, Play, RefreshCw, Search, SlidersHorizontal } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeedVideoPreview } from '@/components/feed-video-preview';
import { StatusBlock } from '@/components/ui';
import { WorkspaceSideMenuGestureLayer } from '@/components/workspace-side-menu-gesture-layer';
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
import type { ShowcaseFeedItem, ShowcaseFeedResponse, ShowcaseMediaItem } from '@/lib/types';

const FILTERS = ['For you', 'UGC', 'Beauty', 'Food', 'Prompts', 'Remixable'];
const SKELETON_HEIGHTS = [
  [196, 230, 244],
  [230, 260, 196],
];
const LOAD_MORE_COOLDOWN_MS = 800;
const MAX_ACTIVE_VIDEO_PREVIEWS = 3;
const FEED_HORIZONTAL_PADDING = 14;

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
  const [isSwipingMedia, setIsSwipingMedia] = useState(false);
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
          onScrollToggle={setIsSwipingMedia}
        />
      </MasonryCardCell>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <FlashList
        contentInsetAdjustmentBehavior="never"
        data={isFirstLoad ? [] : cards}
        drawDistance={900}
        extraData={activeVideoIds}
        getItemType={(item) => item.previewKind === 'text' ? 'text' : item.mediaKind ?? item.item.category}
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
        scrollEnabled={!isSwipingMedia}
        showsVerticalScrollIndicator={false}
        style={{
          flex: 1,
          backgroundColor: appTheme.colors.background,
          marginBottom: tabBarMetrics.contentBottomPadding - 10,
        }}
        contentContainerStyle={{
          paddingTop: topInset + appTheme.spacing.screen,
          paddingHorizontal: FEED_HORIZONTAL_PADDING,
          paddingBottom: appTheme.spacing.section + 8,
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
      <WorkspaceSideMenuGestureLayer bottomOffset={tabBarMetrics.contentBottomPadding} enabled={!isSwipingMedia} />
    </View>
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

function CardMediaCarousel({
  mediaItems,
  height,
  radius,
  accent,
  activeVideoIds,
  cardId,
  onPress,
  width,
  onScrollToggle,
}: {
  mediaItems: ShowcaseMediaItem[];
  height: number;
  radius: number;
  accent: string;
  activeVideoIds: string[];
  cardId: string;
  onPress: () => void;
  width: number;
  onScrollToggle?: (scrolling: boolean) => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);

  return (
    <View style={{ height, width, overflow: 'hidden' }}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => onScrollToggle?.(true)}
        onScrollEndDrag={() => onScrollToggle?.(false)}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(event.nativeEvent.contentOffset.x / width);
          setCurrentIndex(index);
          onScrollToggle?.(false);
        }}
        style={{ flex: 1 }}
      >
        {mediaItems.map((item, index) => {
          const isVideo = item.mediaKind === 'video';
          const isActiveVideo = isVideo && activeVideoIds.includes(cardId) && currentIndex === index;

          return (
            <Pressable
              key={item.id}
              onPress={onPress}
              style={{ width, height }}
            >
              {isVideo ? (
                isActiveVideo ? (
                  <FeedVideoPreview
                    url={item.url}
                    active={true}
                    height={height}
                    radius={radius}
                    accent={accent}
                  />
                ) : (
                  <VideoPinPreview accent={accent} height={height} radius={radius} />
                )
              ) : (
                <Image
                  source={{ uri: item.url }}
                  contentFit="cover"
                  transition={120}
                  style={{ width: '100%', height: '100%', backgroundColor: '#050506' }}
                />
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Top right indicator */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: 10,
          top: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.1)',
          backgroundColor: 'rgba(3,3,6,0.68)',
          paddingHorizontal: 8,
          paddingVertical: 4,
        }}
      >
        <Images size={12} color="#ffffff" />
        <Text style={{ color: '#ffffff', fontSize: 10, fontWeight: '800' }}>
          {currentIndex + 1}/{mediaItems.length}
        </Text>
      </View>

      {/* Bottom dots */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          bottom: 10,
          left: 0,
          right: 0,
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 5,
        }}
      >
        {mediaItems.map((_, index) => (
          <View
            key={index}
            style={{
              height: 5,
              width: index === currentIndex ? 12 : 5,
              borderRadius: 2.5,
              backgroundColor: index === currentIndex ? '#ffffff' : 'rgba(255,255,255,0.45)',
            }}
          />
        ))}
      </View>
    </View>
  );
}

function MasonryPin({
  card,
  layout,
  activeVideoIds,
  onOpenPost,
  onScrollToggle,
}: {
  card: ShowcaseMasonryCard;
  layout: ShowcaseGridLayout;
  activeVideoIds: string[];
  onOpenPost: (item: ShowcaseFeedItem) => void;
  onScrollToggle?: (scrolling: boolean) => void;
}) {
  const { width } = useWindowDimensions();
  const columnWidth = (width - FEED_HORIZONTAL_PADDING * 2 - layout.columnGap) / 2;
  const accent = accentColor(card.accent);
  const isVideoCard = isShowcaseVideoPreviewCandidate(card.item);
  const showActiveVideo = isVideoCard && activeVideoIds.includes(card.id) && Boolean(card.mediaUrl);
  const creatorLabel = formatCreatorLabel(card.creatorLabel);
  const mediaItems = card.item.mediaItems ?? [];
  const hasMultipleMedia = mediaItems.length > 1;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      onPress={() => onOpenPost(card.item)}
      style={({ pressed }) => ({
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: pressed ? `${accent}66` : 'rgba(255,255,255,0.11)',
        backgroundColor: 'rgba(18,18,24,0.92)',
        overflow: 'hidden',
        opacity: pressed ? 0.88 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <View
        style={{
          overflow: 'hidden',
          backgroundColor: card.previewKind === 'text' ? 'transparent' : '#050506',
        }}
      >
        {card.previewKind === 'text' ? (
          <TextPinPreview
            accent={accent}
            badge={card.badge}
            height={card.height}
            prompt={card.prompt}
            title={card.title}
          />
        ) : hasMultipleMedia ? (
          <CardMediaCarousel
            mediaItems={mediaItems}
            height={card.height}
            radius={layout.mediaRadius}
            accent={accent}
            activeVideoIds={activeVideoIds}
            cardId={card.id}
            width={columnWidth}
            onPress={() => onOpenPost(card.item)}
            onScrollToggle={onScrollToggle}
          />
        ) : card.mediaUrl && !isVideoCard ? (
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
          <VisualFallbackPreview accent={accent} height={card.height} radius={layout.mediaRadius} />
        )}
        {card.previewKind === 'media' ? (
          <>
            <PinBadge label={card.badge} accent={accent} />
            <LinearGradient
              pointerEvents="none"
              colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.74)', 'rgba(0,0,0,0.92)']}
              locations={[0, 0.58, 1]}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                minHeight: 88,
                justifyContent: 'flex-end',
                paddingHorizontal: 12,
                paddingBottom: 12,
              }}
            >
              <Text numberOfLines={2} style={{ color: appTheme.colors.text, fontSize: 15, lineHeight: 18, fontWeight: '900' }}>
                {card.title}
              </Text>
            </LinearGradient>
            {isVideoCard ? <VideoCornerPlay /> : null}
          </>
        ) : null}
      </View>

      <View style={{ paddingHorizontal: 10, paddingTop: 9, paddingBottom: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <CreatorAvatar uri={card.creatorAvatar} name={creatorLabel} />
            <Text numberOfLines={1} style={{ color: appTheme.colors.muted, flex: 1, fontSize: 12, lineHeight: 15, fontWeight: '800' }}>
              {creatorLabel}
            </Text>
          </View>
          <PinStat icon={<Heart size={16} color={appTheme.colors.text} strokeWidth={2.4} />} label={card.saveLabel} />
        </View>
      </View>
    </Pressable>
  );
}

function formatCreatorLabel(label: string) {
  const clean = label.trim() || 'creator';
  return clean.startsWith('@') ? clean : `@${clean}`;
}

function PinBadge({ label, accent }: { label: string; accent: string }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 10,
        top: 10,
        maxWidth: '82%',
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: `${accent}66`,
        backgroundColor: 'rgba(3,3,6,0.68)',
        paddingHorizontal: 9,
        paddingVertical: 5,
      }}
    >
      <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 10, lineHeight: 12, fontWeight: '900' }}>
        {label}
      </Text>
    </View>
  );
}

function TextPinPreview({
  accent,
  badge,
  height,
  prompt,
  title,
}: {
  accent: string;
  badge: string;
  height: number;
  prompt: string;
  title: string;
}) {
  return (
    <LinearGradient
      colors={['#231126', '#14101c', '#090914']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{
        height,
        borderTopLeftRadius: 21,
        borderTopRightRadius: 21,
        borderCurve: 'continuous',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.08)',
        overflow: 'hidden',
        padding: 13,
      }}
    >
      <View style={{ position: 'absolute', inset: 0, backgroundColor: `${accent}12` }} />
      <View style={{ flex: 1, justifyContent: 'space-between', gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <View
            style={{
              width: 26,
              height: 26,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 13,
              backgroundColor: `${accent}22`,
              borderWidth: 1,
              borderColor: `${accent}55`,
            }}
          >
            <FileText size={14} color={accent} strokeWidth={2.4} />
          </View>
          <Text numberOfLines={1} style={{ color: accent, flex: 1, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', fontWeight: '900' }}>
            {badge}
          </Text>
        </View>
        <View style={{ gap: 7 }}>
          <Text numberOfLines={2} style={{ color: appTheme.colors.text, fontSize: 15, lineHeight: 18, fontWeight: '900' }}>
            {title}
          </Text>
          <Text numberOfLines={5} style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 17, fontWeight: '700' }}>
            {prompt}
          </Text>
        </View>
      </View>
    </LinearGradient>
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

function VisualFallbackPreview({ accent, height, radius }: { accent: string; height: number; radius: number }) {
  return (
    <LinearGradient
      colors={['#06111a', '#090914', '#17071b']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{
        height,
        borderRadius: radius,
        borderCurve: 'continuous',
        overflow: 'hidden',
      }}
    >
      <View style={{ position: 'absolute', inset: 0, backgroundColor: `${accent}14` }} />
      <View
        style={{
          position: 'absolute',
          width: 150,
          height: 150,
          right: -54,
          top: -42,
          borderRadius: 75,
          backgroundColor: `${accent}1f`,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 18,
          top: 24,
          width: 82,
          height: 82,
          borderRadius: 41,
          borderWidth: 1,
          borderColor: `${accent}44`,
        }}
      />
    </LinearGradient>
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
