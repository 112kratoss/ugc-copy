import { FlashList, type FlashListRef, type ListRenderItem, type ViewToken } from '@shopify/flash-list';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { ImageIcon, MoreVertical, Play, RefreshCw, Search, X } from 'lucide-react-native';
import { useIsFocused, useScrollToTop } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AccessibilityInfo, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { FeedFeedbackSheet } from '@/components/feed-feedback-sheet';
import { ExploreSearchOverlay } from '@/components/explore-search-overlay';
import { FeedMediaPlate } from '@/components/feed-media-plate';
import { FeedEndFooter, FeedLoadMoreErrorFooter } from '@/components/feed-pagination-footer';
import { TopScrim } from '@/components/top-scrim';
import { CreatorAvatar, SecondaryButton, StatusBlock } from '@/components/ui';
import {
  WorkspaceSideMenuGestureLayer,
  WorkspaceSideMenuGlyph,
  WORKSPACE_SIDE_MENU_LABEL,
  useWorkspaceSideMenu,
} from '@/components/workspace-side-menu-gesture-layer';
import { useAuth } from '@/lib/auth';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
import { showcaseFeedItemOpenHref } from '@/lib/immersive-preview-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { useTabBarAmbientFeed } from '@/lib/tab-bar-ambient';
import { createSerializedImageLoader } from '@/lib/serialized-image-loader';
import { isShowcaseCoverVideoStreaming, isShowcaseVideoPreviewCandidate } from '@/lib/showcase-display';
import {
  INITIAL_SHOWCASE_ACTIVATION_STATE,
  SHOWCASE_SETTLE_CONFIRM_MS,
  getVisibleCardItems,
  reduceShowcaseActivation,
  type ShowcaseActivationEvent,
} from '@/lib/showcase-feed-activation';
import {
  SHOWCASE_FEED_STALE_TIME_MS,
  createShowcaseFeedQueryKey,
  createShowcaseFeedViewerQueryKey,
  createShowcasePostQueryKey,
  flattenShowcaseFeedPages,
  getNextShowcaseFeedPageParam,
  getShowcaseFeedPageParams,
  getShowcaseFeedSessionContext,
  normalizeShowcaseToolFilter,
  resolveMobileShowcaseFeedFilterId,
  type MobileShowcaseFeedFilterId,
  type ShowcaseFeedFilters,
  type ShowcaseFeedPageParam,
} from '@/lib/showcase-feed-query';
import {
  SHOWCASE_ONSCREEN_VIEWABILITY,
  SHOWCASE_PLAYBACK_VIEWABILITY,
  SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY,
  buildShowcaseFeedEventRequest,
  canRecordShowcaseFeedEvent,
  filterAnonymousSessionShowcaseFeedItems,
  forgetAnonymousShowcaseFeedRemoval,
  getQualifiedImpressionKey,
  rememberAnonymousShowcaseFeedRemoval,
  removeShowcaseFeedItemsFromInfiniteData,
  type ShowcaseFeedEventDetails,
} from '@/lib/showcase-feed-events';
import {
  enqueueShowcaseFeedEvent,
  flushShowcaseFeedEvents,
  isBatchedShowcaseFeedEventType,
} from '@/lib/feed-event-queue';
import {
  buildShowcaseMasonry,
  getShowcaseGridLayout,
  getShowcaseMediaHeight,
  mergeAspectRatios,
  partitionAspectRatioUpdates,
  type ShowcaseGridLayout,
  type ShowcaseMasonryCard,
} from '@/lib/showcase-feed-view-model';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { SHOWCASE_DRAW_DISTANCE, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS } from '@/lib/media-performance';
import { getShowcasePreviewMediaItems, hasShowcasePreviewMedia } from '@/lib/showcase-media';
import { Reveal } from '@/components/reveal';
import { SkeletonBone } from '@/components/skeleton';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { MotionView, usePressMotion, useReducedMotion } from '@/lib/motion';
import { accentColor, appTheme } from '@/lib/theme';
import type { ShowcaseFeedEventType, ShowcaseFeedItem, ShowcaseFeedResponse, ShowcasePostResponse } from '@/lib/types';

type FeedFilterId = MobileShowcaseFeedFilterId;

const FEED_FILTERS: Array<{
  id: FeedFilterId;
  label: string;
  params: ShowcaseFeedFilters;
}> = [
  {
    id: 'all',
    label: 'All',
    params: {},
  },
  {
    id: 'unlocks',
    label: 'Unlocks',
    params: { unlock: 'with-unlock' },
  },
  {
    id: 'free',
    label: 'Free',
    params: { unlock: 'free' },
  },
  {
    id: 'paid',
    label: 'Paid',
    params: { unlock: 'paid' },
  },
  {
    id: 'remixable',
    label: 'Remixable',
    params: { resource: 'remix' },
  },
];

const SKELETON_HEIGHTS = [
  [196, 230, 244],
  [230, 260, 196],
];
const LOAD_MORE_COOLDOWN_MS = 800;
const FEED_HORIZONTAL_PADDING = 8;
/** One relayout per tick instead of one per resolved preview image. */
const SHOWCASE_ASPECT_RATIO_FLUSH_MS = 50;
/** Stable empty list so a blurred feed does not churn `extraData`. */
const NO_ACTIVE_VIDEO_IDS: string[] = [];

// One loader for the process: the first measurement anywhere warms expo-image's
// native loader alone, and every later burst from this grid queues behind it.
const measureShowcaseImage = createSerializedImageLoader(
  (url: string, options: { maxWidth: number; maxHeight: number }) => Image.loadAsync(url, options)
);

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
  const feedRef = useRef<FlashListRef<ShowcaseMasonryCard>>(null);
  useScrollToTop(feedRef);
  const routeFilterId = resolveMobileShowcaseFeedFilterId(routeParams.filter);
  const routeTool = normalizeShowcaseToolFilter(routeParams.tool);
  const [activeFilterId, setActiveFilterId] = useState<FeedFilterId>(routeFilterId);
  const [activeTool, setActiveTool] = useState<string | null>(routeTool);
  const activeFilter = FEED_FILTERS.find((filter) => filter.id === activeFilterId) ?? FEED_FILTERS[0];
  const queryFilters = useMemo<ShowcaseFeedFilters>(() => ({
    ...activeFilter.params,
    ...(activeTool ? { tool: activeTool } : {}),
  }), [activeFilter, activeTool]);
  const queryKey = useMemo(
    () => createShowcaseFeedQueryKey(queryFilters, user?.id),
    [queryFilters, user?.id]
  );
  const viewerFeedQueryKey = useMemo(
    () => createShowcaseFeedViewerQueryKey(user?.id),
    [user?.id]
  );
  const activeToolLabel = useMemo(() => activeTool ? formatToolLabel(activeTool) : null, [activeTool]);
  const [activeVideoIds, setActiveVideoIds] = useState<string[]>([]);
  const [resolvedAspectRatios, setResolvedAspectRatios] = useState<Record<string, number>>({});
  // A fresh `[]` here would defeat the extraData memo on every blurred render.
  const visibleActiveVideoIds = isFocused ? activeVideoIds : NO_ACTIVE_VIDEO_IDS;
  const [isSwipingMedia, setIsSwipingMedia] = useState(false);
  const [feedbackItem, setFeedbackItem] = useState<ShowcaseFeedItem | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMorePageCountRef = useRef<number | null>(null);
  const aspectRatioRequestsRef = useRef(new Set<string>());
  // Which cards have any pixel on screen, and the ratios waiting for them to
  // leave. See `partitionAspectRatioUpdates` for why a measurement cannot be
  // applied to a card the reader is looking at.
  const onScreenCardIdsRef = useRef<Set<string>>(new Set());
  const heldAspectRatiosRef = useRef<Record<string, number>>({});
  // One lock, many carousels: the feed stops scrolling vertically while any
  // card's media is being swiped sideways, so it counts holders rather than
  // trusting the last report to be the right one.
  const mediaDragCountRef = useRef(0);
  const handleMediaScrollToggle = useCallback((scrolling: boolean) => {
    mediaDragCountRef.current = Math.max(0, mediaDragCountRef.current + (scrolling ? 1 : -1));
    setIsSwipingMedia(mediaDragCountRef.current > 0);
  }, []);
  // Scroll phase lives in a ref: these handlers fire continuously, and only a
  // committed election needs to reach React.
  const activationRef = useRef(INITIAL_SHOWCASE_ACTIVATION_STATE);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAspectRatiosRef = useRef<Record<string, number>>({});
  const aspectRatioFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qualifiedImpressionsRef = useRef(new Set<string>());
  const feedEventRuntimeRef = useRef({
    api,
    isFocused,
    feedSessionId: null as string | null,
    algorithmVersion: null as string | null,
  });
  const recordFeedEvent = useCallback((
    item: ShowcaseFeedItem,
    eventType: ShowcaseFeedEventType,
    details: ShowcaseFeedEventDetails = {}
  ) => {
    if (!canRecordShowcaseFeedEvent({
      postId: item.id,
      recommendation: item.recommendation,
    }, eventType)) return;
    const runtime = feedEventRuntimeRef.current;
    const request = buildShowcaseFeedEventRequest({
      postId: item.id,
      recommendation: item.recommendation,
    }, eventType, {
      feedSessionId: runtime.feedSessionId,
      algorithmVersion: item.recommendation?.algorithmVersion ?? runtime.algorithmVersion,
      sourceSurface: 'showcase',
    }, details);
    if (isBatchedShowcaseFeedEventType(eventType)) {
      void enqueueShowcaseFeedEvent(request);
    } else {
      void runtime.api.recordShowcaseFeedEvent(request).catch(() => null);
    }
  }, []);
  useEffect(() => {
    if (!isFocused) void flushShowcaseFeedEvents();
  }, [isFocused]);
  const dispatchActivation = useCallback((event: ShowcaseActivationEvent) => {
    const previous = activationRef.current;
    const next = reduceShowcaseActivation(previous, event, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS);
    activationRef.current = next;

    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    // A fling whose momentum the platform never announces would otherwise sit
    // in `settling` forever, so arm a confirm timer whenever we enter it.
    if (next.scroll === 'settling') {
      settleTimerRef.current = setTimeout(
        () => dispatchActivation({ type: 'settleTimeout' }),
        SHOWCASE_SETTLE_CONFIRM_MS
      );
    }

    // `elect` reuses the previous array when nothing changed, so this is a
    // pointer comparison rather than a re-render on every scroll event.
    if (next.activeIds !== previous.activeIds) setActiveVideoIds(next.activeIds);
  }, []);

  useEffect(() => () => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    if (aspectRatioFlushRef.current) clearTimeout(aspectRatioFlushRef.current);
  }, []);

  /**
   * Coalesces resolved preview ratios into one state write per tick.
   *
   * Each ratio changes a card's masonry height, so writing them one at a time
   * produced a relayout per image — cards visibly jumping as you scrolled into
   * them, on top of a full-list re-render each time via extraData.
   */
  const applyAspectRatios = useCallback((updates: Record<string, number>) => {
    const { apply, hold } = partitionAspectRatioUpdates(updates, onScreenCardIdsRef.current);
    if (Object.keys(hold).length) {
      heldAspectRatiosRef.current = { ...heldAspectRatiosRef.current, ...hold };
    }
    if (!Object.keys(apply).length) return;
    setResolvedAspectRatios((current) => mergeAspectRatios(current, apply));
  }, []);

  /** Lets go of every held ratio whose card has since left the screen. */
  const releaseHeldAspectRatios = useCallback(() => {
    const held = heldAspectRatiosRef.current;
    if (!Object.keys(held).length) return;

    const { apply, hold } = partitionAspectRatioUpdates(held, onScreenCardIdsRef.current);
    heldAspectRatiosRef.current = hold;
    if (!Object.keys(apply).length) return;
    setResolvedAspectRatios((current) => mergeAspectRatios(current, apply));
  }, []);

  const queueAspectRatio = useCallback((cardId: string, aspectRatio: number) => {
    pendingAspectRatiosRef.current[cardId] = aspectRatio;
    if (aspectRatioFlushRef.current) return;

    aspectRatioFlushRef.current = setTimeout(() => {
      aspectRatioFlushRef.current = null;
      const pending = pendingAspectRatiosRef.current;
      pendingAspectRatiosRef.current = {};
      applyAspectRatios(pending);
    }, SHOWCASE_ASPECT_RATIO_FLUSH_MS);
  }, [applyAspectRatios]);

  // Tints the dock from the card nearest it, and hands the neutral dock back on
  // blur so a tab with no media of its own inherits it.
  const reportAmbientMedia = useTabBarAmbientFeed(isFocused);

  const onPlaybackViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<ShowcaseMasonryCard>> }) => {
    reportAmbientMedia({ viewableItems });
    dispatchActivation({ type: 'viewableItemsChanged', items: getVisibleCardItems(viewableItems) });
  }, [dispatchActivation, reportAmbientMedia]);
  const onQualifiedViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<ShowcaseMasonryCard>> }) => {
    if (!feedEventRuntimeRef.current.isFocused) return;
    for (const token of viewableItems) {
      if (!token.isViewable || !token.item) continue;
      const item = token.item.item;
      const key = getQualifiedImpressionKey({
        postId: item.id,
        recommendation: item.recommendation,
      }, feedEventRuntimeRef.current.feedSessionId);
      if (qualifiedImpressionsRef.current.has(key)) continue;
      qualifiedImpressionsRef.current.add(key);
      recordFeedEvent(item, 'impression', {
        durationMs: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime,
        ...(typeof item.recommendation?.position !== 'number' && typeof token.index === 'number'
          ? { position: token.index }
          : {}),
        metadata: {
          visiblePercentThreshold: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.itemVisiblePercentThreshold,
          qualification: 'viewability',
        },
      });
    }
  }, [recordFeedEvent]);
  const onScreenViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<ShowcaseMasonryCard>> }) => {
    const onScreen = new Set<string>();
    for (const token of viewableItems) {
      if (!token.isViewable || !token.item) continue;
      onScreen.add(token.item.id);
    }
    onScreenCardIdsRef.current = onScreen;
    releaseHeldAspectRatios();
  }, [releaseHeldAspectRatios]);
  const viewabilityConfigCallbackPairs = useRef([
    {
      viewabilityConfig: SHOWCASE_ONSCREEN_VIEWABILITY,
      onViewableItemsChanged: onScreenViewableItemsChanged,
    },
    {
      viewabilityConfig: SHOWCASE_PLAYBACK_VIEWABILITY,
      onViewableItemsChanged: onPlaybackViewableItemsChanged,
    },
    {
      viewabilityConfig: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY,
      onViewableItemsChanged: onQualifiedViewableItemsChanged,
    },
  ]).current;
  const showcaseQuery = useInfiniteQuery({
    queryKey,
    initialPageParam: { offset: 0 } as ShowcaseFeedPageParam,
    queryFn: ({ pageParam }) => api.getShowcaseFeed(getShowcaseFeedPageParams({
      ...queryFilters,
      ...pageParam,
    })),
    getNextPageParam: getNextShowcaseFeedPageParam,
    staleTime: SHOWCASE_FEED_STALE_TIME_MS,
  });
  const feedSession = useMemo(
    () => getShowcaseFeedSessionContext(showcaseQuery.data?.pages),
    [showcaseQuery.data?.pages]
  );
  feedEventRuntimeRef.current = {
    api,
    isFocused,
    feedSessionId: feedSession.feedSessionId,
    algorithmVersion: feedSession.algorithmVersion,
  };
  const showcaseItems = useMemo(() => {
    const flattened = flattenShowcaseFeedPages(showcaseQuery.data?.pages);
    // `buildShowcaseMasonry` drops text-only posts; this list stays unfiltered so
    // empty-state and pagination decisions still see everything the feed ranked.
    return user ? flattened : filterAnonymousSessionShowcaseFeedItems(flattened);
  }, [showcaseQuery.data?.pages, user]);
  const cards = useMemo(() => buildShowcaseMasonry(showcaseItems), [showcaseItems]);
  const showcasePageCount = showcaseQuery.data?.pages.length ?? 0;
  // Keyed off the rendered cards, not the ranked items: a page that is entirely
  // text posts renders nothing, and that has to read as empty, not as loaded.
  const hasItems = cards.length > 0;
  const isFirstLoad = showcaseQuery.isLoading && !hasItems;
  const isRefreshing = showcaseQuery.isRefetching && !showcaseQuery.isFetchingNextPage;
  // The spinner tracks the viewer's own pull only. See the home feed's note:
  // on iOS a programmatic `refreshing` shifts the scroll view down and does not
  // put it back unless the list is at the top, so a background refetch — a save
  // used to fire one — walks the feed downward a notch at a time.
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const endMessage = activeToolLabel
    ? `You've reached the end of ${activeToolLabel}.`
    : activeFilterId === 'all'
      ? "You're all caught up."
      : `You've reached the end of ${activeFilter.label}.`;

  useEffect(() => {
    if (typeof Image.loadAsync !== 'function') return;

    for (const card of cards) {
      // `pendingAspectRatios` covers the window between a resolved ratio and
      // its batched flush, where `resolvedAspectRatios` does not know yet.
      if (card.aspectRatio || !card.previewUrl
        || resolvedAspectRatios[card.id] || pendingAspectRatiosRef.current[card.id]) {
        continue;
      }
      const requestKey = `${card.id}:${card.previewUrl}`;
      if (aspectRatioRequestsRef.current.has(requestKey)) continue;
      aspectRatioRequestsRef.current.add(requestKey);

      void measureShowcaseImage(card.previewUrl, { maxWidth: 96, maxHeight: 96 })
        .then((image) => {
          const aspectRatio = image.width / image.height;
          if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
          queueAspectRatio(card.id, aspectRatio);
        })
        .catch(() => null)
        .finally(() => {
          aspectRatioRequestsRef.current.delete(requestKey);
        });
    }
  }, [cards, resolvedAspectRatios]);

  useEffect(() => {
    setActiveFilterId((current) => current === routeFilterId ? current : routeFilterId);
  }, [routeFilterId]);

  useEffect(() => {
    setActiveTool((current) => current === routeTool ? current : routeTool);
  }, [routeTool]);

  useEffect(() => {
    dispatchActivation({ type: 'reset' });
    setActiveVideoIds([]);
    setFeedbackItem(null);
    // Every carousel is about to unmount; their releases would land after the
    // new list has already opened locks of its own.
    mediaDragCountRef.current = 0;
    setIsSwipingMedia(false);
    heldAspectRatiosRef.current = {};
    qualifiedImpressionsRef.current.clear();
    loadingMoreRef.current = false;
    lastLoadMoreAtRef.current = 0;
    lastLoadMorePageCountRef.current = null;
  }, [activeFilterId, activeTool]);

  const clearToolFilter = () => {
    setActiveTool(null);
    router.setParams({ tool: undefined } as never);
  };

  const requestNextPage = () => {
    const now = Date.now();
    if (!canRequestNextFeedPage({
      cooldownMs: LOAD_MORE_COOLDOWN_MS,
      hasNextPage: showcaseQuery.hasNextPage,
      isBusy: showcaseQuery.isFetching,
      isRequestInFlight: loadingMoreRef.current,
      lastRequestedAt: lastLoadMoreAtRef.current,
      lastRequestedPageCount: lastLoadMorePageCountRef.current,
      now,
      pageCount: showcasePageCount,
    })) return;

    loadingMoreRef.current = true;
    lastLoadMoreAtRef.current = now;
    lastLoadMorePageCountRef.current = showcasePageCount;
    void showcaseQuery.fetchNextPage().finally(() => {
      loadingMoreRef.current = false;
    });
  };

  const retryNextPage = () => {
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    requestNextPage();
  };

  const handleRefresh = () => {
    haptic.light();
    setPullRefreshing(true);
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(queryKey, (current) => {
      if (!current?.pages.length) return current;
      return {
        pages: current.pages.slice(0, 1),
        pageParams: current.pageParams.slice(0, 1),
      };
    });
    void showcaseQuery.refetch().finally(() => setPullRefreshing(false));
  };

  const openPost = (item: ShowcaseFeedItem) => {
    haptic.light();
    recordFeedEvent(item, 'open');
    queryClient.setQueryData<ShowcasePostResponse>(createShowcasePostQueryKey(item.id, user?.id), {
      success: true,
      item,
    });
    router.push(showcaseFeedItemOpenHref({
      item,
      source: 'showcase-feed',
      feedSessionId: feedSession.feedSessionId,
      algorithmVersion: item.recommendation?.algorithmVersion ?? feedSession.algorithmVersion,
    }) as never);
  };

  const applyFeedFeedback = (eventType: 'not_interested' | 'hide_creator') => {
    const item = feedbackItem;
    if (!item) return;
    if (eventType === 'hide_creator' && (!item.creator.id || item.creator.id === user?.id)) {
      return;
    }
    const target = eventType === 'hide_creator'
      ? { creatorId: item.creator.id }
      : { postId: item.id };
    const cachedFeeds = queryClient.getQueriesData<InfiniteData<ShowcaseFeedResponse>>({
      queryKey: viewerFeedQueryKey,
    });

    if (!user) rememberAnonymousShowcaseFeedRemoval(target);

    setFeedbackItem(null);
    queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
      { queryKey: viewerFeedQueryKey },
      (current) => removeShowcaseFeedItemsFromInfiniteData(current, target)
    );
    const runtime = feedEventRuntimeRef.current;
    const request = buildShowcaseFeedEventRequest({
      postId: item.id,
      recommendation: item.recommendation,
    }, eventType, {
      feedSessionId: runtime.feedSessionId,
      algorithmVersion: item.recommendation?.algorithmVersion ?? runtime.algorithmVersion,
      sourceSurface: 'showcase',
    });

    void runtime.api.recordShowcaseFeedEvent(request)
      .then(() => AccessibilityInfo.announceForAccessibility(eventType === 'hide_creator'
        ? user
          ? `${formatCreatorLabel(item.creator.username || item.creator.name)} hidden from your Showcase.`
          : `${formatCreatorLabel(item.creator.username || item.creator.name)} hidden for this visit.`
        : user
          ? 'Post removed. Your Showcase will adapt.'
          : 'Post removed for this visit.'))
      .catch(() => {
        if (!user) forgetAnonymousShowcaseFeedRemoval(target);
        cachedFeeds.forEach(([cachedQueryKey, cachedData]) => {
          queryClient.setQueryData(cachedQueryKey, cachedData);
        });
        showMessageDialog({
          title: 'Couldn’t update your Showcase',
          message: 'The post was restored. Check your connection and try again.',
        });
        void AccessibilityInfo.announceForAccessibility(
          'Couldn’t update your Showcase. The post was restored.'
        );
      });
  };

  const requireModerationSignIn = () => {
    if (user) return true;
    setFeedbackItem(null);
    router.push({
      pathname: '/auth',
      params: { returnTo: '/(tabs)/showcase' },
    } as never);
    return false;
  };

  const reportFeedbackContent = () => {
    const item = feedbackItem;
    if (!item || !requireModerationSignIn()) return;
    setFeedbackItem(null);
    void showConfirmDialog({
      title: 'Report content?',
      message: 'Magicbooklet will send this post to the moderation team for a safety review.',
      confirmLabel: 'Report content',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await api.reportPost(item.id, {
          reason: 'unsafe_content',
          details: 'Reported from the mobile Showcase.',
        });
        queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
          { queryKey: viewerFeedQueryKey },
          (current) => removeShowcaseFeedItemsFromInfiniteData(current, { postId: item.id })
        );
        void AccessibilityInfo.announceForAccessibility('Content reported and removed from your Showcase.');
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not report content', error);
      }
    });
  };

  const reportFeedbackUser = () => {
    const item = feedbackItem;
    if (!item?.creator.id || item.creator.id === user?.id || !requireModerationSignIn()) return;
    setFeedbackItem(null);
    void showConfirmDialog({
      title: 'Report user?',
      message: `Magicbooklet will review ${formatCreatorLabel(item.creator.username || item.creator.name)} for unsafe or abusive behavior.`,
      confirmLabel: 'Report user',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await api.reportUser(item.creator.id!, {
          reason: 'unsafe_content',
          sourceSurface: 'showcase',
          details: `Reported from post ${item.id}.`,
        });
        void AccessibilityInfo.announceForAccessibility('User reported to the moderation team.');
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not report user', error);
      }
    });
  };

  const blockFeedbackUser = () => {
    const item = feedbackItem;
    if (!item?.creator.id || item.creator.id === user?.id || !requireModerationSignIn()) return;
    setFeedbackItem(null);
    const creatorId = item.creator.id;
    const creatorLabel = formatCreatorLabel(item.creator.username || item.creator.name);
    void showConfirmDialog({
      title: `Block ${creatorLabel}?`,
      message: 'Their posts will be hidden, and neither of you will be able to follow the other.',
      confirmLabel: 'Block user',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await api.blockUser(creatorId);
        queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
          { queryKey: viewerFeedQueryKey },
          (current) => removeShowcaseFeedItemsFromInfiniteData(current, { creatorId })
        );
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['creator-profile'] }),
          queryClient.invalidateQueries({ queryKey: ['profile-saved-media', user?.id] }),
        ]);
        void AccessibilityInfo.announceForAccessibility(`${creatorLabel} blocked.`);
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not block user', error);
      }
    });
  };

  const openCreator = (item: ShowcaseFeedItem) => {
    const username = item.creator.username?.trim();
    if (!username) return;
    router.push(`/creators/${encodeURIComponent(username)}` as never);
  };

  // Memoized: an inline literal here changes identity on every parent render,
  // which makes FlashList re-render every mounted cell instead of only when
  // activation or a resolved ratio actually changed.
  const feedExtraData = useMemo(
    () => ({ visibleActiveVideoIds, resolvedAspectRatios }),
    [visibleActiveVideoIds, resolvedAspectRatios]
  );

  const renderCard: ListRenderItem<ShowcaseMasonryCard> = ({ item, target, index }) => {
    return (
      <MasonryCardCell layout={gridLayout} index={index}>
        <MasonryPin
          card={item}
          layout={gridLayout}
          activeVideoIds={target === 'Cell' ? visibleActiveVideoIds : []}
          resolvedAspectRatio={resolvedAspectRatios[item.id]}
          onOpenCreator={openCreator}
          onFeedbackOpen={setFeedbackItem}
          onOpenPost={openPost}
          onScrollToggle={handleMediaScrollToggle}
        />
      </MasonryCardCell>
    );
  };

  return (
    <WorkspaceSideMenuGestureLayer bottomOffset={tabBarMetrics.contentBottomPadding} enabled={!isSwipingMedia}>
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
        <FlashList
        ref={feedRef}
        contentInsetAdjustmentBehavior="never"
        data={isFirstLoad ? [] : cards}
        drawDistance={SHOWCASE_DRAW_DISTANCE}
        extraData={feedExtraData}
        onScrollBeginDrag={() => dispatchActivation({ type: 'dragBegin' })}
        onScrollEndDrag={(event) => dispatchActivation({
          type: 'dragEnd',
          velocityY: event.nativeEvent.velocity?.y,
        })}
        onMomentumScrollBegin={() => dispatchActivation({ type: 'momentumBegin' })}
        onMomentumScrollEnd={() => dispatchActivation({ type: 'momentumEnd' })}
        getItemType={(item) => item.mediaKind ?? item.item.category}
        keyExtractor={(item) => item.id}
        masonry
        numColumns={2}
        // Keep the ranked data array intact, but allow visual column placement
        // to diverge from strict alternation so variable-height cards stay balanced.
        optimizeItemArrangement={true}
        onEndReached={requestNextPage}
        // Pending-preview posts now keep their place in the masonry feed, so a
        // half-screen runway is enough to hide the next-page round trip without
        // prefetching as aggressively as the temporary filtered-feed tuning.
        onEndReachedThreshold={0.5}
        onRefresh={handleRefresh}
        refreshing={pullRefreshing}
        renderItem={renderCard}
        scrollEnabled={!isSwipingMedia}
        showsVerticalScrollIndicator={false}
        style={{
          flex: 1,
          backgroundColor: appTheme.colors.background,
        }}
        contentContainerStyle={{
          paddingTop: topInset + 12,
          paddingHorizontal: FEED_HORIZONTAL_PADDING,
          paddingBottom: tabBarMetrics.contentBottomOverlapPadding + appTheme.spacing.section,
        }}
        ListHeaderComponent={
          <View style={{ gap: 14, paddingBottom: 16 }}>
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                {/* The edge swipe used to be the only way into the workspace
                    menu from here, which Gestures forbids — a shortcut gesture
                    supplements a control, it never replaces one. */}
                <WorkspaceMenuButton />
                <Text accessibilityRole="header" selectable style={{ flex: 1, color: appTheme.colors.text, ...appTheme.type.pageTitle }}>
                  Showcase
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <IconButton label="Search creators, posts, and recipes" onPress={() => setSearchVisible(true)}>
                    <Search size={appTheme.icon.default} color={appTheme.colors.text} />
                  </IconButton>
                  <IconButton
                    disabled={showcaseQuery.isFetching && !showcaseQuery.isFetchingNextPage}
                    label="Refresh Showcase"
                    onPress={handleRefresh}
                  >
                    <RefreshCw size={appTheme.icon.default} color={appTheme.colors.text} />
                  </IconButton>
                </View>
              </View>

              <ScrollView
                horizontal
                contentContainerStyle={{ alignItems: 'center', gap: 6, paddingRight: 10 }}
                showsHorizontalScrollIndicator={false}
              >
                {FEED_FILTERS.map((filter) => (
                  <FeedFilterTab
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
                      gap: 5,
                      borderRadius: appTheme.radii.pill,
                      backgroundColor: `${appTheme.colors.commerce}1f`,
                      opacity: pressed ? appTheme.opacity.pressed : 1,
                      paddingLeft: 11,
                      paddingRight: 9,
                    })}
                  >
                    <Text style={{ color: appTheme.colors.text, ...appTheme.type.label }}>{activeToolLabel}</Text>
                    <X size={14} color={appTheme.colors.text} />
                  </Pressable>
                ) : null}
              </ScrollView>
            </View>
            {showcaseQuery.error && !hasItems ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <StatusBlock
                  tone="danger"
                  title="Could not load Showcase"
                  body={showcaseFeedErrorBody(showcaseQuery.error)}
                />
                <SecondaryButton label="Retry Showcase" onPress={handleRefresh} />
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
        ListFooterComponent={
          isFirstLoad ? null
            : showcaseQuery.isFetchingNextPage ? <BottomLoader />
              : showcaseQuery.isFetchNextPageError ? <FeedLoadMoreErrorFooter onRetry={retryNextPage} />
                : hasItems && !isRefreshing && showcaseQuery.hasNextPage === false ? (
                  <FeedEndFooter message={endMessage} />
                ) : null
        }
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        />

        <TopScrim topInset={topInset} />

        <ExploreSearchOverlay api={api} visible={searchVisible} onClose={() => setSearchVisible(false)} />

        <FeedFeedbackSheet
          creatorLabel={feedbackItem ? formatCreatorLabel(feedbackItem.creator.username || feedbackItem.creator.name) : '@creator'}
          hideCreatorDisabled={Boolean(
            feedbackItem && (!feedbackItem.creator.id || feedbackItem.creator.id === user?.id)
          )}
          onClose={() => setFeedbackItem(null)}
          onHideCreator={() => applyFeedFeedback('hide_creator')}
          onNotInterested={() => applyFeedFeedback('not_interested')}
          onBlockUser={feedbackItem?.creator.id ? blockFeedbackUser : undefined}
          onReportContent={reportFeedbackContent}
          onReportUser={feedbackItem?.creator.id ? reportFeedbackUser : undefined}
          postTitle={feedbackItem?.title || feedbackItem?.prompt || 'This post'}
          sessionOnly={!user}
          visible={Boolean(feedbackItem)}
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

function showcaseFeedErrorBody(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'Check your connection, then try again.';
}

// The first two rows of pins rise into place as the feed lands; later cells
// mount plain while scrolling.
const SHOWCASE_REVEAL_COUNT = 6;

function MasonryCardCell({ children, layout, index = 0 }: { children: React.ReactNode; layout: ShowcaseGridLayout; index?: number }) {
  return (
    <Reveal index={index} enabled={index < SHOWCASE_REVEAL_COUNT} style={{ paddingHorizontal: layout.columnGap / 2, paddingBottom: layout.pinGap }}>
      {children}
    </Reveal>
  );
}

function WorkspaceMenuButton() {
  const sideMenu = useWorkspaceSideMenu();
  if (!sideMenu) return null;

  return (
    <IconButton label={WORKSPACE_SIDE_MENU_LABEL} onPress={sideMenu.open}>
      <WorkspaceSideMenuGlyph size={appTheme.icon.default} color={appTheme.colors.text} />
    </IconButton>
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
        backgroundColor: pressed ? appTheme.colors.surfaceStrong : 'transparent',
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function FeedFilterTab({
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
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 10,
        borderBottomWidth: 2,
        borderBottomColor: active ? appTheme.colors.primary : 'transparent',
      })}
    >
      <Text style={{
        color: active ? appTheme.colors.text : appTheme.colors.muted,
        ...appTheme.type.label,
        fontWeight: active ? '800' : '700',
      }}>
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
      <SkeletonBone width="100%" height={height} radius={layout.mediaRadius} />
      <View style={{ paddingHorizontal: 2, paddingBottom: 2 }}>
        <View style={{ minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <SkeletonBone width={24} height={24} radius={12} strong />
          <SkeletonBone width="55%" height={13} radius={4} />
          <View style={{ flex: 1 }} />
          <SkeletonBone width={24} height={24} radius={12} />
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
  resolvedAspectRatio,
  onFeedbackOpen,
  onOpenPost,
  onOpenCreator,
  onScrollToggle,
}: {
  card: ShowcaseMasonryCard;
  layout: ShowcaseGridLayout;
  activeVideoIds: string[];
  resolvedAspectRatio?: number;
  onFeedbackOpen: (item: ShowcaseFeedItem) => void;
  onOpenCreator: (item: ShowcaseFeedItem) => void;
  onOpenPost: (item: ShowcaseFeedItem) => void;
  onScrollToggle?: (scrolling: boolean) => void;
}) {
  const { width } = useWindowDimensions();
  const columnWidth = (width - FEED_HORIZONTAL_PADDING * 2 - layout.columnGap) / 2;
  const mediaHeight = getShowcaseMediaHeight(card, columnWidth, resolvedAspectRatio);
  const accent = accentColor(card.accent);
  const isVideoCard = isShowcaseVideoPreviewCandidate(card.item);
  const showActiveVideo = isVideoCard && activeVideoIds.includes(card.id) && Boolean(card.mediaUrl);
  // Reduce Motion turns every preview back into a poster without changing the
  // election, so the badge asks the same question the tile does.
  const reducedMotion = useReducedMotion();
  const coverVideoStreaming = isShowcaseCoverVideoStreaming(card.item, showActiveVideo && !reducedMotion);
  const creatorLabel = formatCreatorLabel(card.creatorLabel);
  const signal = card.unlock;
  const pressMotion = usePressMotion(false, { scale: appTheme.motion.scale.pressed });

  return (
    <View style={{ gap: 5 }}>
      <MotionView style={pressMotion.animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${card.title}. ${card.badge}${signal ? `. ${signal.summary}` : ''}. ${creatorLabel}`}
        accessibilityHint="Opens this post in the full-screen viewer"
        onPress={() => onOpenPost(card.item)}
        onPressIn={pressMotion.onPressIn}
        onPressOut={pressMotion.onPressOut}
        style={{
          height: mediaHeight,
          borderRadius: layout.mediaRadius,
          borderCurve: 'continuous',
          overflow: 'hidden',
          backgroundColor: '#050506',
        }}
      >
        {hasShowcasePreviewMedia(card.item) ? (
          <ShowcaseMediaPreview
            mediaItems={getShowcasePreviewMediaItems(card.item)}
            height={mediaHeight}
            accent={accent}
            width={columnWidth}
            radius={layout.mediaRadius}
            recyclingKey={`showcase:${card.id}`}
            videoActivation={showActiveVideo ? 'visible' : 'never'}
            videoBackdrop="none"
            videoContentFit="cover"
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
        {signal ? <PinBadge label={signal.label} accent={accentColor(signal.accent)} /> : null}
        {isVideoCard && !coverVideoStreaming ? <VideoCornerPlay /> : null}
      </Pressable>
      </MotionView>

      <View style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 2 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${creatorLabel} profile`}
          accessibilityHint="Opens this creator's profile"
          disabled={!card.item.creator.username}
          hitSlop={{ top: 4, right: 8, bottom: 4, left: 0 }}
          onPress={() => onOpenCreator(card.item)}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: 40,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <CreatorAvatar uri={card.creatorAvatar} name={creatorLabel} />
          <Text numberOfLines={1} style={{ color: appTheme.colors.muted, flex: 1, ...appTheme.type.caption, fontWeight: '700' }}>
            {creatorLabel}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Showcase controls for ${card.title}`}
          accessibilityHint="Hide this post or this creator from recommendations"
          hitSlop={4}
          onPress={() => onFeedbackOpen(card.item)}
          style={({ pressed }) => ({
            width: 40,
            height: 40,
            marginRight: -7,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: appTheme.radii.pill,
            backgroundColor: pressed ? appTheme.colors.surfaceStrong : 'transparent',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <MoreVertical size={18} color={appTheme.colors.muted} />
        </Pressable>
      </View>
    </View>
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
        backgroundColor: 'rgba(5,5,7,0.78)',
        paddingHorizontal: 9,
        // The caption ramp's own line box is 17pt; the padding is what keeps the
        // pill the height it has always been rather than an override on the type.
        paddingVertical: 3,
      }}
    >
      <Text numberOfLines={1} style={{ color: accent, ...appTheme.type.caption, fontWeight: '800' }}>
        {label}
      </Text>
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
      <Play size={16} color="#ffffff" fill="#ffffff" />
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
      <FeedMediaPlate accent={accent} glyph={ImageIcon} />
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
      <FeedMediaPlate accent={accent} glyph={Play} filled />
    </View>
  );
}
