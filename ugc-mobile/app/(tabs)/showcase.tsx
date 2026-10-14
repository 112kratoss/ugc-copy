import { FlashList, type FlashListRef, type ListRenderItem, type ViewToken } from '@shopify/flash-list';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ImageIcon, MoreVertical, Play, RefreshCw, Search, X } from 'lucide-react-native';
import { useIsFocused, useScrollToTop } from '@react-navigation/native';
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AccessibilityInfo,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { MediaZoomSourceView, MediaZoomSurface, useMediaZoomSource } from '@/components/media-zoom';
import { showcaseMediaZoomPreview } from '@/lib/media-zoom-transition';
import { FeedFeedbackSheet } from '@/components/feed-feedback-sheet';
import { FeedUndoNotice, type FeedUndoNoticeModel } from '@/components/feed-undo-notice';
import { NativeMenu } from '@/components/native-menu';
import { NewPostsPill } from '@/components/new-posts-pill';
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
import { useAutoplayPreviewsEnabled } from '@/lib/autoplay-preference';
import { setCachedCreatorProfileBlocked } from '@/lib/creator-profile-view-model';
import { createFeedVideoActivationStore, FeedVideoActivationContext, useFeedVideoActivation } from '@/lib/feed-video-activation';
import { buildFeedFeedbackMenu, canHideFeedCreator, isOwnFeedPost } from '@/lib/feed-feedback-menu';
import { hideCreatorLabel } from '@/lib/hide-creator-label';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
import { buildImmersiveShowcaseItems, showcaseFeedItemOpenHref } from '@/lib/immersive-preview-view-model';
import type { NativeMenuModel } from '@/lib/native-menu';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { useTabBarAmbientFeed } from '@/lib/tab-bar-ambient';
import { isShowcaseCoverVideoStreaming, isShowcaseVideoPreviewCandidate } from '@/lib/showcase-display';
import {
  INITIAL_SHOWCASE_ACTIVATION_STATE,
  SHOWCASE_SETTLE_CONFIRM_MS,
  getVisibleCardItems,
  reduceShowcaseActivation,
  type ShowcaseActivationEvent,
} from '@/lib/showcase-feed-activation';
import {
  createShowcaseFeedViewerQueryKey,
  createShowcasePostQueryKey,
  flattenShowcaseFeedPages,
  getShowcaseFeedSessionContext,
  normalizeShowcaseToolFilter,
  resolveMobileShowcaseFeedFilterId,
  type MobileShowcaseFeedFilterId,
  type ShowcaseFeedFilters,
} from '@/lib/showcase-feed-query';
import { serializeShowcaseFeedLane, showcaseFeedLaneQueryOptions } from '@/lib/showcase-feed-lane';
import {
  SHOWCASE_ONSCREEN_VIEWABILITY,
  SHOWCASE_PLAYBACK_VIEWABILITY,
  SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY,
  buildShowcaseFeedEventRequest,
  canRecordShowcaseFeedEvent,
  feedFeedbackUndoMessage,
  filterAnonymousSessionShowcaseFeedItems,
  findShowcaseFeedItemPositions,
  forgetAnonymousShowcaseFeedRemoval,
  getQualifiedImpressionKey,
  rememberAnonymousShowcaseFeedRemoval,
  removeShowcaseFeedItemsFromInfiniteData,
  restoreShowcaseFeedItemsToInfiniteData,
  trackFeedFeedbackRequest,
  undoFeedFeedback,
  type ShowcaseFeedEventDetails,
  type ShowcaseFeedFeedbackTarget,
  type ShowcaseFeedFeedbackType,
} from '@/lib/showcase-feed-events';
import { newPostsProbeCategory, newestFeedPostIn, useNewPostsProbe } from '@/lib/use-new-posts-probe';
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
import { MotionView, useOverlayPresence, usePressMotion, useReducedMotion } from '@/lib/motion';
import { hexWithAlpha } from '@/lib/eased-fade';
import { accentColor, appTheme, mediaColors, themes } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { ShowcaseFeedEventType, ShowcaseFeedItem, ShowcaseFeedResponse, ShowcasePostResponse } from '@/lib/types';
import type { AppleZoomOpen } from '@/lib/apple-zoom';

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
/** How far below the status bar the list header starts: the 12 in the list's `paddingTop: topInset + 12`. */
const LIST_HEADER_TOP_GAP = 12;
/** One relayout per tick instead of one per resolved preview image. */
const SHOWCASE_ASPECT_RATIO_FLUSH_MS = 50;

/**
 * One step of the video election. A plain function rather than a callback that
 * calls itself: the settle timer dispatches through it again, and React Compiler
 * will not compile a component whose callback reads its own binding before that
 * binding is declared.
 */
function runShowcaseActivation(
  refs: {
    activation: { current: typeof INITIAL_SHOWCASE_ACTIVATION_STATE };
    settleTimer: { current: ReturnType<typeof setTimeout> | null };
  },
  event: ShowcaseActivationEvent,
  setActiveVideoIds: (ids: string[]) => void,
) {
  const previous = refs.activation.current;
  const next = reduceShowcaseActivation(previous, event, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS);
  refs.activation.current = next;

  if (refs.settleTimer.current) {
    clearTimeout(refs.settleTimer.current);
    refs.settleTimer.current = null;
  }
  // A fling whose momentum the platform never announces would otherwise sit
  // in `settling` forever, so arm a confirm timer whenever we enter it.
  if (next.scroll === 'settling') {
    refs.settleTimer.current = setTimeout(
      () => runShowcaseActivation(refs, { type: 'settleTimeout' }, setActiveVideoIds),
      SHOWCASE_SETTLE_CONFIRM_MS
    );
  }

  // `elect` reuses the previous array when nothing changed, so this is a
  // pointer comparison rather than a re-render on every scroll event.
  if (next.activeIds !== previous.activeIds) setActiveVideoIds(next.activeIds);
}

/** Where the reader is in the list, as the last on-screen viewability report put it. */
interface ShowcaseViewport {
  /** The cards with any pixel on screen. */
  onScreenCardIds: ReadonlySet<string>;
  /** The highest list index among them; -1 while none is known. */
  lastViewableIndex: number;
}

/**
 * Which measured cover ratios may change their card's height now, and which
 * wait.
 *
 * In this masonry a card that changes height re-places every card after it,
 * and nothing holds the visible ones still (the list turns
 * maintainVisibleContentPosition off). A card on screen waits, as
 * `partitionAspectRatioUpdates` explains, and so does a card above the screen,
 * whose change would move the cards being read. With optimizeItemArrangement
 * each card starts where the shorter column ends, so a card past the last one
 * on screen is below the screen, and so is every card it moves: only those take
 * their ratio at once. A held ratio is therefore released when its card leaves
 * through the bottom, never through the top (or by a refresh, which re-places
 * every card anyway). With no card on screen, above and below cannot be told
 * apart, and every ratio waits.
 */
export function partitionAspectRatiosByViewport(
  ratios: Record<string, number>,
  cards: ReadonlyArray<{ id: string }>,
  viewport: ShowcaseViewport,
): { apply: Record<string, number>; hold: Record<string, number> } {
  const { apply: offScreen, hold } = partitionAspectRatioUpdates(ratios, viewport.onScreenCardIds);
  const apply: Record<string, number> = {};
  const below = new Set<string>();
  if (viewport.lastViewableIndex >= 0) {
    for (let index = viewport.lastViewableIndex + 1; index < cards.length; index += 1) {
      below.add(cards[index].id);
    }
  }

  for (const [cardId, aspectRatio] of Object.entries(offScreen)) {
    if (below.has(cardId)) {
      apply[cardId] = aspectRatio;
    } else {
      hold[cardId] = aspectRatio;
    }
  }

  return { apply, hold };
}

export default function ShowcaseScreen() {
  const theme = useAppTheme();
  const { api, identityUserId, user } = useAuth();
  const queryClient = useQueryClient();
  const routeParams = useLocalSearchParams<{ filter?: string | string[]; tool?: string | string[] }>();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const gridLayout = useMemo(() => getShowcaseGridLayout(width), [width]);
  const feedRef = useRef<FlashListRef<ShowcaseMasonryCard>>(null);
  useScrollToTop(feedRef);
  const routeFilterId = resolveMobileShowcaseFeedFilterId(routeParams.filter);
  const routeTool = normalizeShowcaseToolFilter(routeParams.tool);
  const [activeFilterId, setActiveFilterId] = useState<FeedFilterId>(routeFilterId);
  const [activeTool, setActiveTool] = useState<string | null>(routeTool);
  const activeFilter = FEED_FILTERS.find((filter) => filter.id === activeFilterId) ?? FEED_FILTERS[0];
  const queryFilters = useMemo<ShowcaseFeedFilters>(() => ({
    ...activeFilter.params,
    category: 'media',
    ...(activeTool ? { tool: activeTool } : {}),
  }), [activeFilter, activeTool]);
  // The reel a tile opens reads and pages these very pages (`lane` below).
  // Keyed by the backend identity, a guest's too (`user` is null for one): the
  // server refuses a page's events and cursor from anyone but the identity it
  // was ranked for, so a new identity has to fetch a lane of its own.
  const laneQueryOptions = useMemo(
    () => showcaseFeedLaneQueryOptions(api, queryFilters, identityUserId),
    [api, queryFilters, identityUserId]
  );
  const queryKey = laneQueryOptions.queryKey;
  const viewerFeedQueryKey = useMemo(
    () => createShowcaseFeedViewerQueryKey(identityUserId),
    [identityUserId]
  );
  const activeToolLabel = useMemo(() => activeTool ? formatToolLabel(activeTool) : null, [activeTool]);
  // Playback lives outside React state: each pin subscribes to its own id, so
  // an election re-renders the pins it concerns rather than the whole grid.
  // Player-level focus gating keeps tab switches out of it too.
  const [activationStore] = useState(() => createFeedVideoActivationStore());
  const [resolvedAspectRatios, setResolvedAspectRatios] = useState<Record<string, number>>({});
  const [isSwipingMedia, setIsSwipingMedia] = useState(false);
  const [feedbackItem, setFeedbackItem] = useState<ShowcaseFeedItem | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  // The last Not interested or Hide, offering Undo for five seconds; one at a
  // time (`FeedUndoNotice`).
  const [undoNotice, setUndoNotice] = useState<FeedUndoNoticeModel | null>(null);
  const dismissUndoNotice = (id: string) => setUndoNotice((current) => (current?.id === id ? null : current));
  // The list header's title row and chips, as laid out (0 until measured), and
  // whether the list has scrolled past them: the compact search button stands
  // in for the header's own once it has (`CompactSearchButton`).
  const [listHeaderHeight, setListHeaderHeight] = useState(0);
  const [listHeaderScrolledOff, setListHeaderScrolledOff] = useState(false);
  const listHeaderScrolledOffRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMorePageCountRef = useRef<number | null>(null);
  // Where the screen is in the list, and the ratios waiting for their cards to
  // pass below it. See `partitionAspectRatiosByViewport` for why a measurement
  // cannot be applied to a card on or above the screen.
  const viewportRef = useRef<ShowcaseViewport>({ onScreenCardIds: new Set(), lastViewableIndex: -1 });
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
    runShowcaseActivation(
      { activation: activationRef, settleTimer: settleTimerRef },
      event,
      (activeIds) => activationStore.publish({ activeIds }),
    );
  }, [activationStore]);

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
    const { apply, hold } = partitionAspectRatiosByViewport(
      updates,
      // The list's own data: the order its viewability indices count in.
      feedRef.current?.props.data ?? [],
      viewportRef.current,
    );
    if (Object.keys(hold).length) {
      heldAspectRatiosRef.current = { ...heldAspectRatiosRef.current, ...hold };
    }
    if (!Object.keys(apply).length) return;
    setResolvedAspectRatios((current) => mergeAspectRatios(current, apply));
  }, []);

  /**
   * Lets go of the held ratios whose cards are now below the screen, or of all
   * of them at a refresh, which lays the grid out afresh anyway.
   */
  const releaseHeldAspectRatios = useCallback((cause: 'viewport' | 'refresh') => {
    const held = heldAspectRatiosRef.current;
    if (!Object.keys(held).length) return;

    const { apply, hold } = cause === 'refresh'
      ? { apply: held, hold: {} }
      : partitionAspectRatiosByViewport(held, feedRef.current?.props.data ?? [], viewportRef.current);
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
    let lastViewableIndex = -1;
    for (const token of viewableItems) {
      if (!token.isViewable || !token.item) continue;
      onScreen.add(token.item.id);
      if (typeof token.index === 'number') lastViewableIndex = Math.max(lastViewableIndex, token.index);
    }
    viewportRef.current = { onScreenCardIds: onScreen, lastViewableIndex };
    releaseHeldAspectRatios('viewport');
  }, [releaseHeldAspectRatios]);
  // Built once from the first render's callbacks, which FlashList needs to stay
  // stable. State rather than a ref, which render may not read.
  const [viewabilityConfigCallbackPairs] = useState(() => [
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
  ]);
  const showcaseQuery = useInfiniteQuery(laneQueryOptions);
  const feedSession = useMemo(
    () => getShowcaseFeedSessionContext(showcaseQuery.data?.pages),
    [showcaseQuery.data?.pages]
  );
  // Written after render, not during it. Its readers all run later: taps, media
  // progress, and the impression callback, which waits for a card to stay on
  // screen a second.
  useEffect(() => {
    feedEventRuntimeRef.current = {
      api,
      isFocused,
      feedSessionId: feedSession.feedSessionId,
      algorithmVersion: feedSession.algorithmVersion,
    };
  }, [api, feedSession.algorithmVersion, feedSession.feedSessionId, isFocused]);
  const showcaseItems = useMemo(() => {
    const flattened = flattenShowcaseFeedPages(showcaseQuery.data?.pages);
    // The API fills pages with media posts. The masonry filter also protects
    // clients talking to an older server during rollout.
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
  // "New posts" (product decision D2): on a return to the app five minutes or
  // more after the lane was fetched, the server is asked whether it has a post
  // newer than any the lane holds, and nothing is fetched into the lane until
  // the pill is tapped. Every Explore lane is ranked; none is the unranked
  // Recent lane, which keeps its own refetch.
  const newestHeld = newestFeedPostIn(showcaseQuery.data);
  const newPosts = useNewPostsProbe({
    api,
    category: newPostsProbeCategory(queryFilters.category),
    enabled: isFocused,
    laneFetchedAt: showcaseQuery.dataUpdatedAt,
    newestKnownPublishedAt: newestHeld.publishedAt,
    newestKnownPostId: newestHeld.postId,
  });
  const endMessage = activeToolLabel
    ? `You've reached the end of ${activeToolLabel}.`
    : activeFilterId === 'all'
      ? "You're all caught up."
      : `You've reached the end of ${activeFilter.label}.`;

  useEffect(() => {
    setActiveFilterId((current) => current === routeFilterId ? current : routeFilterId);
  }, [routeFilterId]);

  useEffect(() => {
    setActiveTool((current) => current === routeTool ? current : routeTool);
  }, [routeTool]);

  useEffect(() => {
    dispatchActivation({ type: 'reset' });
    activationStore.publish({ activeIds: [] });
    setFeedbackItem(null);
    // The pill answered for the lane being left. The other lane's fetch time
    // already hides it; this keeps it down on coming back to this lane too,
    // until the next return to the app asks again.
    newPosts.dismiss();
    // Every carousel is about to unmount; their releases would land after the
    // new list has already opened locks of its own.
    mediaDragCountRef.current = 0;
    setIsSwipingMedia(false);
    heldAspectRatiosRef.current = {};
    qualifiedImpressionsRef.current.clear();
    loadingMoreRef.current = false;
    lastLoadMoreAtRef.current = 0;
    lastLoadMorePageCountRef.current = null;
    // Another filter or tool is another feed, so it opens at the top, as a
    // first visit does. The list keeps its offset across a data change, and a
    // tool can arrive by link (a creator's tool) while this grid sits deep in
    // the previous feed.
    feedRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [activeFilterId, activeTool]);

  // FlashList reports viewability by index, not by post: new posts landing on
  // the indices already on screen (a filter switch to a cached feed, a
  // refresh, a removed post) report nothing. The reset above would then leave
  // the grid without a video, or the election would hold a post that has
  // gone, until the next scroll. Recomputing reports the posts now there.
  useEffect(() => {
    if (cards.length) feedRef.current?.recomputeViewableItems();
  }, [cards]);

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

  /** The lane trimmed to its first page and that page fetched again: a pull, Refresh, and the "New posts" pill. */
  const refetchFirstPage = () => {
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(queryKey, (current) => {
      if (!current?.pages.length) return current;
      return {
        pages: current.pages.slice(0, 1),
        pageParams: current.pageParams.slice(0, 1),
      };
    });
    return showcaseQuery.refetch().finally(() => {
      // Cards that left through the top kept their placeholder height until
      // now; the refreshed page re-places every card anyway.
      releaseHeldAspectRatios('refresh');
    });
  };

  const handleRefresh = () => {
    haptic.light();
    setPullRefreshing(true);
    void refetchFirstPage().finally(() => setPullRefreshing(false));
  };

  // The pill's refresh leaves `pullRefreshing` alone: tapped deep in the grid,
  // a programmatic spinner would shift the iOS list down and strand it there
  // (the note at `pullRefreshing`). The list goes to the top first, at once, so
  // the trimmed lane lands where the reader is looking.
  const showNewPosts = () => {
    haptic.light();
    newPosts.dismiss();
    feedRef.current?.scrollToOffset({ offset: 0, animated: false });
    void refetchFirstPage();
  };

  // Scroll events arrive every frame; only the moment the header passes under
  // the status bar, one way or the other, reaches React.
  const trackListOffset = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const scrolledOff = listHeaderHeight > 0
      && event.nativeEvent.contentOffset.y >= LIST_HEADER_TOP_GAP + listHeaderHeight;
    if (scrolledOff === listHeaderScrolledOffRef.current) return;
    listHeaderScrolledOffRef.current = scrolledOff;
    setListHeaderScrolledOff(scrolledOff);
  };

  const openPost = useCallback((item: ShowcaseFeedItem, zoom: AppleZoomOpen | null = null) => {
    haptic.light();
    recordFeedEvent(item, 'open');
    queryClient.setQueryData<ShowcasePostResponse>(createShowcasePostQueryKey(item.id, user?.id), {
      success: true,
      item,
    });
    router.push(showcaseFeedItemOpenHref({
      item,
      source: 'showcase-feed',
      mediaOnly: true,
      feedSessionId: feedSession.feedSessionId,
      algorithmVersion: item.recommendation?.algorithmVersion ?? feedSession.algorithmVersion,
      // The reel reads this grid's lane, its filters and tool, and pages on
      // through it, rather than a For You session of its own.
      lane: serializeShowcaseFeedLane(queryFilters),
      zoom,
    }) as never);
  }, [queryClient, user?.id, recordFeedEvent, feedSession.feedSessionId, feedSession.algorithmVersion, queryFilters]);

  const applyFeedFeedback = (item: ShowcaseFeedItem | null, eventType: ShowcaseFeedFeedbackType) => {
    if (!item) return;
    if (eventType === 'hide_creator' && (!item.creator.id || item.creator.id === user?.id)) {
      return;
    }
    const target = eventType === 'hide_creator'
      ? { creatorId: item.creator.id }
      : { postId: item.id };
    const feedbackTarget: ShowcaseFeedFeedbackTarget = { ...target, feedbackType: eventType };
    const cachedFeeds = queryClient.getQueriesData<InfiniteData<ShowcaseFeedResponse>>({
      queryKey: viewerFeedQueryKey,
    });
    // Read before the removal: where each post sat in each lane, so Undo puts
    // it back at the index it left (product decision D7).
    const positions = cachedFeeds.map(([cachedQueryKey, cachedData]) => (
      [cachedQueryKey, findShowcaseFeedItemPositions(cachedData, target)] as const
    ));

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

    // No announcement of its own on success: the notice below announces itself.
    // Tracked, so an Undo waits for this request rather than overtaking it.
    void trackFeedFeedbackRequest(feedbackTarget, runtime.api.recordShowcaseFeedEvent(request))
      .catch(() => {
        dismissUndoNotice(request.clientEventId);
        if (!user) forgetAnonymousShowcaseFeedRemoval(target);
        cachedFeeds.forEach(([cachedQueryKey, cachedData]) => {
          queryClient.setQueryData(cachedQueryKey, cachedData);
        });
        showMessageDialog({
          title: 'Couldn’t update your feed',
          message: 'The post was restored. Check your connection and try again.',
        });
        void AccessibilityInfo.announceForAccessibility(
          'Couldn’t update your feed. The post was restored.'
        );
      });
    setUndoNotice({
      id: request.clientEventId,
      message: feedFeedbackUndoMessage(eventType),
      onUndo: () => {
        // The posts come back only once the server has taken the choice back,
        // in place in every lane that held them, so a page loaded since stays.
        void undoFeedFeedback(api, feedbackTarget, { hasSession: Boolean(identityUserId) })
          .then(() => {
            positions.forEach(([cachedQueryKey, lanePositions]) => {
              queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(
                cachedQueryKey,
                (current) => restoreShowcaseFeedItemsToInfiniteData(current, lanePositions),
              );
            });
          })
          .catch(() => {
            haptic.error();
            showMessageDialog({
              title: 'Couldn’t undo',
              message: feedbackTarget.feedbackType === 'hide_creator'
                ? 'The creator is still hidden. Check your connection and try again.'
                : 'The post is still hidden. Check your connection and try again.',
            });
          });
      },
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

  const reportFeedbackContent = (item: ShowcaseFeedItem | null) => {
    if (!item || !requireModerationSignIn()) return;
    setFeedbackItem(null);
    void showConfirmDialog({
      title: 'Report content?',
      message: 'Magicbooklet will send this post to the moderation team for a safety review.',
      confirmLabel: 'Report content',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      // The tile's delivery, so the ranker hears the report. Built outside the try: React Compiler skips a
      // component with a conditional inside a try/catch.
      const deliveryId = item.recommendation?.deliveryId;
      const report = {
        reason: 'unsafe_content' as const,
        details: 'Reported from the mobile Showcase.',
        ...(deliveryId ? { deliveryId } : {}),
      };
      try {
        await api.reportPost(item.id, report);
        queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
          { queryKey: viewerFeedQueryKey },
          (current) => removeShowcaseFeedItemsFromInfiniteData(current, { postId: item.id })
        );
        void AccessibilityInfo.announceForAccessibility('Content reported and removed from your feed.');
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not report content', error);
      }
    });
  };

  const reportFeedbackUser = (item: ShowcaseFeedItem | null) => {
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
          // The reason the web and this app's reel and Home file a creator
          // under, so moderators see one.
          reason: 'harassment',
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

  const blockFeedbackUser = (item: ShowcaseFeedItem | null) => {
    if (!item?.creator.id || item.creator.id === user?.id || !requireModerationSignIn()) return;
    setFeedbackItem(null);
    const creatorId = item.creator.id;
    const creatorLabel = formatCreatorLabel(item.creator.username || item.creator.name);
    void showConfirmDialog({
      title: `Block ${creatorLabel}?`,
      message: 'Their posts will be hidden, and neither of you will be able to follow the other.',
      confirmLabel: 'Block user',
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      const block = async () => {
        await api.blockUser(creatorId);
        queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
          { queryKey: viewerFeedQueryKey },
          (current) => removeShowcaseFeedItemsFromInfiniteData(current, { creatorId })
        );
        // Their cached grid becomes the server's blocked answer, as the creator
        // page's own Block leaves it. Invalidating ['creator-profile'] read
        // every loaded page of every cached grid again.
        setCachedCreatorProfileBlocked(queryClient, creatorId);
        await queryClient.invalidateQueries({ queryKey: ['profile-saved-media', user?.id] });
        void AccessibilityInfo.announceForAccessibility(`${creatorLabel} blocked.`);
      };
      // `.catch` rather than try/catch: React Compiler cannot yet compile
      // optional chaining inside a try block.
      return block().catch((error) => {
        haptic.error();
        showErrorDialog('Could not block user', error);
      });
    });
  };

  // The menu each pin's ⋮ opens (`lib/native-menu.ts`), acting on that pin's
  // post. `FeedFeedbackSheet` below is the fallback for a build without native
  // menus, and acts on the post whose ⋮ opened it.
  const feedbackMenu = (item: ShowcaseFeedItem): NativeMenuModel => buildFeedFeedbackMenu({
    creator: item.creator,
    canHideCreator: canHideFeedCreator(item.creator.id, user?.id),
    viewerIsOwner: isOwnFeedPost(item.creator.id, user?.id),
    viewerKind: user ? 'member' : 'guest',
    onNotInterested: () => applyFeedFeedback(item, 'not_interested'),
    onHideCreator: () => applyFeedFeedback(item, 'hide_creator'),
    onReportContent: () => reportFeedbackContent(item),
    onReportUser: item.creator.id ? () => reportFeedbackUser(item) : undefined,
    onBlockUser: item.creator.id ? () => blockFeedbackUser(item) : undefined,
  });

  const openCreator = useCallback((item: ShowcaseFeedItem) => {
    const username = item.creator.username?.trim();
    if (!username) return;
    router.push(`/creators/${encodeURIComponent(username)}` as never);
  }, []);

  // Memoized: an inline literal here changes identity on every parent render,
  // which makes FlashList re-render every mounted cell instead of only when a
  // resolved ratio actually changed. Activation is not in here: pins read it
  // from the store themselves.
  const feedExtraData = useMemo(
    () => ({ resolvedAspectRatios }),
    [resolvedAspectRatios]
  );

  const renderCard: ListRenderItem<ShowcaseMasonryCard> = useCallback(({ item, target, index }) => {
    return (
      <MasonryCardCell layout={gridLayout} index={index}>
        <MasonryPin
          card={item}
          layout={gridLayout}
          playbackEligible={target === 'Cell'}
          resolvedAspectRatio={resolvedAspectRatios[item.id]}
          onAspectRatio={queueAspectRatio}
          onOpenCreator={openCreator}
          onFeedbackOpen={setFeedbackItem}
          feedbackMenu={feedbackMenu}
          onOpenPost={openPost}
          onScrollToggle={handleMediaScrollToggle}
        />
      </MasonryCardCell>
    );
  }, [gridLayout, resolvedAspectRatios, openCreator, feedbackMenu, openPost, handleMediaScrollToggle]);

  return (
    // Pins on this grid are what the reel grows out of and returns to.
    <FeedVideoActivationContext.Provider value={activationStore}>
    <MediaZoomSurface>
    <WorkspaceSideMenuGestureLayer bottomOffset={tabBarMetrics.contentBottomPadding} enabled={!isSwipingMedia}>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
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
        onScroll={trackListOffset}
        getItemType={(item) => item.mediaKind ?? item.item.category}
        keyExtractor={(item) => item.id}
        // FlashList's default keeps whichever post is first on screen in place
        // across a data change, finding it again by key. A filter switch is a
        // new feed, though: Free's first post also sits further down All, so
        // Free → All opened there rather than at the top. Off, little is lost:
        // in this masonry a card that grows or leaves above the screen
        // re-places every card after it, and pinning one card never held the
        // rest still.
        maintainVisibleContentPosition={{ disabled: true }}
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
          backgroundColor: theme.colors.background,
        }}
        contentContainerStyle={{
          paddingTop: topInset + 12,
          paddingHorizontal: FEED_HORIZONTAL_PADDING,
          paddingBottom: tabBarMetrics.contentBottomOverlapPadding + appTheme.spacing.section,
        }}
        // The header keeps one height in every load state. FlashList offsets
        // the first card by the header's height, but the render that delivers
        // the first page still reads the height from before it, and the list's
        // own record of where it is scrolled stays off by the difference until
        // something scrolls. With the loading skeleton in here that put every
        // card below the screen: nothing counted as viewable and no video
        // started. Loading, failure and emptiness render in ListEmptyComponent.
        ListHeaderComponent={
          <View style={{ paddingBottom: 16 }}>
            <View style={{ gap: 10 }} onLayout={(event) => setListHeaderHeight(event.nativeEvent.layout.height)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                {/* The edge swipe used to be the only way into the workspace
                    menu from here, which Gestures forbids — a shortcut gesture
                    supplements a control, it never replaces one. */}
                <WorkspaceMenuButton />
                <Text accessibilityRole="header" selectable style={{ flex: 1, color: theme.colors.text, ...appTheme.type.pageTitle }}>
                  Explore
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <IconButton label="Search creators, posts, and recipes" onPress={() => setSearchVisible(true)}>
                    <Search size={appTheme.icon.default} color={theme.colors.text} />
                  </IconButton>
                  <IconButton
                    disabled={showcaseQuery.isFetching && !showcaseQuery.isFetchingNextPage}
                    label="Refresh Explore"
                    onPress={handleRefresh}
                  >
                    <RefreshCw size={appTheme.icon.default} color={theme.colors.text} />
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
                      backgroundColor: `${theme.colors.commerce}1f`,
                      opacity: pressed ? appTheme.opacity.pressed : 1,
                      paddingLeft: 11,
                      paddingRight: 9,
                    })}
                  >
                    <Text style={{ color: theme.colors.text, ...appTheme.type.label }}>{activeToolLabel}</Text>
                    <X size={14} color={theme.colors.text} />
                  </Pressable>
                ) : null}
              </ScrollView>
            </View>
          </View>
        }
        ListEmptyComponent={
          showcaseQuery.error ? (
            <View style={{ gap: appTheme.spacing.gap }}>
              <StatusBlock
                tone="danger"
                title="Could not load Explore"
                body={showcaseFeedErrorBody(showcaseQuery.error)}
              />
              <SecondaryButton label="Retry Explore" onPress={handleRefresh} />
            </View>
          ) : isFirstLoad ? (
            <ShowcaseSkeletonGrid layout={gridLayout} />
          ) : (
            <StatusBlock title="Nothing in this lane yet" body={activeToolLabel
              ? `No posts made with ${activeToolLabel} yet. Pull to refresh or switch filters.`
              : activeFilterId === 'all'
                ? 'Pull to refresh, or share the first post from Create.'
                : `No ${activeFilter.label.toLowerCase()} posts yet. Pull to refresh or switch filters.`} />
          )
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

        {/* Under the chips as they sit at rest, over the grid once they scroll. */}
        <NewPostsPill
          visible={newPosts.hasNewer}
          onPress={showNewPosts}
          topOffset={topInset + LIST_HEADER_TOP_GAP + listHeaderHeight + appTheme.spacing.compact}
        />

        {/* Centred on the header's last control as it sat at rest. */}
        <CompactSearchButton
          visible={listHeaderScrolledOff}
          onPress={() => setSearchVisible(true)}
          top={topInset + LIST_HEADER_TOP_GAP + (appTheme.touch.compact - COMPACT_SEARCH_SIZE) / 2}
          right={FEED_HORIZONTAL_PADDING + (appTheme.touch.compact - COMPACT_SEARCH_SIZE) / 2}
        />

        <FeedUndoNotice
          notice={undoNotice}
          onDismiss={dismissUndoNotice}
          bottomOffset={tabBarMetrics.contentBottomPadding}
        />

        <ExploreSearchOverlay api={api} visible={searchVisible} onClose={() => setSearchVisible(false)} />

        <FeedFeedbackSheet
          creatorLabel={feedbackItem ? formatCreatorLabel(feedbackItem.creator.username || feedbackItem.creator.name) : '@creator'}
          hideLabel={hideCreatorLabel(feedbackItem?.creator ?? {})}
          canHideCreator={canHideFeedCreator(feedbackItem?.creator.id, user?.id)}
          viewerIsOwner={isOwnFeedPost(feedbackItem?.creator.id, user?.id)}
          onClose={() => setFeedbackItem(null)}
          onHideCreator={() => applyFeedFeedback(feedbackItem, 'hide_creator')}
          onNotInterested={() => applyFeedFeedback(feedbackItem, 'not_interested')}
          onBlockUser={feedbackItem?.creator.id ? () => blockFeedbackUser(feedbackItem) : undefined}
          onReportContent={() => reportFeedbackContent(feedbackItem)}
          onReportUser={feedbackItem?.creator.id ? () => reportFeedbackUser(feedbackItem) : undefined}
          postTitle={feedbackItem?.title || feedbackItem?.prompt || 'This post'}
          viewerKind={user ? 'member' : 'guest'}
          visible={Boolean(feedbackItem)}
        />
      </View>
    </WorkspaceSideMenuGestureLayer>
    </MediaZoomSurface>
    </FeedVideoActivationContext.Provider>
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
  const theme = useAppTheme();
  const sideMenu = useWorkspaceSideMenu();
  if (!sideMenu) return null;

  return (
    <IconButton label={WORKSPACE_SIDE_MENU_LABEL} onPress={sideMenu.open}>
      <WorkspaceSideMenuGlyph size={appTheme.icon.default} color={theme.colors.text} />
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
  const theme = useAppTheme();
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
        backgroundColor: pressed ? theme.colors.surfaceStrong : 'transparent',
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

const COMPACT_SEARCH_SIZE = 40;

/**
 * Search once the list header, and the search button in it, has scrolled away
 * (product decision E2): a compact button floating at the top of the screen.
 * It fades in and out as an overlay does, at once under Reduce Motion, and is
 * not there while the header is on screen, so search never shows two entries.
 */
function CompactSearchButton({
  onPress,
  right,
  top,
  visible,
}: {
  onPress: () => void;
  right: number;
  top: number;
  visible: boolean;
}) {
  const theme = useAppTheme();
  const presence = useOverlayPresence(visible);
  if (!presence.mounted) return null;

  return (
    <MotionView
      pointerEvents={visible ? 'auto' : 'none'}
      style={[{ position: 'absolute', top, right, zIndex: 2 }, presence.animatedStyle as StyleProp<ViewStyle>]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search creators, posts, and recipes"
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        disabled={!visible}
        hitSlop={4}
        onPress={onPress}
        style={({ pressed }) => ({
          width: COMPACT_SEARCH_SIZE,
          height: COMPACT_SEARCH_SIZE,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.borderStrong,
          backgroundColor: theme.colors.panel,
          boxShadow: theme.shadow.soft.boxShadow,
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        <Search size={appTheme.icon.default} color={theme.colors.text} />
      </Pressable>
    </MotionView>
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
  const theme = useAppTheme();
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
        borderBottomColor: active ? theme.colors.primary : 'transparent',
      })}
    >
      <Text style={{
        color: active ? theme.colors.text : theme.colors.muted,
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
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 52, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
}

const MasonryPin = memo(function MasonryPin({
  card,
  layout,
  playbackEligible,
  resolvedAspectRatio,
  onAspectRatio,
  onFeedbackOpen,
  feedbackMenu,
  onOpenPost,
  onOpenCreator,
  onScrollToggle,
}: {
  card: ShowcaseMasonryCard;
  layout: ShowcaseGridLayout;
  /** Whether this render is a real cell, the only kind that may play; see renderCard. */
  playbackEligible: boolean;
  resolvedAspectRatio?: number;
  onAspectRatio: (cardId: string, ratio: number) => void;
  onFeedbackOpen: (item: ShowcaseFeedItem) => void;
  /** The ⋮ menu for a post; `onFeedbackOpen` opens the sheet where native menus are missing. */
  feedbackMenu: (item: ShowcaseFeedItem) => NativeMenuModel;
  onOpenCreator: (item: ShowcaseFeedItem) => void;
  onOpenPost: (item: ShowcaseFeedItem, zoom: AppleZoomOpen | null) => void;
  onScrollToggle?: (scrolling: boolean) => void;
}) {
  const theme = useAppTheme();
  const { width } = useWindowDimensions();
  const columnWidth = (width - FEED_HORIZONTAL_PADDING * 2 - layout.columnGap) / 2;
  const mediaHeight = getShowcaseMediaHeight(card, columnWidth, resolvedAspectRatio);
  const accent = accentColor(card.accent, theme.colors);
  const isVideoCard = isShowcaseVideoPreviewCandidate(card.item);
  const activationStore = useContext(FeedVideoActivationContext);
  const activation = useFeedVideoActivation(activationStore, card.id);
  const activeVideo = playbackEligible && activation === 'visible';
  const showActiveVideo = isVideoCard && activeVideo && Boolean(card.mediaUrl);
  // Reduce Motion and Autoplay previews → Never turn every preview back into a
  // poster without changing the election, so the badge asks the same question
  // the tile does.
  const reducedMotion = useReducedMotion();
  const previewsEnabled = useAutoplayPreviewsEnabled();
  const coverVideoStreaming = isShowcaseCoverVideoStreaming(card.item, showActiveVideo && !reducedMotion && previewsEnabled);
  const creatorLabel = formatCreatorLabel(card.creatorLabel);
  const signal = card.unlock;
  // The pin is the rectangle the reel grows out of, and empties into while the
  // reel is holding this post.
  const pinMediaItems = getShowcasePreviewMediaItems(card.item);
  const zoomSource = useMediaZoomSource({
    itemId: card.item.id,
    radius: layout.mediaRadius,
    aspectRatio: resolvedAspectRatio ?? card.aspectRatio ?? null,
    preview: showcaseMediaZoomPreview(pinMediaItems[0]),
    // The post as the reel lists it, so the window it grows in carries its rail
    // and caption from the first frame.
    post: buildImmersiveShowcaseItems('showcase-feed', [card.item])[0] ?? null,
  });
  const pressMotion = usePressMotion(Boolean(zoomSource.appleZoomId), { scale: appTheme.motion.scale.pressed });
  const openPin = () => zoomSource.capture((zoom) => onOpenPost(card.item, zoom));

  return (
    <View style={{ gap: 5 }}>
      <MotionView style={pressMotion.animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${card.title}. ${card.badge}${signal ? `. ${signal.summary}` : ''}. ${creatorLabel}`}
        accessibilityHint="Opens this post in the full-screen viewer"
        onPress={openPin}
        onPressIn={() => {
          pressMotion.onPressIn();
          zoomSource.prepare();
        }}
        onPressOut={pressMotion.onPressOut}
        style={{
          height: mediaHeight,
          borderRadius: layout.mediaRadius,
          borderCurve: 'continuous',
          overflow: 'hidden',
          backgroundColor: theme.colors.mediaPlaceholder,
        }}
      >
        <MediaZoomSourceView source={zoomSource} style={{ width: columnWidth, height: mediaHeight }}>
        {hasShowcasePreviewMedia(card.item) ? (
          <ShowcaseMediaPreview
            mediaItems={pinMediaItems}
            height={mediaHeight}
            accent={accent}
            width={columnWidth}
            radius={layout.mediaRadius}
            recyclingKey={`showcase:${card.id}`}
            videoActivation={showActiveVideo ? 'visible' : 'never'}
            videoBackdrop="none"
            videoContentFit="cover"
            onPress={openPin}
            onScrollToggle={onScrollToggle}
            onCoverLoad={card.aspectRatio || resolvedAspectRatio ? undefined : (event) => {
              const ratio = event.source.width / event.source.height;
              if (Number.isFinite(ratio) && ratio > 0) onAspectRatio(card.id, ratio);
            }}
          />
        ) : (
          isVideoCard ? (
            <VideoPinPreview accent={accent} height={mediaHeight} radius={layout.mediaRadius} />
          ) : (
            <VisualFallbackPreview accent={accent} height={mediaHeight} radius={layout.mediaRadius} />
          )
        )}
        {/* The pin sits on a dark glass chip over the picture, so it takes the
            dark palette's bright tones in both schemes. */}
        {signal ? <PinBadge label={signal.label} accent={accentColor(signal.accent, themes.dark.colors)} /> : null}
        {isVideoCard && !coverVideoStreaming ? <VideoCornerPlay /> : null}
        </MediaZoomSourceView>
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
          <Text numberOfLines={1} style={{ color: theme.colors.muted, flex: 1, ...appTheme.type.caption, fontWeight: '700' }}>
            {creatorLabel}
          </Text>
        </Pressable>
        <NativeMenu
          model={feedbackMenu(card.item)}
          accessibilityLabel={`Explore controls for ${card.title}`}
          accessibilityHint="Hide this post or this creator from recommendations"
          trigger={{ width: 40, height: 40, iconSize: 18, iconColor: theme.colors.muted, vertical: true, hitSlop: 4 }}
          style={{ marginRight: -7 }}
          onFallbackPress={() => onFeedbackOpen(card.item)}
          renderButton={(onPress) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Explore controls for ${card.title}`}
              accessibilityHint="Hide this post or this creator from recommendations"
              hitSlop={4}
              onPress={onPress}
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: appTheme.radii.pill,
                backgroundColor: pressed ? theme.colors.surfaceStrong : 'transparent',
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <MoreVertical size={18} color={theme.colors.muted} />
            </Pressable>
          )}
        />
      </View>
    </View>
  );
});

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
        backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.78),
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
        backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.42),
      }}
    >
      <Play size={16} color={mediaColors.onMedia} fill={mediaColors.onMedia} />
    </View>
  );
}

function VisualFallbackPreview({ accent, height, radius }: { accent: string; height: number; radius: number }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        height,
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surfaceInset,
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
  const theme = useAppTheme();
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
        backgroundColor: theme.colors.mediaPlaceholder,
        overflow: 'hidden',
      }}
    >
      <View style={{ position: 'absolute', inset: 0, backgroundColor: `${accent}12` }} />
      <FeedMediaPlate accent={accent} glyph={Play} filled />
    </View>
  );
}
