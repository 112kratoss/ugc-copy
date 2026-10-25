import { FlashList, type FlashListRef, type ListRenderItem, type ViewToken } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useIsFocused, useScrollToTop } from '@react-navigation/native';
import { router, useLocalSearchParams } from 'expo-router';
import { Crown, Plus, Search } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, Linking, Platform, Pressable, RefreshControl, Share, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CommentsSheet } from '@/components/comments-sheet';
import { ExploreSearchOverlay } from '@/components/explore-search-overlay';
import { FeedFeedbackSheet } from '@/components/feed-feedback-sheet';
import { FeedEndFooter, FeedLoadMoreErrorFooter } from '@/components/feed-pagination-footer';
import { FeedUndoNotice, type FeedUndoNoticeModel } from '@/components/feed-undo-notice';
import { GuestMergeBanner } from '@/components/guest-merge-banner';
import { HomeFeedCardView } from '@/components/home-feed-card';
import { HomeShelf } from '@/components/home-shelf';
import { MediaZoomSurface } from '@/components/media-zoom';
import { HomeSideMenu } from '@/components/home-side-menu';
import { NewPostsPill } from '@/components/new-posts-pill';
import { WorkspaceSideMenuGlyph, WORKSPACE_SIDE_MENU_LABEL } from '@/components/workspace-side-menu-gesture-layer';
import { OnboardingResumeCard } from '@/components/onboarding-resume-card';
import { Reveal } from '@/components/reveal';
import { HomeFeedSkeleton } from '@/components/skeleton';
import { TopScrim } from '@/components/top-scrim';
import { SecondaryButton, StatusBlock } from '@/components/ui';
import { UnlockRemixPrompt } from '@/components/unlock-remix-prompt';
import { useAuth } from '@/lib/auth';
import { useAutoplayPolicy } from '@/lib/autoplay-preference';
import { env } from '@/lib/env';
import { REMIX_NEEDS_WEB_BODY, REMIX_NEEDS_WEB_TITLE } from '@/lib/viewer-actions';
import { feedWindowPaginationPosition } from '@/lib/feed-page-window';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
import {
  HOME_FEED_CHIPS,
  buildHomeFeedCards,
  getHomeFeedCardOpenTarget,
  type HomeFeedCard,
  type HomeFeedChipId,
} from '@/lib/home-feed-view-model';
import { keepHomeShelfCreations, readHomeShelfItems } from '@/lib/home-shelf-view-model';
import { createHomeFeedPlaybackController } from '@/lib/home-feed-playback';
import { createFeedVideoActivationStore, FeedVideoActivationContext } from '@/lib/feed-video-activation';
import { useAppForeground } from '@/lib/app-foreground';
import { buildFeedFeedbackMenu, canHideFeedCreator, isOwnFeedPost } from '@/lib/feed-feedback-menu';
import { hideCreatorLabel } from '@/lib/hide-creator-label';
import { buildImmersiveShowcaseItems, immersiveViewerHref, textPostViewerHref } from '@/lib/immersive-preview-view-model';
import { feedReadMoreSection, type FeedReadMoreSection } from '@/lib/feed-read-more';
import type { NativeMenuModel } from '@/lib/native-menu';
import type { AppleZoomOpen } from '@/lib/apple-zoom';
import { SHOWCASE_DRAW_DISTANCE } from '@/lib/media-performance';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { MotionView, usePressMotion } from '@/lib/motion';
import { startShowcaseRemix } from '@/lib/remix-start';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getShowcaseRemixAccess } from '@/lib/showcase-remix-access';
import { refreshUnlockedBundleCaches } from '@/lib/unlock-cache';
import {
  createFeedAttentionTracker,
  feedAttentionEventDetails,
  type FeedAttentionEvent,
} from '@/lib/feed-attention-view-model';
import { resourceOpenGate } from '@/lib/reel-feed-events';
import {
  SHOWCASE_DWELL_VIEWABILITY,
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
import {
  enqueueShowcaseFeedEvent,
  flushShowcaseFeedEvents,
  isBatchedShowcaseFeedEventType,
} from '@/lib/feed-event-queue';
import {
  createShowcaseFeedViewerQueryKey,
  createShowcasePostQueryKey,
  flattenShowcaseFeedPages,
  getShowcaseFeedSessionContext,
} from '@/lib/showcase-feed-query';
import { serializeShowcaseFeedLane, showcaseFeedLaneQueryOptions } from '@/lib/showcase-feed-lane';
import {
  PERSISTED_HOME_FEED_CHIP_ID,
  cancelScheduledPersistHomeFeed,
  isPersistedHomeFeedData,
  schedulePersistHomeFeed,
} from '@/lib/persisted-home-feed';
import { formatCreditBalance } from '@/lib/pricing';
import { reportStartupMilestone } from '@/lib/startup-interactive';
import { useTabBarAmbientFeed } from '@/lib/tab-bar-ambient';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type {
  ShowcaseFeedEventType,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';
import { buildShareUrl, getNativeRemixCreateHref } from '@/lib/viewer-actions';
import { useShowcaseSaveMutation } from '@/lib/use-showcase-save-mutation';
import { useActiveGenerationCount } from '@/lib/use-active-generations';
import { newPostsProbeCategory, newestFeedPostIn, useNewPostsProbe } from '@/lib/use-new-posts-probe';

const LOAD_MORE_COOLDOWN_MS = 800;
// Only the cards that can be on screen when a lane first lands rise into
// place; everything past that mounts plain while scrolling.
const FEED_REVEAL_COUNT = 6;
// Where the top bar's row ends below the safe area: the list header's 10pt top
// padding and the row's 48pt. The "New posts" pill floats under it, clear of
// the row's controls while the list is at its top.
const HOME_TOP_BAR_BOTTOM = 10 + 48;

export function HomeDashboard() {
  const theme = useAppTheme();
  const {
    comments: requestedComments,
    replyTo: requestedReplyTo,
  } = useLocalSearchParams<{
    comments?: string | string[];
    replyTo?: string | string[];
  }>();
  // `user` gates the community actions on this screen (remix, save, follow).
  // The lanes are keyed by `identityUserId`, a guest's included: a guest minted
  // after the first request, or the next one after a sign-out, needs a page
  // ranked for it, since the server refuses events against another viewer's
  // feed session.
  const { user, identityUserId, api, credits, isLoading: isAuthLoading, signOut } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 390;
  const feedRef = useRef<FlashListRef<HomeFeedCard>>(null);
  useScrollToTop(feedRef);
  const horizontalPadding = isCompact ? 15 : 18;
  const contentWidth = pageWidth - horizontalPadding * 2;

  const [menuVisible, setMenuVisible] = useState(false);
  // The search Explore opens, opened over Home from its top bar.
  const [searchVisible, setSearchVisible] = useState(false);
  const [activeChipId, setActiveChipId] = useState<HomeFeedChipId>('for-you');
  // Playback lives outside React state: each tile subscribes to its own id,
  // so an election re-renders that tile and never this screen or the list.
  const [activationStore] = useState(() => createFeedVideoActivationStore());
  const [playbackController] = useState(() => createHomeFeedPlaybackController(activationStore));
  const foreground = useAppForeground();
  useEffect(() => playbackController.connect(), [playbackController]);
  // Autoplay previews (Settings → Playback): on mobile data under Wi-Fi only
  // the feed prepares no neighbour and hands the playing slot over only at rest.
  const autoplayPolicy = useAutoplayPolicy();
  useEffect(() => {
    playbackController.dispatch({
      type: 'policyChanged',
      electOnlyAtRest: autoplayPolicy.electOnlyAtRest,
      preparedLimit: autoplayPolicy.preparedLimit,
    });
  }, [autoplayPolicy.electOnlyAtRest, autoplayPolicy.preparedLimit, playbackController]);
  useEffect(() => {
    if (!isFocused || !foreground) playbackController.dispatch({ type: 'stop' });
  }, [foreground, isFocused, playbackController]);
  const [feedbackItem, setFeedbackItem] = useState<ShowcaseFeedItem | null>(null);
  const [commentsItem, setCommentsItem] = useState<ShowcaseFeedItem | null>(null);
  const [commentsReplyToId, setCommentsReplyToId] = useState<string | null>(null);
  // The remix request runs before we know where it lands, so the tapped card
  // owns the spinner until navigation takes over.
  const [remixingItemId, setRemixingItemId] = useState<string | null>(null);
  // The post whose paid unlock is being offered. It outlives `unlockRemixOpen`
  // so the sheet still has something to draw while it leaves.
  const [unlockRemixItem, setUnlockRemixItem] = useState<ShowcaseFeedItem | null>(null);
  const [unlockRemixOpen, setUnlockRemixOpen] = useState(false);
  // The last Not interested or Hide, offered back for five seconds. One at a
  // time: a new choice replaces the notice, and the one it replaces stands.
  const [undoNotice, setUndoNotice] = useState<FeedUndoNoticeModel | null>(null);

  const activeChip = HOME_FEED_CHIPS.find((chip) => chip.id === activeChipId) ?? HOME_FEED_CHIPS[0];
  // The reel a card opens reads and pages these very pages (`lane` below).
  const laneQueryOptions = useMemo(
    () => showcaseFeedLaneQueryOptions(api, activeChip.filters, identityUserId),
    [activeChip, api, identityUserId]
  );
  const queryKey = laneQueryOptions.queryKey;
  const viewerFeedQueryKey = useMemo(() => createShowcaseFeedViewerQueryKey(identityUserId), [identityUserId]);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.getProfile(),
    staleTime: 1000 * 60 * 5,
  });


  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMorePageCountRef = useRef<number | null>(null);
  const qualifiedImpressionsRef = useRef(new Set<string>());
  const restoringCommentContextRef = useRef<string | null>(null);
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
    if (!canRecordShowcaseFeedEvent({ postId: item.id, recommendation: item.recommendation }, eventType)) return;
    const runtime = feedEventRuntimeRef.current;
    const request = buildShowcaseFeedEventRequest(
      { postId: item.id, recommendation: item.recommendation },
      eventType,
      {
        feedSessionId: runtime.feedSessionId,
        algorithmVersion: item.recommendation?.algorithmVersion ?? runtime.algorithmVersion,
        // The same surface the web Home sends, so one feed reads as one in the
        // ranker's telemetry. The metadata tag stays for the old rows' sake.
        sourceSurface: 'feed',
      },
      { ...details, metadata: { ...(details.metadata ?? {}), surface: 'home-feed' } }
    );
    if (isBatchedShowcaseFeedEventType(eventType)) {
      void enqueueShowcaseFeedEvent(request);
    } else {
      void runtime.api.recordShowcaseFeedEvent(request).catch(() => null);
    }
  }, []);
  useEffect(() => {
    if (!isFocused) void flushShowcaseFeedEvents();
  }, [isFocused]);

  // How long each card was read and how far its inline video played, keyed by
  // delivery (`lib/feed-attention-view-model.ts`).
  const [attention] = useState(() => createFeedAttentionTracker<ShowcaseFeedItem>(
    (item) => item.recommendation?.deliveryId
  ));
  const recordAttention = useCallback((events: FeedAttentionEvent<ShowcaseFeedItem>[]) => {
    for (const event of events) {
      recordFeedEvent(event.target, event.eventType, feedAttentionEventDetails(event));
    }
  }, [recordFeedEvent]);
  // A card's resources (its recipe chip, the unlock sheet its Remix opens) are
  // reported opened once per delivery, through the gate the reel's Details and
  // unlock sheet share: the chip opens the reel on that very card.
  const recordResourceOpen = useCallback((item: ShowcaseFeedItem) => {
    if (resourceOpenGate.pass(item.recommendation?.deliveryId)) recordFeedEvent(item, 'resource_open');
  }, [recordFeedEvent]);
  // Where the cards at qualified visibility sit in the list, as last reported.
  // FlashList reports indexes, and only when they change: a refresh or a
  // removal that puts other posts at the same places says nothing, so the
  // cards on screen are read again from these whenever the data changes.
  const dwellIndexesRef = useRef<number[]>([]);
  // A stretch on screen counts only while Home is in front: focused, with the
  // app in the foreground and no search open over the cards. Leaving ends it,
  // and the dwell goes then.
  useEffect(() => {
    recordAttention(attention.setActive(isFocused && foreground && !searchVisible, Date.now()));
  }, [attention, foreground, isFocused, recordAttention, searchVisible]);
  useEffect(() => () => recordAttention(attention.setActive(false, Date.now())), [attention, recordAttention]);

  // Tints the dock from the card nearest it, and hands the neutral dock back
  // when this screen blurs so a tab with no media of its own inherits it.
  const reportAmbientMedia = useTabBarAmbientFeed(isFocused);

  const onPlaybackViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<HomeFeedCard>> }) => {
    reportAmbientMedia({ viewableItems });
    const visibleItems = viewableItems
      .filter((token) => token.isViewable && token.item)
      .map((token) => token.item.item);
    playbackController.dispatch({ type: 'viewableItemsChanged', items: visibleItems });
  }, [playbackController, reportAmbientMedia]);

  const onQualifiedViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<HomeFeedCard>> }) => {
    if (!feedEventRuntimeRef.current.isFocused) return;
    for (const token of viewableItems) {
      if (!token.isViewable || !token.item) continue;
      const item = token.item.item;
      const key = getQualifiedImpressionKey(
        { postId: item.id, recommendation: item.recommendation },
        feedEventRuntimeRef.current.feedSessionId
      );
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

  const onDwellViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<HomeFeedCard>> }) => {
    const visible = viewableItems.filter((token) => token.isViewable && token.item);
    dwellIndexesRef.current = visible
      .map((token) => token.index)
      .filter((index): index is number => typeof index === 'number');
    recordAttention(attention.setVisible(visible.map((token) => token.item.item), Date.now()));
  }, [attention, recordAttention]);

  // Built once from the first render's callbacks, which FlashList needs to stay
  // stable. State rather than a ref, which render may not read.
  const [viewabilityConfigCallbackPairs] = useState(() => [
    {
      viewabilityConfig: SHOWCASE_PLAYBACK_VIEWABILITY,
      onViewableItemsChanged: onPlaybackViewableItemsChanged,
    },
    {
      viewabilityConfig: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY,
      onViewableItemsChanged: onQualifiedViewableItemsChanged,
    },
    {
      viewabilityConfig: SHOWCASE_DWELL_VIEWABILITY,
      onViewableItemsChanged: onDwellViewableItemsChanged,
    },
  ]);

  // The lane is keyed by identity, and on a cold start the stored session lands a
  // moment after this screen mounts: a request made before it would be keyed to no
  // identity and repeated once the identity arrives, two fresh ranked sessions on
  // the server (11 of 38 fresh sessions had such a twin, 10-14 to 10-16). The
  // stored session is a local read, so waiting for auth to settle costs nothing.
  const feedQuery = useInfiniteQuery({ ...laneQueryOptions, enabled: !isAuthLoading });

  const feedSession = useMemo(
    () => getShowcaseFeedSessionContext(feedQuery.data?.pages),
    [feedQuery.data?.pages]
  );
  // Written after render, not during it. Its readers all run later: taps, and
  // the impression callback, which waits for a card to stay on screen a second.
  useEffect(() => {
    feedEventRuntimeRef.current = {
      api,
      isFocused,
      feedSessionId: feedSession.feedSessionId,
      algorithmVersion: feedSession.algorithmVersion,
    };
  }, [api, feedSession.algorithmVersion, feedSession.feedSessionId, isFocused]);

  const feedItems = useMemo(() => {
    const flattened = flattenShowcaseFeedPages(feedQuery.data?.pages);
    return user ? flattened : filterAnonymousSessionShowcaseFeedItems(flattened);
  }, [feedQuery.data?.pages, user]);
  const feedPageCount = feedWindowPaginationPosition(feedQuery.data);
  const requestedCommentsPostId = (
    Array.isArray(requestedComments) ? requestedComments[0] : requestedComments
  )?.trim() || null;
  const requestedReplyToId = (
    Array.isArray(requestedReplyTo) ? requestedReplyTo[0] : requestedReplyTo
  )?.trim() || null;

  useEffect(() => {
    if (!requestedCommentsPostId) return;
    const restoreKey = `${requestedCommentsPostId}:${requestedReplyToId ?? ''}`;
    if (restoringCommentContextRef.current === restoreKey) return;
    restoringCommentContextRef.current = restoreKey;

    void (async () => {
      const cached = feedItems.find((item) => item.id === requestedCommentsPostId);
      const target = cached
        ?? (await api.getShowcasePost(requestedCommentsPostId).catch(() => null))?.item
        ?? null;
      if (!target) {
        restoringCommentContextRef.current = null;
        return;
      }
      setCommentsReplyToId(requestedReplyToId);
      setCommentsItem(target);
      router.setParams({ comments: undefined, replyTo: undefined } as never);
    })();
  }, [api, feedItems, requestedCommentsPostId, requestedReplyToId]);

  const cards = useMemo(() => buildHomeFeedCards(feedItems), [feedItems]);
  useEffect(() => {
    const visible = dwellIndexesRef.current
      .map((index) => cards[index]?.item)
      .filter((item): item is ShowcaseFeedItem => Boolean(item));
    recordAttention(attention.setVisible(visible, Date.now()));
  }, [attention, cards, recordAttention]);
  // The controller picks the prepared neighbours in card order, so it needs
  // the cards as the list shows them, after every page and refetch.
  useEffect(() => {
    playbackController.dispatch({ type: 'itemsChanged', items: cards.map((card) => card.item) });
  }, [cards, playbackController]);
  // FlashList reports viewability by index, not by post: new posts landing on
  // the indices already on screen (a refresh, the network page replacing the
  // one restored at launch, a removed post) report nothing. Their impressions
  // would wait, and the election would hold a post that has gone, until the
  // next scroll. Recomputing reports the posts now there; a delivery already
  // impressed is not sent again (`qualifiedImpressionsRef`).
  useEffect(() => {
    if (cards.length) feedRef.current?.recomputeViewableItems();
  }, [cards]);
  const hasItems = cards.length > 0;
  const isFirstLoad = feedQuery.isLoading && !hasItems;
  // Reported from the commit that first holds real posts, a frame or so before
  // they are drawn. FlashList's onLoad cannot stand in: it fires once, and on a
  // cold start that is for the empty list it draws while the page loads.
  const feedMilestone = hasItems
    ? 'home-content'
    : feedQuery.isError || feedQuery.isSuccess ? 'home-empty-or-error' : null;
  // Posts drawn from the page the last launch saved, or from this launch's own
  // request. The interactive mark carries which, so the two can be told apart.
  const feedSource = isPersistedHomeFeedData(feedQuery.dataUpdatedAt) ? 'persisted' : 'network';
  useEffect(() => {
    // Held until auth settles. Before then the lane on screen is the signed-out
    // one, under StartupCoordinator's cover, and a returning member's own lane
    // replaces it in the same commit that lifts the cover.
    if (!feedMilestone || isAuthLoading) return;
    reportStartupMilestone({
      milestone: feedMilestone,
      pathname: '/',
      details: feedMilestone === 'home-content' ? { feedSource } : undefined,
    });
  }, [feedMilestone, feedSource, isAuthLoading]);
  // Saves the lane a cold start lands on, once auth has settled whose lane it
  // is, so the next launch can draw it before the network answers. The other
  // lanes are a tap away and not worth the storage.
  useEffect(() => {
    if (isAuthLoading || activeChipId !== PERSISTED_HOME_FEED_CHIP_ID || !feedQuery.isSuccess) return;
    schedulePersistHomeFeed(queryClient, identityUserId);
  }, [activeChipId, feedQuery.dataUpdatedAt, feedQuery.isSuccess, identityUserId, isAuthLoading, queryClient]);
  // A save still waiting when home unmounts is dropped. An error boundary that
  // replaces home unmounts it too, and a page that failed to draw must not be
  // the one the next launch restores.
  useEffect(() => cancelScheduledPersistHomeFeed, []);
  // Bound to the viewer's own pull, never to an incidental refetch. On iOS,
  // `refreshing` flipping true without a drag behind it runs
  // RCTRefreshControl.beginRefreshingProgrammatically, which shifts the scroll
  // view down by the control's height from wherever it currently sits — and the
  // matching end only restores that offset when the list is already at the top.
  // Anywhere else the shift is kept, so every background refetch left the feed
  // permanently pushed down by another notch.
  const [pullRefreshing, setPullRefreshing] = useState(false);
  // "New posts" (product decision D2): a ranked lane is never refetched under
  // the reader on a return to the app. Back five minutes or more after the lane
  // was fetched, the server is asked whether it has a newer post, and the pill
  // offers the refresh; nothing is fetched into the lane before the tap. Recent
  // is unranked and keeps its own refetch.
  const newestHeld = newestFeedPostIn(feedQuery.data);
  const newPosts = useNewPostsProbe({
    api,
    category: newPostsProbeCategory(activeChip.filters.category),
    enabled: isFocused && activeChip.filters.sort !== 'recent',
    laneFetchedAt: feedQuery.dataUpdatedAt,
    newestKnownPublishedAt: newestHeld.publishedAt,
    newestKnownPostId: newestHeld.postId,
  });

  const { toggleSave } = useShowcaseSaveMutation();

  // The same count the tab bar's ring shows, from the shared in-flight check.
  // Home's own query counted a status that does not exist ('starting'), left
  // out 'pending', and re-read the library every minute while nothing ran.
  const activeGenerationCount = useActiveGenerationCount();

  // The seller total rides on the profile; unknown until the profile has answered.
  const totalSalesUsdCents = profileQuery.data?.sales?.earningsUsdCents ?? null;

  // Home's "Make this" shelf. Keyed by identity: a member's answer carries
  // their own offers, a guest's or a signed-out one the creations alone, and a
  // guest asks without its token so the edge's shared answer serves it. While a
  // new identity's answer loads, the last one's creations stay up so the row
  // keeps its height; its offers, which were someone else's, do not.
  const shelfQuery = useQuery({
    queryKey: ['home-shelf', identityUserId ?? 'signed-out'],
    queryFn: () => api.getHomeShelf({ auth: Boolean(user) }),
    enabled: !isAuthLoading,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepHomeShelfCreations,
  });
  const shelfItems = useMemo(() => readHomeShelfItems(shelfQuery.data), [shelfQuery.data]);

  const requestNextPage = () => {
    const now = Date.now();
    if (!isFocused || !canRequestNextFeedPage({
      cooldownMs: LOAD_MORE_COOLDOWN_MS,
      hasNextPage: feedQuery.hasNextPage,
      isBusy: feedQuery.isFetching,
      isRequestInFlight: loadingMoreRef.current,
      lastRequestedAt: lastLoadMoreAtRef.current,
      lastRequestedPageCount: lastLoadMorePageCountRef.current,
      now,
      pageCount: feedPageCount,
    })) return;

    loadingMoreRef.current = true;
    lastLoadMoreAtRef.current = now;
    lastLoadMorePageCountRef.current = feedPageCount;
    void feedQuery.fetchNextPage().finally(() => {
      loadingMoreRef.current = false;
    });
  };

  const requestPreviousPage = () => {
    if (!isFocused || !feedQuery.hasPreviousPage || feedQuery.isFetching || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    void feedQuery.fetchPreviousPage().then((result) => {
      if (!result.isFetchPreviousPageError) lastLoadMorePageCountRef.current = null;
    }).finally(() => { loadingMoreRef.current = false; });
  };

  const retryNextPage = () => {
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    requestNextPage();
  };

  // The lane cut back to its first page and fetched again: what a pull to
  // refresh and the "New posts" pill both do.
  const refreshFirstPage = () => {
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(queryKey, (current) => {
      if (!current?.pages.length) return current;
      return { pages: current.pages.slice(0, 1), pageParams: [{ offset: 0 }] };
    });
    return feedQuery.refetch();
  };

  const handleRefresh = () => {
    haptic.light();
    setPullRefreshing(true);
    void shelfQuery.refetch();
    void refreshFirstPage().finally(() => setPullRefreshing(false));
  };

  // The pill's tap lands the reader on the lane's top and refreshes it there.
  // `pullRefreshing` stays out of it: no pull is behind this refresh, and a
  // control engaged without one shifts the list (see above).
  const showNewPosts = () => {
    haptic.light();
    newPosts.dismiss();
    feedRef.current?.scrollToOffset({ offset: 0, animated: false });
    void refreshFirstPage();
  };

  const selectChip = (chipId: HomeFeedChipId) => {
    if (chipId === activeChipId) return;
    qualifiedImpressionsRef.current.clear();
    // The lane's list is replaced: its cards leave view here.
    dwellIndexesRef.current = [];
    recordAttention(attention.setVisible([], Date.now()));
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    playbackController.dispatch({ type: 'reset' });
    setActiveChipId(chipId);
  };

  const openPost = (item: ShowcaseFeedItem, zoom: AppleZoomOpen | null = null, initialPage?: 'details', initialSection?: FeedReadMoreSection) => {
    // The reel reads this very delivery from the lane and files its dwell as
    // the reader leaves the post. The server keeps a delivery's first dwell,
    // which would otherwise be the card's seconds before the tap, filed as
    // Home blurs.
    attention.handOff(item);
    queryClient.setQueryData<ShowcasePostResponse>(createShowcasePostQueryKey(item.id, user?.id), {
      success: true,
      item,
    });
    router.push(immersiveViewerHref({
      source: 'showcase-feed',
      initialId: item.id,
      initialPage,
      initialSection,
      feedSessionId: feedSession.feedSessionId,
      algorithmVersion: item.recommendation?.algorithmVersion ?? feedSession.algorithmVersion,
      // The reel reads this chip's lane and pages on through it, rather than a
      // For You session of its own.
      lane: serializeShowcaseFeedLane(activeChip.filters),
      zoom,
    }) as never);
  };

  /**
   * The immersive viewer is the showcase reel — a vertical swipe there pages
   * through other showcase posts — so a written post opens its own screen
   * rather than being dropped into a reel of other people's media.
   */
  const openCard = (card: HomeFeedCard, options: { comments?: boolean; initialPage?: 'details'; initialSection?: FeedReadMoreSection; zoom?: AppleZoomOpen | null; recordOpen?: boolean } = {}) => {
    // Every way into the post is an `open` but the recipe chip, which reports
    // its resources opening instead (`resource_open`, as the web defines it).
    if (options.recordOpen !== false) recordFeedEvent(card.item, 'open');
    if (getHomeFeedCardOpenTarget(card) === 'post') {
      // Seeded so the post screen paints from cache instead of refetching.
      queryClient.setQueryData<ShowcasePostResponse>(
        createShowcasePostQueryKey(card.item.id, user?.id),
        { success: true, item: card.item }
      );
      router.push(textPostViewerHref({
        comments: options.comments,
        // Comments written on the post's screen are credited to this delivery.
        deliveryId: card.item.recommendation?.deliveryId,
        postId: card.item.id,
      }) as never);
      return;
    }
    openPost(card.item, options.zoom ?? null, options.initialPage, options.initialSection);
  };

  const openCreator = (item: ShowcaseFeedItem) => {
    const username = item.creator.username?.trim();
    if (!username) return;
    router.push(`/creators/${encodeURIComponent(username)}` as never);
  };

  const shareItem = async (item: ShowcaseFeedItem) => {
    const url = buildShareUrl(env.siteUrl, `/showcase/${item.id}`, 'feed');
    // A dismissed share sheet is not an error worth surfacing. `.catch` rather
    // than try…catch, which React Compiler cannot compile around the check below.
    const result = await Share.share({ title: item.title, message: `${item.title}\n${url}`, url }).catch(() => null);
    // Android's share intent cannot report a dismissal (it answers "shared" either way), so only iOS counts a share.
    if (Platform.OS !== 'ios' || result?.action !== Share.sharedAction) return;
    void api.shareShowcasePost(item.id, { sourceSurface: 'feed' }).catch(() => null);
    recordFeedEvent(item, 'share');
  };

  const remixItem = (item: ShowcaseFeedItem, options: { unlocked?: boolean } = {}) => {
    if (!user) {
      // The post page is where the Remix button lives, so land them on it
      // rather than the tab root they started from.
      router.push({ pathname: '/auth', params: { returnTo: `/post/${item.id}` } } as never);
      return;
    }
    // Straight after the unlock sheet the loaded post still reads as locked;
    // it catches up on the refetch, so its answer is not asked a second time.
    const access = options.unlocked ? 'open' : getShowcaseRemixAccess(item);
    const openUnlockSheet = () => {
      // The sheet offers the post's unlock: its resources, opened.
      recordResourceOpen(item);
      setUnlockRemixItem(item);
      setUnlockRemixOpen(true);
    };
    if (access === 'paid-unlock') {
      // Credits are never spent by a tap in the feed. The sheet names the
      // price, and carries on into the editor once it is paid.
      openUnlockSheet();
      return;
    }
    const startRemix = async () => {
      const started = await startShowcaseRemix({
        api,
        postId: item.id,
        claimFreeUnlock: access === 'free-unlock',
      });
      if (started.kind === 'unlock-required') {
        // This page was loaded before the creator put remix behind an unlock.
        if (item.asset) {
          openUnlockSheet();
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ['showcase-feed'] });
        showMessageDialog({
          title: 'Unlock needed',
          message: 'The creator has put this remix behind a recipe. Open the post to get it.',
        });
        return;
      }
      if (started.claimedFreeUnlock && item.asset) {
        // Not awaited: the editor opens now, and the feed learns that this
        // viewer holds the unlock behind it.
        void refreshUnlockedBundleCaches(queryClient, {
          postId: item.asset.postId || item.id,
          resourceId: item.asset.id,
        });
      }
      const result = started.response;
      recordFeedEvent(item, 'remix_start');
      const href = getNativeRemixCreateHref({
        redirectTo: result.redirectTo,
        recreateTool: item.category === 'video' ? 'video' : 'image',
        prompt: item.prompt || item.body,
      });
      if (href) {
        router.push(href as never);
      } else if (result.redirectTo) {
        const webUrl = `${env.siteUrl}${result.redirectTo}`;
        void showConfirmDialog({
          title: REMIX_NEEDS_WEB_TITLE,
          message: REMIX_NEEDS_WEB_BODY,
          cancelLabel: 'Not now',
          confirmLabel: 'Open web',
        }).then((openWeb) => {
          if (openWeb) void Linking.openURL(webUrl);
        });
      } else {
        haptic.error();
        showMessageDialog({
          title: 'Could not start remix',
          message: 'This post cannot be opened in the creator tools right now.',
        });
      }
    };
    setRemixingItemId(item.id);
    // `.catch` and `.finally` rather than try…finally, which React Compiler
    // cannot compile.
    void startRemix()
      .catch((error) => {
        haptic.error();
        showErrorDialog('Could not start remix', error);
      })
      .finally(() => setRemixingItemId(null));
  };

  const dismissUndoNotice = (id: string) => setUndoNotice((current) => (current?.id === id ? null : current));

  const applyFeedFeedback = (item: ShowcaseFeedItem | null, eventType: ShowcaseFeedFeedbackType) => {
    if (!item) return;
    if (eventType === 'hide_creator' && (!item.creator.id || item.creator.id === user?.id)) return;

    const target = eventType === 'hide_creator' ? { creatorId: item.creator.id } : { postId: item.id };
    const feedbackTarget: ShowcaseFeedFeedbackTarget = { ...target, feedbackType: eventType };
    const cachedFeeds = queryClient.getQueriesData<InfiniteData<ShowcaseFeedResponse>>({
      queryKey: viewerFeedQueryKey,
    });
    // Where each post sat in each lane, read before the removal: Undo puts it
    // back at the index it left (product decision D7).
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
    const request = buildShowcaseFeedEventRequest(
      { postId: item.id, recommendation: item.recommendation },
      eventType,
      {
        feedSessionId: runtime.feedSessionId,
        algorithmVersion: item.recommendation?.algorithmVersion ?? runtime.algorithmVersion,
        sourceSurface: 'feed',
      },
      { metadata: { surface: 'home-feed' } }
    );

    // Set once the choice itself has failed and its post is back: an Undo
    // waiting on it then has nothing left to say.
    const outcome = { failed: false };
    // Tracked so an Undo waits for this request, and announced by the notice
    // below rather than on success (VoiceOver would say the choice twice).
    void trackFeedFeedbackRequest(feedbackTarget, runtime.api.recordShowcaseFeedEvent(request))
      .catch(() => {
        outcome.failed = true;
        dismissUndoNotice(request.clientEventId);
        if (!user) forgetAnonymousShowcaseFeedRemoval(target);
        cachedFeeds.forEach(([cachedQueryKey, cachedData]) => {
          queryClient.setQueryData(cachedQueryKey, cachedData);
        });
        haptic.error();
        showMessageDialog({
          title: 'Couldn’t update your feed',
          message: 'The post was restored. Check your connection and try again.',
        });
      });

    setUndoNotice({
      id: request.clientEventId,
      message: feedFeedbackUndoMessage(eventType),
      // The post comes back only once the server has taken the choice back; a
      // device with no session takes back its own memory of it instead.
      onUndo: () => {
        void undoFeedFeedback(api, feedbackTarget, { hasSession: Boolean(identityUserId) })
          .then(() => {
            positions.forEach(([cachedQueryKey, lanePositions]) => {
              if (!lanePositions.length) return;
              queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(
                cachedQueryKey,
                (current) => restoreShowcaseFeedItemsToInfiniteData(current, lanePositions)
              );
            });
          })
          .catch(() => {
            if (outcome.failed) return;
            haptic.error();
            showMessageDialog({
              title: 'Couldn’t undo',
              message: eventType === 'hide_creator'
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
    router.push({ pathname: '/auth', params: { returnTo: '/(tabs)/index' } } as never);
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
      // The card's delivery, so the ranker hears the report. Built outside the try: React Compiler skips a
      // component with a conditional inside a try/catch.
      const deliveryId = item.recommendation?.deliveryId;
      const report = {
        reason: 'unsafe_content' as const,
        details: 'Reported from the mobile home feed.',
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
    if (!item?.creator.id || !requireModerationSignIn()) return;
    const creatorId = item.creator.id;
    setFeedbackItem(null);
    void showConfirmDialog({
      title: 'Report this creator?',
      message: 'Our moderation team will review their recent activity.',
      confirmLabel: 'Report user',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await api.reportUser(creatorId, { reason: 'harassment', sourceSurface: 'showcase' });
        void AccessibilityInfo.announceForAccessibility('Creator reported.');
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not report user', error);
      }
    });
  };

  const blockFeedbackUser = (item: ShowcaseFeedItem | null) => {
    if (!item?.creator.id || !requireModerationSignIn()) return;
    const creatorId = item.creator.id;
    setFeedbackItem(null);
    void showConfirmDialog({
      title: 'Block this creator?',
      message: 'You will stop seeing their posts and neither of you can follow the other.',
      confirmLabel: 'Block',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await api.blockUser(creatorId);
        queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
          { queryKey: viewerFeedQueryKey },
          (current) => removeShowcaseFeedItemsFromInfiniteData(current, { creatorId })
        );
        void AccessibilityInfo.announceForAccessibility('Creator blocked.');
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not block user', error);
      }
    });
  };

  // The menu each card's ⋮ opens (`lib/native-menu.ts`), acting on that card's
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
    onReportUser: () => reportFeedbackUser(item),
    onBlockUser: () => blockFeedbackUser(item),
  });

  // The unlock sheet reads a post the way the reel lists it.
  const unlockRemixSheetItem = unlockRemixItem
    ? buildImmersiveShowcaseItems('showcase-feed', [unlockRemixItem])[0] ?? null
    : null;

  // Memoized by React Compiler on everything it reads. The hand-written
  // useCallback it replaces left out the handlers below, so a card could keep
  // calling an old `remixItem` (and the `user` inside it) until a listed value
  // happened to change.
  const renderCard: ListRenderItem<HomeFeedCard> = ({ item: card, index }) => (
    <Reveal index={index} enabled={index < FEED_REVEAL_COUNT} style={{ paddingHorizontal: horizontalPadding }}>
      <HomeFeedCardView
        card={card}
        contentWidth={contentWidth}
        onOpen={(zoom) => openCard(card, { zoom })}
        onReadMore={() => openCard(card, {
          initialPage: 'details',
          initialSection: feedReadMoreSection(card.bodyText, card.item),
        })}
        onFeedbackOpen={() => setFeedbackItem(card.item)}
        feedbackMenu={feedbackMenu(card.item)}
        onCreatorOpen={() => openCreator(card.item)}
        onSave={() => toggleSave({
          postId: card.id,
          isSaved: card.isSaved,
          saveCount: card.item.saveCount,
          // The ranker hears the save as the reel reports its own.
          onSaved: (isSaved) => recordFeedEvent(card.item, isSaved ? 'save' : 'unsave'),
        })}
        onComments={() => {
          if (getHomeFeedCardOpenTarget(card) === 'post') {
            openCard(card, { comments: true });
            return;
          }
          setCommentsReplyToId(null);
          setCommentsItem(card.item);
        }}
        onRemix={() => void remixItem(card.item)}
        remixLoading={remixingItemId === card.item.id}
        onShare={() => void shareItem(card.item)}
        onAssetPress={() => {
          recordResourceOpen(card.item);
          openCard(card, { initialPage: 'details', recordOpen: false });
        }}
        onVideoProgress={(progress, durationMs) => (
          recordAttention(attention.recordProgress(card.item, progress, durationMs))
        )}
      />
    </Reveal>
  );

  return (
    // Tiles on this screen are what the reel grows out of and returns to.
    <FeedVideoActivationContext.Provider value={activationStore}>
    <MediaZoomSurface>
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <FlashList
        keyboardShouldPersistTaps="never"
        // A lane is a new feed, not a mutation of the visible one. Remounting
        // gives it a true native origin; reusing the list preserves iOS's old
        // content offset and can place the first media card above the screen.
        key={`home-feed-${activeChipId}`}
        ref={feedRef}
        data={cards}
        keyExtractor={(card) => card.id}
        renderItem={renderCard}
        getItemType={(card) => card.previewKind}
        drawDistance={SHOWCASE_DRAW_DISTANCE}
        maintainVisibleContentPosition={{ disabled: activeChip.filters.sort !== 'recent' }}
        onStartReached={requestPreviousPage}
        onStartReachedThreshold={0.25}
        onEndReached={requestNextPage}
        onEndReachedThreshold={0.32}
        refreshControl={(
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.faint}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.panelSoft}
          />
        )}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => playbackController.dispatch({ type: 'dragBegin' })}
        onScrollEndDrag={(event) => playbackController.dispatch({ type: 'dragEnd', velocityY: event.nativeEvent.velocity?.y })}
        onMomentumScrollBegin={() => playbackController.dispatch({ type: 'momentumBegin' })}
        onMomentumScrollEnd={() => playbackController.dispatch({ type: 'momentumEnd' })}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        contentInsetAdjustmentBehavior="never"
        // Home cards end in real controls and resource banners. Reserve the
        // raised Create button as well as the pill so the last card can always
        // scroll completely above the navigation hit area.
        contentContainerStyle={{ paddingTop: topInset, paddingBottom: tabBarMetrics.contentBottomPadding + 24 }}
        ListHeaderComponent={(
          <View style={{ gap: 18, paddingTop: 10, paddingBottom: 6 }}>
            <View style={{ paddingHorizontal: horizontalPadding, gap: 12 }}>
              <HomeTopBar
                credits={credits}
                onMenuPress={() => setMenuVisible(true)}
                onSearchPress={() => setSearchVisible(true)}
              />
              {/* What became of the guest credits a sign-in carried over, under
                  the balance it changed. It showed on Pricing alone, so a
                  restart before a visit there lost the only word that paid
                  credits had not arrived (02-8). Draws nothing without one. */}
              <GuestMergeBanner />
            </View>

            <HomeShelf
              items={shelfItems}
              isLoading={shelfQuery.isPending}
              offerFreeToTry={!user}
              horizontalPadding={horizontalPadding}
              contentWidth={contentWidth}
              activeRenders={activeGenerationCount}
              pendingId={remixingItemId}
              // One remix at a time: a second tap while the first is opening
              // would stack a second creator over it.
              onMake={(creation) => {
                if (remixingItemId) return;
                remixItem(creation.post);
              }}
            />

            <View style={{ paddingHorizontal: horizontalPadding }}>
              <OnboardingResumeCard />
            </View>

            <FeedChips
              activeChipId={activeChipId}
              horizontalPadding={horizontalPadding}
              onSelect={selectChip}
            />
          </View>
        )}
        ListEmptyComponent={isFirstLoad ? (
          <View style={{ paddingHorizontal: horizontalPadding }}>
            <HomeFeedSkeleton width={contentWidth} />
          </View>
        ) : (
          <View style={{ paddingHorizontal: horizontalPadding, paddingTop: 32 }}>
            {feedQuery.isError ? (
              <View style={{ gap: 12 }}>
                <StatusBlock
                  tone="danger"
                  title="Your feed is unavailable"
                  body="We could not load posts right now. Pull down to try again."
                />
                <SecondaryButton label="Retry" onPress={() => void feedQuery.refetch()} />
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                <StatusBlock
                  tone="info"
                  title="Nothing here yet"
                  body="New community posts will appear here as creators publish them."
                />
                <SecondaryButton
                  label="Share the first post"
                  onPress={() => router.push('/post/new' as never)}
                />
              </View>
            )}
          </View>
        )}
        ListFooterComponent={feedQuery.isFetchingNextPage ? (
          <View style={{ paddingVertical: 20, alignItems: 'center' }}>
            <ActivityIndicator color={theme.colors.faint} />
          </View>
        ) : feedQuery.isFetchNextPageError ? (
          <FeedLoadMoreErrorFooter onRetry={retryNextPage} />
        ) : hasItems && !isFirstLoad && !pullRefreshing && feedQuery.hasNextPage === false ? (
          // A ranked lane stops at 60 posts; the list used to just end.
          <FeedEndFooter
            message={activeChipId === 'for-you' ? "You're all caught up." : `You've reached the end of ${activeChip.label}.`}
          />
        ) : null}
      />

      <TopScrim topInset={topInset} />

      <NewPostsPill
        visible={newPosts.hasNewer}
        onPress={showNewPosts}
        topOffset={topInset + HOME_TOP_BAR_BOTTOM + appTheme.spacing.compact}
      />

      <FeedUndoNotice
        notice={undoNotice}
        onDismiss={dismissUndoNotice}
        bottomOffset={tabBarMetrics.contentBottomPadding}
      />

      <ExploreSearchOverlay api={api} visible={searchVisible} onClose={() => setSearchVisible(false)} />

      <FeedFeedbackSheet
        creatorLabel={feedbackItem?.creator.username || feedbackItem?.creator.name || 'this creator'}
        hideLabel={hideCreatorLabel(feedbackItem?.creator ?? {})}
        canHideCreator={canHideFeedCreator(feedbackItem?.creator.id, user?.id)}
        viewerIsOwner={isOwnFeedPost(feedbackItem?.creator.id, user?.id)}
        onBlockUser={() => blockFeedbackUser(feedbackItem)}
        onClose={() => setFeedbackItem(null)}
        onHideCreator={() => applyFeedFeedback(feedbackItem, 'hide_creator')}
        onNotInterested={() => applyFeedFeedback(feedbackItem, 'not_interested')}
        onReportContent={() => reportFeedbackContent(feedbackItem)}
        onReportUser={() => reportFeedbackUser(feedbackItem)}
        postTitle={feedbackItem?.title || 'this post'}
        viewerKind={user ? 'member' : 'guest'}
        visible={Boolean(feedbackItem)}
      />

      {commentsItem ? (
        <CommentsSheet
          key={commentsItem.id}
          authReturnTo="/(tabs)/index"
          postId={commentsItem.id}
          postCreatorId={commentsItem.creator.id}
          postTitle={commentsItem.title}
          commentCount={commentsItem.commentCount}
          deliveryId={commentsItem.recommendation?.deliveryId ?? null}
          initialReplyToId={commentsReplyToId}
          onClose={() => {
            setCommentsReplyToId(null);
            setCommentsItem(null);
          }}
          visible
        />
      ) : null}

      <UnlockRemixPrompt
        authReturnTo={unlockRemixItem ? `/post/${unlockRemixItem.id}` : undefined}
        bottomInset={bottomInset}
        item={unlockRemixSheetItem}
        onClose={() => setUnlockRemixOpen(false)}
        onUnlocked={() => {
          if (unlockRemixItem) remixItem(unlockRemixItem, { unlocked: true });
        }}
        visible={unlockRemixOpen}
      />

      <HomeSideMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        user={user}
        profile={profileQuery.data}
        credits={credits}
        totalSalesUsdCents={totalSalesUsdCents}
        onSignOut={signOut}
      />
    </View>
    </MediaZoomSurface>
    </FeedVideoActivationContext.Provider>
  );
}

function HomeTopBar({
  credits,
  onMenuPress,
  onSearchPress,
}: {
  credits: number | null;
  onMenuPress: () => void;
  onSearchPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <TopBarControl
        accessibilityLabel={WORKSPACE_SIDE_MENU_LABEL}
        onPress={() => {
          haptic.select();
          onMenuPress();
        }}
        style={{ width: 48 }}
      >
        <WorkspaceSideMenuGlyph size={appTheme.icon.default} color={theme.colors.text} />
      </TopBarControl>

      {/* The title slot is deliberately empty. Toolbars: "Don't title windows
          with your app name … it doesn't work well as a title", and Branding
          agrees — "people seldom need to be reminded which app they're using,
          and it's usually better to use the space to give people valuable
          information and controls." The brand still opens the app, on the
          onboarding and sign-in screens the chapter endorses. */}
      <View style={{ flex: 1, minWidth: 0 }} />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        {/* Explore's search, a tap from the feed (product decision E1). The
            overlay focuses its field as it opens. */}
        <TopBarControl
          accessibilityLabel="Search creators, posts, and recipes"
          onPress={() => {
            haptic.light();
            onSearchPress();
          }}
          style={{ width: 48 }}
        >
          <Search size={appTheme.icon.default} color={theme.colors.text} />
        </TopBarControl>
        <TopBarControl
          accessibilityLabel="Open credits"
          onPress={() => {
            haptic.light();
            router.push('/pricing' as never);
          }}
          style={{ minWidth: 68, paddingHorizontal: 10 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Crown size={appTheme.icon.sm} color={theme.colors.commerce} fill={`${theme.colors.commerce}33`} />
            {/* A dash until the balance has loaded: a 0 there reads as an empty
                balance to someone who has credits. */}
            <Text style={{ color: credits === null ? theme.colors.muted : theme.colors.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{formatCreditBalance(credits)}</Text>
            <Plus size={14} color={theme.colors.primary} />
          </View>
        </TopBarControl>
      </View>
    </View>
  );
}

/** Round top-bar control: springs down under the thumb instead of dimming. */
function TopBarControl({
  accessibilityLabel,
  children,
  onPress,
  style,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  onPress: () => void;
  style?: ViewStyle;
}) {
  const theme = useAppTheme();
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedControl });

  return (
    <MotionView style={motion.animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={[
          {
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 24,
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.panel,
          },
          style,
        ]}
      >
        {children}
      </Pressable>
    </MotionView>
  );
}

function FeedChips({
  activeChipId,
  horizontalPadding,
  onSelect,
}: {
  activeChipId: HomeFeedChipId;
  horizontalPadding: number;
  onSelect: (chipId: HomeFeedChipId) => void;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 18, paddingHorizontal: horizontalPadding }}>
      {HOME_FEED_CHIPS.map((chip) => {
        const active = chip.id === activeChipId;
        return (
          <Pressable
            key={chip.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={chip.label}
            onPress={() => onSelect(chip.id)}
            style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', gap: 6, opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: active ? theme.colors.text : theme.colors.faint, fontSize: 15, fontWeight: '800' }}>
              {chip.label}
            </Text>
            <View
              style={{
                height: 2,
                borderRadius: 1,
                backgroundColor: active ? theme.colors.primary : 'transparent',
              }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
