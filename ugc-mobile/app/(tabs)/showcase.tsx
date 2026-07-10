import { FlashList, type ListRenderItem, type ViewToken } from '@shopify/flash-list';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronRight, FileText, Heart, ImageIcon, Lock, Play, RefreshCw, Repeat2, X } from 'lucide-react-native';
import { useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { SecondaryButton, StatusBlock } from '@/components/ui';
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
  normalizeShowcaseToolFilter,
  resolveMobileShowcaseFeedFilterId,
  type MobileShowcaseFeedFilterId,
  type ShowcaseFeedFilters,
} from '@/lib/showcase-feed-query';
import {
  buildShowcaseMasonry,
  getShowcaseGridLayout,
  getShowcaseMediaHeight,
  type ShowcaseGridLayout,
  type ShowcaseMasonryCard,
} from '@/lib/showcase-feed-view-model';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { SHOWCASE_DRAW_DISTANCE, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS } from '@/lib/media-performance';
import { hasShowcasePreviewMedia } from '@/lib/showcase-media';
import { accentColor, appTheme } from '@/lib/theme';
import type { ShowcaseFeedItem, ShowcaseFeedResponse, ShowcasePostResponse } from '@/lib/types';

type FeedFilterId = MobileShowcaseFeedFilterId;

const FEED_FILTERS: Array<{
  id: FeedFilterId;
  label: string;
  body: string;
  params: ShowcaseFeedFilters;
}> = [
  {
    id: 'all',
    label: 'All',
    body: 'Fresh creator posts with unlocks mixed in.',
    params: {},
  },
  {
    id: 'unlocks',
    label: 'Unlocks',
    body: 'Posts with reusable prompts, files, notes, or remix access.',
    params: { unlock: 'with-unlock' },
  },
  {
    id: 'free',
    label: 'Free',
    body: 'Free resources you can open from the viewer.',
    params: { unlock: 'free' },
  },
  {
    id: 'paid',
    label: 'Paid',
    body: 'Premium creator resources available with credits.',
    params: { unlock: 'paid' },
  },
  {
    id: 'remixable',
    label: 'Remixable',
    body: 'Posts built to recreate, remix, and learn from.',
    params: { resource: 'remix' },
  },
];

const CREATOR_ROW_TAP_START_OFFSET = 0;
const CREATOR_ROW_TAP_END_OFFSET = 68;

const SKELETON_HEIGHTS = [
  [196, 230, 244],
  [230, 260, 196],
];
const LOAD_MORE_COOLDOWN_MS = 800;
const FEED_HORIZONTAL_PADDING = appTheme.spacing.screen;

export default function ShowcaseScreen() {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const routeParams = useLocalSearchParams<{ filter?: string | string[]; tool?: string | string[] }>();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const gridLayout = getShowcaseGridLayout(width);
  const routeFilterId = resolveMobileShowcaseFeedFilterId(routeParams.filter);
  const routeTool = normalizeShowcaseToolFilter(routeParams.tool);
  const [activeFilterId, setActiveFilterId] = useState<FeedFilterId>(routeFilterId);
  const [activeTool, setActiveTool] = useState<string | null>(routeTool);
  const activeFilter = FEED_FILTERS.find((filter) => filter.id === activeFilterId) ?? FEED_FILTERS[0];
  const queryFilters = useMemo<ShowcaseFeedFilters>(() => ({
    ...activeFilter.params,
    ...(activeTool ? { tool: activeTool } : {}),
  }), [activeFilter, activeTool]);
  const queryKey = useMemo(() => createShowcaseFeedQueryKey(queryFilters), [queryFilters]);
  const activeToolLabel = useMemo(() => activeTool ? formatToolLabel(activeTool) : null, [activeTool]);
  const [activeVideoIds, setActiveVideoIds] = useState<string[]>([]);
  const visibleActiveVideoIds = isFocused ? activeVideoIds : [];
  const [isSwipingMedia, setIsSwipingMedia] = useState(false);
  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMoreItemCountRef = useRef(0);
  const viewabilityConfig = useMemo(() => ({
    itemVisiblePercentThreshold: 55,
    minimumViewTime: 180,
  }), []);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<ShowcaseMasonryCard>> }) => {
    const visibleItems = getVisibleCardItems(viewableItems);
    const nextVideoIds = selectActiveShowcaseVideoIds(visibleItems, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS);
    setActiveVideoIds((current) => (sameStringList(current, nextVideoIds) ? current : nextVideoIds));
  }, []);
  const showcaseQuery = useInfiniteQuery({
    queryKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.getShowcaseFeed(getShowcaseFeedPageParams({
      ...queryFilters,
      offset: pageParam,
    })),
    getNextPageParam: getNextShowcaseFeedOffset,
    staleTime: SHOWCASE_FEED_STALE_TIME_MS,
  });
  const showcaseItems = useMemo(() => flattenShowcaseFeedPages(showcaseQuery.data?.pages), [showcaseQuery.data?.pages]);
  const cards = useMemo(() => buildShowcaseMasonry(showcaseItems), [showcaseItems]);
  const hasItems = showcaseItems.length > 0;
  const isFirstLoad = showcaseQuery.isLoading && !hasItems;
  const isRefreshing = showcaseQuery.isRefetching && !showcaseQuery.isFetchingNextPage;

  useEffect(() => {
    setActiveFilterId((current) => current === routeFilterId ? current : routeFilterId);
  }, [routeFilterId]);

  useEffect(() => {
    setActiveTool((current) => current === routeTool ? current : routeTool);
  }, [routeTool]);

  useEffect(() => {
    setActiveVideoIds([]);
    loadingMoreRef.current = false;
    lastLoadMoreAtRef.current = 0;
    lastLoadMoreItemCountRef.current = 0;
  }, [activeFilterId, activeTool]);

  const clearToolFilter = () => {
    setActiveTool(null);
    router.setParams({ tool: undefined } as never);
  };

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
    queryClient.setQueryData<ShowcasePostResponse>(createShowcasePostQueryKey(item.id, user?.id), {
      success: true,
      item,
    });
    router.push(immersiveViewerHref({ source: 'showcase-feed', initialId: item.id }) as never);
  };

  const openCreator = (item: ShowcaseFeedItem) => {
    const username = item.creator.username?.trim();
    if (!username) return;
    router.push(`/creators/${encodeURIComponent(username)}` as never);
  };

  const renderCard: ListRenderItem<ShowcaseMasonryCard> = ({ item, target }) => {
    return (
      <MasonryCardCell layout={gridLayout}>
        <MasonryPin
          card={item}
          layout={gridLayout}
          activeVideoIds={target === 'Cell' ? visibleActiveVideoIds : []}
          onOpenCreator={openCreator}
          onOpenPost={openPost}
          onScrollToggle={setIsSwipingMedia}
        />
      </MasonryCardCell>
    );
  };

  return (
    <WorkspaceSideMenuGestureLayer bottomOffset={tabBarMetrics.contentBottomPadding} enabled={!isSwipingMedia}>
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
        <FlashList
        contentInsetAdjustmentBehavior="never"
        data={isFirstLoad ? [] : cards}
        drawDistance={SHOWCASE_DRAW_DISTANCE}
        extraData={visibleActiveVideoIds}
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
        }}
        contentContainerStyle={{
          paddingTop: topInset + appTheme.spacing.screen,
          paddingHorizontal: FEED_HORIZONTAL_PADDING,
          paddingBottom: tabBarMetrics.contentBottomOverlapPadding + appTheme.spacing.section,
        }}
        ListHeaderComponent={
          <View style={{ gap: appTheme.spacing.section, paddingBottom: appTheme.spacing.section }}>
            <View style={{ gap: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <View style={{ gap: 4, flex: 1 }}>
                  <Text accessibilityRole="header" selectable style={{ color: appTheme.colors.text, ...appTheme.type.pageTitle }}>
                    Feed
                  </Text>
                  <Text selectable style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
                    {activeToolLabel ? `Creations made with ${activeToolLabel}.` : activeFilter.body}
                  </Text>
                </View>
                <IconButton
                  disabled={showcaseQuery.isFetching && !showcaseQuery.isFetchingNextPage}
                  label="Refresh feed"
                  onPress={handleRefresh}
                >
                  <RefreshCw size={19} color={appTheme.colors.text} strokeWidth={2.4} />
                </IconButton>
              </View>

              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {FEED_FILTERS.map((filter) => (
                  <FeedFilterChip
                    key={filter.id}
                    active={activeFilterId === filter.id}
                    label={filter.label}
                    onPress={() => setActiveFilterId(filter.id)}
                  />
                ))}
                {activeToolLabel ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Clear ${activeToolLabel} tool filter`}
                    onPress={clearToolFilter}
                    style={({ pressed }) => ({
                      minHeight: appTheme.touch.compact,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      borderRadius: appTheme.radii.pill,
                      borderWidth: 1,
                      borderColor: appTheme.colors.commerce,
                      backgroundColor: `${appTheme.colors.commerce}1f`,
                      opacity: pressed ? appTheme.opacity.pressed : 1,
                      paddingLeft: appTheme.spacing.gap,
                      paddingRight: 9,
                    })}
                  >
                    <Text style={{ color: appTheme.colors.text, ...appTheme.type.label }}>{activeToolLabel}</Text>
                    <X size={15} color={appTheme.colors.text} />
                  </Pressable>
                ) : null}
              </View>
            </View>
            {showcaseQuery.error ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <StatusBlock
                  tone="danger"
                  title="Could not load feed"
                  body="Check your connection, then try again."
                />
                <SecondaryButton label="Retry feed" onPress={handleRefresh} />
              </View>
            ) : null}
            {isFirstLoad ? <ShowcaseSkeletonGrid layout={gridLayout} /> : null}
          </View>
        }
        ListEmptyComponent={
          !isFirstLoad && !showcaseQuery.error && !hasItems ? (
            <StatusBlock title="No posts loaded" body={activeToolLabel
              ? `No posts made with ${activeToolLabel} matched this view.`
              : `No posts matched ${activeFilter.label.toLowerCase()} yet. Pull to refresh or switch filters.`} />
          ) : null
        }
        ListFooterComponent={!isFirstLoad && showcaseQuery.isFetchingNextPage ? <BottomLoader /> : null}
        viewabilityConfig={viewabilityConfig}
        />
      </View>
    </WorkspaceSideMenuGestureLayer>
  );
}

function formatToolLabel(slug: string) {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
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

function IconButton({
  children,
  disabled,
  label,
  onPress,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: appTheme.touch.compact,
        height: appTheme.touch.compact,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panelSoft,
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function FeedFilterChip({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.compact,
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: active ? appTheme.colors.primary : appTheme.colors.border,
        backgroundColor: active ? appTheme.colors.selected : appTheme.colors.panelSoft,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: appTheme.spacing.gap,
      })}
    >
      <Text style={{ color: active ? appTheme.colors.text : appTheme.colors.muted, ...appTheme.type.label }}>
        {label}
      </Text>
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
      <ActivityIndicator color={appTheme.colors.primary} />
    </View>
  );
}

function MasonryPin({
  card,
  layout,
  activeVideoIds,
  onOpenPost,
  onOpenCreator,
  onScrollToggle,
}: {
  card: ShowcaseMasonryCard;
  layout: ShowcaseGridLayout;
  activeVideoIds: string[];
  onOpenCreator: (item: ShowcaseFeedItem) => void;
  onOpenPost: (item: ShowcaseFeedItem) => void;
  onScrollToggle?: (scrolling: boolean) => void;
}) {
  const { width } = useWindowDimensions();
  const columnWidth = (width - FEED_HORIZONTAL_PADDING * 2 - layout.columnGap) / 2;
  const mediaHeight = getShowcaseMediaHeight(card, columnWidth);
  const accent = accentColor(card.accent);
  const isVideoCard = isShowcaseVideoPreviewCandidate(card.item);
  const showActiveVideo = isVideoCard && activeVideoIds.includes(card.id) && Boolean(card.mediaUrl);
  const creatorLabel = formatCreatorLabel(card.creatorLabel);
  const routeCardPress = (locationY: number) => {
    const inCreatorRow = locationY >= mediaHeight + CREATOR_ROW_TAP_START_OFFSET
      && locationY <= mediaHeight + CREATOR_ROW_TAP_END_OFFSET;

    if (inCreatorRow) {
      if (card.item.creator.username?.trim()) {
        onOpenCreator(card.item);
      }
      return;
    }

    onOpenPost(card.item);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${card.title}. ${card.badge}${card.unlock ? `. ${card.unlock.summary}` : ''}. ${creatorLabel}`}
      onPress={(event) => routeCardPress(event.nativeEvent.locationY)}
      style={({ pressed }) => ({
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panel,
        overflow: 'hidden',
        opacity: pressed ? 0.94 : 1,
      })}
    >
      <View
        style={{
          height: mediaHeight,
          overflow: 'hidden',
          backgroundColor: card.previewKind === 'text' ? 'transparent' : '#050506',
        }}
      >
          {card.previewKind === 'text' ? (
            <TextPinPreview
              accent={accent}
              badge={card.badge}
              height={mediaHeight}
              prompt={card.prompt}
              title={card.title}
            />
          ) : hasShowcasePreviewMedia(card.item) ? (
            <ShowcaseMediaPreview
              item={card.item}
              height={mediaHeight}
              accent={accent}
              width={columnWidth}
              radius={layout.mediaRadius}
              recyclingKey={`showcase:${card.id}`}
              videoActivation={showActiveVideo ? 'visible' : 'never'}
              onPress={() => onOpenPost(card.item)}
              onScrollToggle={onScrollToggle}
            />
          ) : (
            isVideoCard ? (
              <VideoPinPreview accent={accent} height={mediaHeight} radius={layout.mediaRadius} />
            ) : (
              <VisualFallbackPreview accent={accent} height={mediaHeight} radius={layout.mediaRadius} />
            )
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
                  paddingHorizontal: appTheme.spacing.gap,
                  paddingBottom: appTheme.spacing.gap,
                }}
              >
                <Text numberOfLines={2} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
                  {card.title}
                </Text>
              </LinearGradient>
              {isVideoCard ? <VideoCornerPlay /> : null}
            </>
          ) : null}
      </View>

      <View style={{ gap: appTheme.spacing.compact, paddingHorizontal: 10, paddingTop: 9, paddingBottom: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${creatorLabel} profile`}
            accessibilityHint="Opens this creator's profile"
            disabled={!card.item.creator.username}
            hitSlop={{ top: 4, right: 12, bottom: 4, left: 0 }}
            onPress={(event) => {
              event.stopPropagation();
              onOpenCreator(card.item);
            }}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 48,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              paddingRight: 2,
              opacity: pressed ? 0.72 : 1,
              zIndex: 2,
              elevation: 2,
            })}
          >
            <CreatorAvatar uri={card.creatorAvatar} name={creatorLabel} />
            <Text numberOfLines={1} style={{ color: appTheme.colors.muted, flex: 1, ...appTheme.type.caption, fontWeight: '800' }}>
              {creatorLabel}
            </Text>
            <ChevronRight size={15} color={appTheme.colors.faint} strokeWidth={2.5} />
          </Pressable>
          <PinStat icon={<Heart size={16} color={appTheme.colors.text} strokeWidth={2.4} />} label={card.saveLabel} />
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: appTheme.spacing.compact,
          }}
        >
          {card.unlock ? (
            <UnlockSummary unlock={card.unlock} />
          ) : (
            <Text numberOfLines={1} style={{ color: appTheme.colors.faint, flex: 1, ...appTheme.type.caption }}>
              Open post
            </Text>
          )}
          <PinStat icon={<Repeat2 size={15} color={appTheme.colors.muted} strokeWidth={2.4} />} label={card.remixLabel} muted />
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
        backgroundColor: appTheme.colors.overlay,
        paddingHorizontal: 9,
        paddingVertical: 5,
      }}
    >
      <Text numberOfLines={1} style={{ color: '#ffffff', ...appTheme.type.caption, lineHeight: 12, fontWeight: '800' }}>
        {label}
      </Text>
    </View>
  );
}

function UnlockSummary({ unlock }: { unlock: ShowcaseMasonryCard['unlock'] }) {
  if (!unlock) return null;
  const accent = accentColor(unlock.accent);

  return (
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Lock size={12} color={accent} strokeWidth={2.6} />
        <Text numberOfLines={1} style={{ color: accent, flex: 1, ...appTheme.type.caption, fontWeight: '800' }}>
          {unlock.ctaLabel}
        </Text>
      </View>
      <Text numberOfLines={1} style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>
        {unlock.summary}
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
    <View
      style={{
        height,
        borderTopLeftRadius: 21,
        borderTopRightRadius: 21,
        borderCurve: 'continuous',
        borderBottomWidth: 1,
        borderBottomColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.panelSoft,
        overflow: 'hidden',
        padding: 13,
      }}
    >
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: accent }} />
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
          <Text numberOfLines={1} style={{ color: accent, flex: 1, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', fontWeight: '800' }}>
            {badge}
          </Text>
        </View>
        <View style={{ gap: 7 }}>
          <Text numberOfLines={2} style={{ color: appTheme.colors.text, fontSize: 15, lineHeight: 18, fontWeight: '800' }}>
            {title}
          </Text>
          <Text numberOfLines={5} style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 17, fontWeight: '700' }}>
            {prompt}
          </Text>
        </View>
      </View>
    </View>
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
    <View
      style={{
        height,
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.surfaceInset,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: `${accent}1f`, borderWidth: 1, borderColor: `${accent}55` }}>
        <ImageIcon size={22} color={accent} strokeWidth={2} />
      </View>
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

function PinStat({ icon, label, muted = false }: { icon: React.ReactNode; label: string; muted?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {icon}
      <Text style={{ color: muted ? appTheme.colors.faint : appTheme.colors.muted, fontSize: muted ? 12 : 13, fontWeight: muted ? '800' : '700', fontVariant: ['tabular-nums'] }}>
        {label}
      </Text>
    </View>
  );
}
