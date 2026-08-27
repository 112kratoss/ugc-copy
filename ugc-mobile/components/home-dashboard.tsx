import { FlashList, type FlashListRef, type ListRenderItem, type ViewToken } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useIsFocused, useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import {
  Bell,
  Crown,
  ImageIcon,
  Play,
  Plus,
  Rocket,
  Sparkles,
  WandSparkles,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  Share,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CommentsSheet } from '@/components/comments-sheet';
import { FeedFeedbackSheet } from '@/components/feed-feedback-sheet';
import { FeedLoadMoreErrorFooter } from '@/components/feed-pagination-footer';
import { HomeFeedCardView } from '@/components/home-feed-card';
import { HomeSideMenu } from '@/components/home-side-menu';
import { WorkspaceSideMenuGlyph, WORKSPACE_SIDE_MENU_LABEL } from '@/components/workspace-side-menu-gesture-layer';
import { OnboardingResumeCard } from '@/components/onboarding-resume-card';
import { Reveal } from '@/components/reveal';
import { HomeFeedSkeleton } from '@/components/skeleton';
import { TopScrim } from '@/components/top-scrim';
import { SecondaryButton, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { REMIX_NEEDS_WEB_BODY, REMIX_NEEDS_WEB_TITLE } from '@/lib/viewer-actions';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
import {
  HOME_FEED_CHIPS,
  HOME_SLIDE_INTERVAL_MS,
  HOME_SLIDE_RESUME_DELAY_MS,
  advanceHomeSlide,
  buildHomeFeedCards,
  buildLoopedHomeSlides,
  foldHomeSlideOffset,
  getHomeFeedCardOpenTarget,
  getHomeFeedSlides,
  getHomeSlideIndexFromOffset,
  getHomeSlideOffset,
  getHomeSlidePassWidth,
  getInitialHomeSlideIndex,
  pickHomeSlidePreviews,
  shouldAutoAdvanceHomeSlides,
  type HomeFeedCard,
  type HomeFeedChipId,
  type HomeFeedSlide,
  type HomeLoopedSlide,
} from '@/lib/home-feed-view-model';
import { getOwnerPostSalesSummary } from '@/lib/home-view-model';
import { immersiveViewerHref, textPostViewerHref } from '@/lib/immersive-preview-view-model';
import { SHOWCASE_DRAW_DISTANCE, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS } from '@/lib/media-performance';
import { haptic } from '@/lib/haptics';
import { MotionView, usePressMotion, useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { selectActiveShowcaseVideoIds } from '@/lib/showcase-display';
import {
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
  SHOWCASE_FEED_STALE_TIME_MS,
  createShowcaseFeedQueryKey,
  createShowcaseFeedViewerQueryKey,
  createShowcasePostQueryKey,
  flattenShowcaseFeedPages,
  getNextShowcaseFeedPageParam,
  getShowcaseFeedPageParams,
  getShowcaseFeedSessionContext,
  type ShowcaseFeedPageParam,
} from '@/lib/showcase-feed-query';
import { formatCreditAmount } from '@/lib/pricing';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import type {
  ShowcaseFeedEventType,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';
import { buildShareUrl, getNativeRemixCreateHref } from '@/lib/viewer-actions';
import { useShowcaseSaveMutation } from '@/lib/use-showcase-save-mutation';

const DASHBOARD_COLORS = {
  background: appTheme.colors.background,
  surface: appTheme.colors.panel,
  surfaceRaised: appTheme.colors.panelSoft,
  border: appTheme.colors.borderSubtle,
  borderStrong: appTheme.colors.border,
  text: appTheme.colors.text,
  muted: appTheme.colors.muted,
  faint: appTheme.colors.faint,
  coral: appTheme.colors.primary,
  coralSoft: appTheme.colors.pressed,
} as const;

const TOOL_PREVIEW_IMAGES = {
  kingdom: require('../assets/images/home-previews/image.jpg'),
  city: require('../assets/images/home-previews/video.jpg'),
  runner: require('../assets/images/home-previews/motion.jpg'),
} as const;

const LOAD_MORE_COOLDOWN_MS = 800;
const TOP_SLIDE_HEIGHT = 170;
// Only the cards that can be on screen when a lane first lands rise into
// place; everything past that mounts plain while scrolling.
const FEED_REVEAL_COUNT = 6;

export function HomeDashboard() {
  const {
    comments: requestedComments,
    replyTo: requestedReplyTo,
  } = useLocalSearchParams<{
    comments?: string | string[];
    replyTo?: string | string[];
  }>();
  // `user` keeps gating the community actions on this screen (remix, save,
  // follow). Only the viewer's own creations strip reads `identityUserId`, so a
  // guest can find what they just generated.
  const { user, identityUserId, api, credits, signOut } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 390;
  const reduceMotion = useReducedMotion();
  const feedRef = useRef<FlashListRef<HomeFeedCard>>(null);
  useScrollToTop(feedRef);
  const horizontalPadding = isCompact ? 15 : 18;
  const contentWidth = pageWidth - horizontalPadding * 2;
  const slideWidth = Math.round(contentWidth * 0.82);

  const [menuVisible, setMenuVisible] = useState(false);
  const [activeChipId, setActiveChipId] = useState<HomeFeedChipId>('for-you');
  const [activeVideoIds, setActiveVideoIds] = useState<string[]>([]);
  const [feedbackItem, setFeedbackItem] = useState<ShowcaseFeedItem | null>(null);
  const [commentsItem, setCommentsItem] = useState<ShowcaseFeedItem | null>(null);
  const [commentsReplyToId, setCommentsReplyToId] = useState<string | null>(null);
  // The remix request runs before we know where it lands, so the tapped card
  // owns the spinner until navigation takes over.
  const [remixingItemId, setRemixingItemId] = useState<string | null>(null);
  // Held by the list, not the card: FlashList recycles card views, and local
  // expansion state would follow a recycled view onto an unrelated post.
  const [expandedBodyIds, setExpandedBodyIds] = useState<string[]>([]);
  const visibleActiveVideoIds = isFocused ? activeVideoIds : [];

  const activeChip = HOME_FEED_CHIPS.find((chip) => chip.id === activeChipId) ?? HOME_FEED_CHIPS[0];
  const queryKey = useMemo(
    () => createShowcaseFeedQueryKey(activeChip.filters, user?.id),
    [activeChip, user?.id]
  );
  const viewerFeedQueryKey = useMemo(() => createShowcaseFeedViewerQueryKey(user?.id), [user?.id]);

  const generationsQuery = useQuery({
    queryKey: ['home-generations', identityUserId],
    enabled: Boolean(identityUserId),
    queryFn: () => api.listGenerations(true, { limit: 12 }),
    staleTime: 1000 * 60,
  });

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.getProfile(),
    staleTime: 1000 * 60 * 5,
  });

  const sellerPostsQuery = useQuery({
    queryKey: ['owner-posts-sales-summary', user?.id],
    enabled: Boolean(user && menuVisible),
    queryFn: () => api.listOwnerPosts({ includeArchived: true, includeSummary: true, limit: 1, visibility: 'all' }),
    staleTime: 1000 * 60 * 2,
  });

  useEffect(() => {
    if (!isFocused || !identityUserId || generationsQuery.isFetching || !generationsQuery.isStale) return;
    void generationsQuery.refetch();
  }, [generationsQuery.isFetching, generationsQuery.isStale, isFocused, identityUserId]);

  useEffect(() => {
    if (!isFocused || !user || !menuVisible || sellerPostsQuery.isFetching || !sellerPostsQuery.isStale) return;
    void sellerPostsQuery.refetch();
  }, [isFocused, menuVisible, sellerPostsQuery.isFetching, sellerPostsQuery.isStale, user?.id]);

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
        // The server only accepts the showcase surfaces; the metadata tag is how
        // home-originated events stay separable in the ranker's telemetry.
        sourceSurface: 'showcase',
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

  const onPlaybackViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<HomeFeedCard>> }) => {
    const visibleItems = viewableItems
      .filter((token) => token.isViewable && token.item)
      .map((token) => token.item.item);
    const nextVideoIds = selectActiveShowcaseVideoIds(visibleItems, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS);
    setActiveVideoIds((current) => (
      current.length === nextVideoIds.length && current.every((id, index) => id === nextVideoIds[index])
        ? current
        : nextVideoIds
    ));
  }, []);

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

  const viewabilityConfigCallbackPairs = useRef([
    {
      viewabilityConfig: SHOWCASE_PLAYBACK_VIEWABILITY,
      onViewableItemsChanged: onPlaybackViewableItemsChanged,
    },
    {
      viewabilityConfig: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY,
      onViewableItemsChanged: onQualifiedViewableItemsChanged,
    },
  ]).current;

  const feedQuery = useInfiniteQuery({
    queryKey,
    initialPageParam: { offset: 0 } as ShowcaseFeedPageParam,
    queryFn: ({ pageParam }) => api.getShowcaseFeed(getShowcaseFeedPageParams({
      ...activeChip.filters,
      ...pageParam,
    })),
    getNextPageParam: getNextShowcaseFeedPageParam,
    staleTime: SHOWCASE_FEED_STALE_TIME_MS,
  });

  const feedSession = useMemo(
    () => getShowcaseFeedSessionContext(feedQuery.data?.pages),
    [feedQuery.data?.pages]
  );
  feedEventRuntimeRef.current = {
    api,
    isFocused,
    feedSessionId: feedSession.feedSessionId,
    algorithmVersion: feedSession.algorithmVersion,
  };

  const feedItems = useMemo(() => {
    const flattened = flattenShowcaseFeedPages(feedQuery.data?.pages);
    return user ? flattened : filterAnonymousSessionShowcaseFeedItems(flattened);
  }, [feedQuery.data?.pages, user]);
  const feedPageCount = feedQuery.data?.pages.length ?? 0;
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
  const slidePreviews = useMemo(() => pickHomeSlidePreviews(cards), [cards]);
  const hasItems = cards.length > 0;
  const isFirstLoad = feedQuery.isLoading && !hasItems;
  // Bound to the viewer's own pull, never to an incidental refetch. On iOS,
  // `refreshing` flipping true without a drag behind it runs
  // RCTRefreshControl.beginRefreshingProgrammatically, which shifts the scroll
  // view down by the control's height from wherever it currently sits — and the
  // matching end only restores that offset when the list is already at the top.
  // Anywhere else the shift is kept, so every background refetch left the feed
  // permanently pushed down by another notch.
  const [pullRefreshing, setPullRefreshing] = useState(false);

  const { toggleSave } = useShowcaseSaveMutation();

  const rawGenerations = generationsQuery.data?.generations ?? [];
  const activeGenerationCount = rawGenerations
    .filter((item) => ['waiting', 'processing', 'starting'].includes(item.status)).length;

  const salesSummary = useMemo(
    () => sellerPostsQuery.data?.summary ?? getOwnerPostSalesSummary(sellerPostsQuery.data?.posts),
    [sellerPostsQuery.data]
  );

  const displayName =
    profileQuery.data?.displayName?.trim() ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'Creator';

  const requestNextPage = () => {
    const now = Date.now();
    if (!canRequestNextFeedPage({
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
      return { pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) };
    });
    void feedQuery.refetch().finally(() => setPullRefreshing(false));
  };

  const selectChip = (chipId: HomeFeedChipId) => {
    if (chipId === activeChipId) return;
    qualifiedImpressionsRef.current.clear();
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    setActiveChipId(chipId);
  };

  const openPost = (item: ShowcaseFeedItem) => {
    recordFeedEvent(item, 'open');
    queryClient.setQueryData<ShowcasePostResponse>(createShowcasePostQueryKey(item.id, user?.id), {
      success: true,
      item,
    });
    router.push(immersiveViewerHref({
      source: 'showcase-feed',
      initialId: item.id,
      feedSessionId: feedSession.feedSessionId,
      algorithmVersion: item.recommendation?.algorithmVersion ?? feedSession.algorithmVersion,
    }) as never);
  };

  /**
   * The immersive viewer is the showcase reel — a vertical swipe there pages
   * through other showcase posts — so a written post opens its own screen
   * rather than being dropped into a reel of other people's media.
   */
  const openCard = (card: HomeFeedCard, options: { comments?: boolean } = {}) => {
    if (getHomeFeedCardOpenTarget(card) === 'post') {
      recordFeedEvent(card.item, 'open');
      // Seeded so the post screen paints from cache instead of refetching.
      queryClient.setQueryData<ShowcasePostResponse>(
        createShowcasePostQueryKey(card.item.id, user?.id),
        { success: true, item: card.item }
      );
      router.push(textPostViewerHref({
        comments: options.comments,
        postId: card.item.id,
      }) as never);
      return;
    }
    openPost(card.item);
  };

  const toggleBodyExpanded = (postId: string) => {
    setExpandedBodyIds((current) => (current.includes(postId)
      ? current.filter((id) => id !== postId)
      : [...current, postId]));
  };

  const openCreator = (item: ShowcaseFeedItem) => {
    const username = item.creator.username?.trim();
    if (!username) return;
    router.push(`/creators/${encodeURIComponent(username)}` as never);
  };

  const shareItem = async (item: ShowcaseFeedItem) => {
    const url = buildShareUrl(env.siteUrl, `/showcase/${item.id}`, 'feed');
    try {
      const result = await Share.share({ title: item.title, message: `${item.title}\n${url}`, url });
      if (result.action === Share.sharedAction) {
        void api.shareShowcasePost(item.id, { sourceSurface: 'feed' }).catch(() => null);
        recordFeedEvent(item, 'share');
      }
    } catch {
      // A dismissed share sheet is not an error worth surfacing.
    }
  };

  const remixItem = async (item: ShowcaseFeedItem) => {
    if (!user) {
      // The post page is where the Remix button lives, so land them on it
      // rather than the tab root they started from.
      router.push({ pathname: '/auth', params: { returnTo: `/post/${item.id}` } } as never);
      return;
    }
    setRemixingItemId(item.id);
    try {
      const result = await api.remixShowcasePost(item.id);
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
        Alert.alert(REMIX_NEEDS_WEB_TITLE, REMIX_NEEDS_WEB_BODY, [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open web', onPress: () => { void Linking.openURL(webUrl); } },
        ]);
      } else {
        haptic.error();
        Alert.alert('Could not start remix', 'This post cannot be opened in the creator tools right now.');
      }
    } catch (error) {
      haptic.error();
      Alert.alert('Could not start remix', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setRemixingItemId(null);
    }
  };

  const applyFeedFeedback = (eventType: 'not_interested' | 'hide_creator') => {
    const item = feedbackItem;
    if (!item) return;
    if (eventType === 'hide_creator' && (!item.creator.id || item.creator.id === user?.id)) return;

    const target = eventType === 'hide_creator' ? { creatorId: item.creator.id } : { postId: item.id };
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
    const request = buildShowcaseFeedEventRequest(
      { postId: item.id, recommendation: item.recommendation },
      eventType,
      {
        feedSessionId: runtime.feedSessionId,
        algorithmVersion: item.recommendation?.algorithmVersion ?? runtime.algorithmVersion,
        sourceSurface: 'showcase',
      },
      { metadata: { surface: 'home-feed' } }
    );

    void runtime.api.recordShowcaseFeedEvent(request)
      .then(() => AccessibilityInfo.announceForAccessibility(
        eventType === 'hide_creator' ? 'Creator hidden from your feed.' : 'Post removed. Your feed will adapt.'
      ))
      .catch(() => {
        if (!user) forgetAnonymousShowcaseFeedRemoval(target);
        cachedFeeds.forEach(([cachedQueryKey, cachedData]) => {
          queryClient.setQueryData(cachedQueryKey, cachedData);
        });
        haptic.error();
        Alert.alert('Couldn’t update your feed', 'The post was restored. Check your connection and try again.');
      });
  };

  const requireModerationSignIn = () => {
    if (user) return true;
    setFeedbackItem(null);
    router.push({ pathname: '/auth', params: { returnTo: '/(tabs)/index' } } as never);
    return false;
  };

  const reportFeedbackContent = () => {
    const item = feedbackItem;
    if (!item || !requireModerationSignIn()) return;
    setFeedbackItem(null);
    Alert.alert(
      'Report content?',
      'Magicbooklet will send this post to the moderation team for a safety review.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report content',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.reportPost(item.id, {
                reason: 'unsafe_content',
                details: 'Reported from the mobile home feed.',
              });
              queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
                { queryKey: viewerFeedQueryKey },
                (current) => removeShowcaseFeedItemsFromInfiniteData(current, { postId: item.id })
              );
              void AccessibilityInfo.announceForAccessibility('Content reported and removed from your feed.');
            } catch (error) {
              haptic.error();
              Alert.alert('Could not report content', error instanceof Error ? error.message : 'Please try again.');
            }
          },
        },
      ]
    );
  };

  const reportFeedbackUser = () => {
    const item = feedbackItem;
    if (!item?.creator.id || !requireModerationSignIn()) return;
    const creatorId = item.creator.id;
    setFeedbackItem(null);
    Alert.alert(
      'Report this creator?',
      'Our moderation team will review their recent activity.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report user',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.reportUser(creatorId, { reason: 'harassment', sourceSurface: 'showcase' });
              void AccessibilityInfo.announceForAccessibility('Creator reported.');
            } catch (error) {
              haptic.error();
              Alert.alert('Could not report user', error instanceof Error ? error.message : 'Please try again.');
            }
          },
        },
      ]
    );
  };

  const blockFeedbackUser = () => {
    const item = feedbackItem;
    if (!item?.creator.id || !requireModerationSignIn()) return;
    const creatorId = item.creator.id;
    setFeedbackItem(null);
    Alert.alert(
      'Block this creator?',
      'You will stop seeing their posts and neither of you can follow the other.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.blockUser(creatorId);
              queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
                { queryKey: viewerFeedQueryKey },
                (current) => removeShowcaseFeedItemsFromInfiniteData(current, { creatorId })
              );
              void AccessibilityInfo.announceForAccessibility('Creator blocked.');
            } catch (error) {
              haptic.error();
              Alert.alert('Could not block user', error instanceof Error ? error.message : 'Please try again.');
            }
          },
        },
      ]
    );
  };

  const renderCard: ListRenderItem<HomeFeedCard> = useCallback(({ item: card, index }) => (
    <Reveal index={index} enabled={index < FEED_REVEAL_COUNT} style={{ paddingHorizontal: horizontalPadding, paddingBottom: 14 }}>
      <HomeFeedCardView
        card={card}
        contentWidth={contentWidth}
        showActiveVideo={visibleActiveVideoIds.includes(card.id)}
        bodyExpanded={expandedBodyIds.includes(card.id)}
        onOpen={() => openCard(card)}
        onToggleBody={() => toggleBodyExpanded(card.id)}
        onFeedbackOpen={() => setFeedbackItem(card.item)}
        onCreatorOpen={() => openCreator(card.item)}
        onSave={() => toggleSave({ postId: card.id, isSaved: card.isSaved, saveCount: card.item.saveCount })}
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
      />
    </Reveal>
  ), [contentWidth, expandedBodyIds, horizontalPadding, remixingItemId, visibleActiveVideoIds, toggleSave]);

  return (
    <View style={{ flex: 1, backgroundColor: DASHBOARD_COLORS.background }}>
      <FlashList
        // A lane is a new feed, not a mutation of the visible one. Remounting
        // gives it a true native origin; reusing the list preserves iOS's old
        // content offset and can place the first media card above the screen.
        key={`home-feed-${activeChipId}`}
        ref={feedRef}
        data={cards}
        keyExtractor={(card) => card.id}
        renderItem={renderCard}
        getItemType={(card) => card.previewKind}
        extraData={visibleActiveVideoIds}
        drawDistance={SHOWCASE_DRAW_DISTANCE}
        maintainVisibleContentPosition={{ disabled: true }}
        onEndReached={requestNextPage}
        onEndReachedThreshold={0.32}
        refreshControl={(
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={handleRefresh}
            tintColor={DASHBOARD_COLORS.faint}
            colors={[DASHBOARD_COLORS.coral]}
            progressBackgroundColor={DASHBOARD_COLORS.surfaceRaised}
          />
        )}
        showsVerticalScrollIndicator={false}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: topInset, paddingBottom: tabBarMetrics.contentBottomOverlapPadding + 24 }}
        ListHeaderComponent={(
          <View style={{ gap: 18, paddingTop: 10, paddingBottom: 6 }}>
            <View style={{ paddingHorizontal: horizontalPadding }}>
              <HomeTopBar credits={credits ?? 0} onMenuPress={() => setMenuVisible(true)} />
            </View>

            <TopSlider
              activeGenerationCount={activeGenerationCount}
              displayName={displayName}
              horizontalPadding={horizontalPadding}
              isFocused={isFocused}
              reduceMotion={reduceMotion}
              signedIn={Boolean(user)}
              slidePreviews={slidePreviews}
              slideWidth={slideWidth}
            />

            <View style={{ paddingHorizontal: horizontalPadding }}>
              <OnboardingResumeCard compact />
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
            <ActivityIndicator color={DASHBOARD_COLORS.faint} />
          </View>
        ) : feedQuery.isFetchNextPageError ? (
          <FeedLoadMoreErrorFooter onRetry={retryNextPage} />
        ) : null}
      />

      <TopScrim topInset={topInset} />

      <FeedFeedbackSheet
        creatorLabel={feedbackItem?.creator.username || feedbackItem?.creator.name || 'this creator'}
        hideCreatorDisabled={!feedbackItem?.creator.id || feedbackItem.creator.id === user?.id}
        onBlockUser={blockFeedbackUser}
        onClose={() => setFeedbackItem(null)}
        onHideCreator={() => applyFeedFeedback('hide_creator')}
        onNotInterested={() => applyFeedFeedback('not_interested')}
        onReportContent={reportFeedbackContent}
        onReportUser={reportFeedbackUser}
        postTitle={feedbackItem?.title || 'this post'}
        sessionOnly={!user}
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
          initialReplyToId={commentsReplyToId}
          onClose={() => {
            setCommentsReplyToId(null);
            setCommentsItem(null);
          }}
          visible
        />
      ) : null}

      <HomeSideMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        user={user}
        profile={profileQuery.data}
        credits={credits ?? 0}
        totalSalesUsdCents={salesSummary.earningsUsdCents}
        totalSalesLoading={Boolean(user) && sellerPostsQuery.isLoading}
        onSignOut={signOut}
      />
    </View>
  );
}

function HomeTopBar({ credits, onMenuPress }: { credits: number; onMenuPress: () => void }) {
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
        <WorkspaceSideMenuGlyph size={appTheme.icon.default} color={DASHBOARD_COLORS.text} />
      </TopBarControl>

      {/* The title slot is deliberately empty. Toolbars: "Don't title windows
          with your app name … it doesn't work well as a title", and Branding
          agrees — "people seldom need to be reminded which app they're using,
          and it's usually better to use the space to give people valuable
          information and controls." The brand still opens the app, on the
          onboarding and sign-in screens the chapter endorses. */}
      <View style={{ flex: 1, minWidth: 0 }} />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <TopBarControl
          accessibilityLabel="Open credits"
          onPress={() => {
            haptic.light();
            router.push('/pricing' as never);
          }}
          style={{ minWidth: 68, paddingHorizontal: 10 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Crown size={appTheme.icon.sm} color={appTheme.colors.commerce} fill={`${appTheme.colors.commerce}33`} />
            <Text style={{ color: DASHBOARD_COLORS.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{formatCreditAmount(credits)}</Text>
            <Plus size={14} color={DASHBOARD_COLORS.coral} />
          </View>
        </TopBarControl>

        <TopBarControl
          accessibilityLabel="Open alerts"
          onPress={() => {
            haptic.light();
            router.push('/studio' as never);
          }}
          style={{ width: 48 }}
        >
          <Bell size={appTheme.icon.default} color={DASHBOARD_COLORS.text} />
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
            borderColor: DASHBOARD_COLORS.border,
            backgroundColor: DASHBOARD_COLORS.surface,
          },
          style,
        ]}
      >
        {children}
      </Pressable>
    </MotionView>
  );
}

/**
 * Data-driven so promotional slides can join the rotation later without
 * touching the feed itself.
 */
function TopSlider({
  activeGenerationCount,
  displayName,
  horizontalPadding,
  isFocused,
  reduceMotion,
  signedIn,
  slidePreviews,
  slideWidth,
}: {
  activeGenerationCount: number;
  displayName: string;
  horizontalPadding: number;
  isFocused: boolean;
  reduceMotion: boolean;
  signedIn: boolean;
  slidePreviews: Partial<Record<ToolAccent, string>>;
  slideWidth: number;
}) {
  const slides = useMemo(() => getHomeFeedSlides(), []);
  // Matching the gap to the screen gutter is what squares the rail's edges.
  // With a smaller gap the previous card's right edge lands `gutter - gap`
  // inside the screen, leaving a sliver of image bleeding off the left that
  // reads as a clipping bug rather than a peek. Equal values park it exactly on
  // the edge, so only the next card peeks — on the side you are scrolling to.
  const gap = horizontalPadding;
  // Laid out three times, with the carousel parked in the middle pass, so it
  // can travel off either end into more of the same rail rather than reversing.
  const loopedSlides = useMemo(() => buildLoopedHomeSlides(slides), [slides]);
  const initialIndex = getInitialHomeSlideIndex(slides.length);
  const listRef = useRef<FlashListRef<HomeLoopedSlide>>(null);
  // The timer's own position. Held in a ref so re-arming it on every tick
  // would not restart the interval mid-cycle. It starts at 0 — the list's
  // actual resting place — and only claims the middle pass once the scroll
  // that gets it there has actually been issued.
  const slideIndexRef = useRef(0);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const centerFrameRef = useRef<number | null>(null);
  const [isInteracting, setIsInteracting] = useState(false);
  // The dots' own copy of the position. The ref above stays the timer's, so
  // this render never restarts the interval — it is not in that effect's deps.
  const [pageIndex, setPageIndex] = useState(0);

  const autoAdvance = shouldAutoAdvanceHomeSlides({
    slideCount: slides.length,
    isFocused,
    isInteracting,
    reduceMotion,
  });

  useEffect(() => {
    if (!autoAdvance) return;

    const timer = setInterval(() => {
      const nextIndex = advanceHomeSlide(slideIndexRef.current, slides.length);
      slideIndexRef.current = nextIndex;
      setPageIndex(nextIndex % slides.length);
      listRef.current?.scrollToOffset({
        offset: getHomeSlideOffset(nextIndex, slideWidth, gap),
        animated: true,
      });
    }, HOME_SLIDE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [autoAdvance, gap, slideWidth, slides.length]);

  // Pending work must not outlive the slider: the resume would call setState on
  // an unmounted component after a tab switch, and the centering frame would
  // scroll a list that is gone.
  useEffect(() => () => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    if (centerFrameRef.current !== null) cancelAnimationFrame(centerFrameRef.current);
  }, []);

  /**
   * Slides the rail to the middle pass as soon as the list has drawn, so a
   * backward swipe has somewhere to go from the very first card.
   * `initialScrollIndex` is not used for this: FlashList ignored it here, which
   * left the ref claiming the middle pass while the list sat at 0 — the next
   * tick would then have lurched several slides at once. The index is only
   * updated alongside the scroll that moves it, so if this never runs the
   * rotation still starts from a truthful 0 and the first settle recenters it.
   */
  const centerOnLoad = useCallback(() => {
    if (initialIndex === 0) return;

    // Deferred a frame: at `onLoad` the rows have drawn but the scroll metrics
    // have not settled, and a scroll issued synchronously here is dropped.
    centerFrameRef.current = requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({
        offset: getHomeSlideOffset(initialIndex, slideWidth, gap),
        animated: false,
      });
      slideIndexRef.current = initialIndex;
      setPageIndex(initialIndex % slides.length);
    });
  }, [gap, initialIndex, slideWidth, slides.length]);

  const scheduleResume = useCallback(() => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => setIsInteracting(false), HOME_SLIDE_RESUME_DELAY_MS);
  }, []);

  const holdRotation = useCallback(() => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    setIsInteracting(true);
  }, []);

  /**
   * Runs once the scroll has come to rest — the timer's own scrolls included.
   * Whatever pass it landed in, the offset is translated back into the middle
   * pass by whole pass-widths, which maps every visible pixel onto its own
   * copy. Nothing moves on screen; it just restores the runway needed to keep
   * going in either direction.
   */
  const settleRotation = useCallback((offset: number) => {
    const passWidth = getHomeSlidePassWidth(slides.length, slideWidth, gap);
    const foldedOffset = foldHomeSlideOffset(offset, passWidth);

    if (foldedOffset !== offset) {
      listRef.current?.scrollToOffset({ offset: foldedOffset, animated: false });
    }

    slideIndexRef.current = getHomeSlideIndexFromOffset(foldedOffset, slideWidth, gap, loopedSlides.length);
    setPageIndex(slideIndexRef.current % slides.length);
    scheduleResume();
  }, [gap, loopedSlides.length, scheduleResume, slideWidth, slides.length]);

  return (
    <View style={{ gap: 10 }}>
    <FlashList
      ref={listRef}
      data={loopedSlides}
      horizontal
      keyExtractor={(item) => item.key}
      // Recentering jumps a full pass, so the list re-renders its window on
      // arrival. Typing the rows lets it reuse the view it already had for the
      // same kind of slide instead of rebuilding a different one mid-jump.
      getItemType={(item) => item.slide.kind}
      // Keeps a full pass mounted beyond each edge, so the window a recentering
      // teleport lands on is always already drawn. One slide of headroom is not
      // enough: the teleport moves a whole pass, and any card it reveals that
      // was not mounted flashes in a frame late — a visible jerk. The rail is
      // a dozen lightweight cards, so mounting it all costs nothing.
      drawDistance={getHomeSlidePassWidth(slides.length, slideWidth, gap)}
      // The default anchoring re-adjusts the offset when content shifts — on a
      // deliberate instant teleport that correction fights the jump and tugs
      // the rail a frame later. The rail's data never changes at runtime, so
      // anchoring buys nothing here.
      maintainVisibleContentPosition={{ disabled: true }}
      onLoad={centerOnLoad}
      showsHorizontalScrollIndicator={false}
      snapToInterval={slideWidth + gap}
      snapToAlignment="start"
      disableIntervalMomentum
      decelerationRate="fast"
      onScrollBeginDrag={holdRotation}
      // Only momentum end reports a settled offset — `onScrollEndDrag` fires at
      // finger-lift with the scroll still in flight, so reading the index there
      // could trigger a visible correction to the wrong slide. It re-arms the
      // resume timer only, as the safety net for a drag that never coasts.
      onScrollEndDrag={scheduleResume}
      onMomentumScrollEnd={(event) => settleRotation(event.nativeEvent.contentOffset.x)}
      // The rail presents as endless, so its real ends must never be felt: a
      // hard fling that reaches the layout edge would otherwise stretch
      // (Android) or rubber-band (iOS) before the fold teleports it home.
      overScrollMode="never"
      bounces={false}
      extraData={slidePreviews}
      style={{ height: TOP_SLIDE_HEIGHT }}
      contentContainerStyle={{ paddingHorizontal: horizontalPadding }}
      renderItem={({ item }) => (
        <View style={{ marginRight: gap }}>
          <TopSlide
            activeGenerationCount={activeGenerationCount}
            displayName={displayName}
            previewUrl={item.slide.kind === 'tool' ? slidePreviews[item.slide.accent] ?? null : null}
            reduceMotion={reduceMotion}
            signedIn={signedIn}
            slide={item.slide}
            width={slideWidth}
          />
        </View>
      )}
    />
    <SlideDots count={slides.length} index={pageIndex} />
    </View>
  );
}

/**
 * How many slides the rail holds, and which one is showing.
 *
 * Scroll views: "consider showing a page control when a scroll view is in
 * page-by-page mode … If you show a page control with a scroll view, don't show
 * the scrolling indicator on the same axis" — the rail's indicator is already
 * off. It earns its place most with Reduce Motion on, where the rotation stops
 * and a sliver of the next card was the only evidence that there was more.
 *
 * Uncoloured on purpose. Page controls: "Avoid coloring indicator images.
 * Custom colors can reduce the contrast that differentiates the current-page
 * indicator" — so the current dot is simply the brightest thing in the row.
 */
function SlideDots({ count, index }: { count: number; index: number }) {
  if (count < 2) return null;

  return (
    <View
      accessible
      accessibilityLabel={`Slide ${Math.min(index + 1, count)} of ${count}`}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}
    >
      {Array.from({ length: count }, (_, dot) => (
        <View
          key={dot}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: dot === index % count ? DASHBOARD_COLORS.text : DASHBOARD_COLORS.border,
          }}
        />
      ))}
    </View>
  );
}

function TopSlide({
  activeGenerationCount,
  displayName,
  previewUrl,
  reduceMotion,
  signedIn,
  slide,
  width,
}: {
  activeGenerationCount: number;
  displayName: string;
  previewUrl: string | null;
  reduceMotion: boolean;
  signedIn: boolean;
  slide: HomeFeedSlide;
  width: number;
}) {
  if (slide.kind === 'workspace') {
    const title = signedIn ? `Ready when you are, ${displayName}` : 'Create something worth sharing';

    return (
      <View
        style={{
          width,
          height: TOP_SLIDE_HEIGHT,
          borderRadius: 20,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: DASHBOARD_COLORS.borderStrong,
          backgroundColor: DASHBOARD_COLORS.surfaceRaised,
          padding: 14,
          justifyContent: 'space-between',
        }}
      >
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: activeGenerationCount > 0 ? '#34d399' : DASHBOARD_COLORS.coral }} />
            <Text numberOfLines={1} style={{ color: DASHBOARD_COLORS.muted, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' }}>
              {activeGenerationCount > 0
                ? `${activeGenerationCount} render${activeGenerationCount === 1 ? '' : 's'} in progress`
                : 'Creator workspace'}
            </Text>
          </View>
          <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.82} style={{ color: DASHBOARD_COLORS.text, fontSize: 22, lineHeight: 27, fontWeight: '800', letterSpacing: -0.45 }}>
            {title}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create new project"
          accessibilityHint="Opens the creator tools"
          onPress={() => router.push(slide.href as never)}
          style={({ pressed }) => ({
            minHeight: 44,
            borderRadius: 14,
            backgroundColor: DASHBOARD_COLORS.coral,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            opacity: pressed ? 0.84 : 1,
            transform: reduceMotion ? undefined : [{ scale: pressed ? 0.985 : 1 }],
          })}
        >
          <WandSparkles size={appTheme.icon.compact} color={appTheme.colors.onPrimary} />
          <Text style={{ color: appTheme.colors.onPrimary, fontSize: 14, fontWeight: '800' }}>{slide.ctaLabel}</Text>
        </Pressable>
      </View>
    );
  }

  if (slide.kind === 'promo') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={slide.title}
        onPress={() => router.push(slide.href as never)}
        style={({ pressed }) => ({ width, opacity: pressed ? 0.86 : 1 })}
      >
        <View
          style={{
            height: TOP_SLIDE_HEIGHT,
            borderRadius: 20,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: DASHBOARD_COLORS.border,
            backgroundColor: DASHBOARD_COLORS.surface,
            overflow: 'hidden',
            justifyContent: 'flex-end',
          }}
        >
          {slide.imageUrl ? (
            <Image source={{ uri: slide.imageUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : null}
          <LinearGradient colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.72)']} style={{ position: 'absolute', inset: 0 }} />
          <View style={{ padding: 12, gap: 4 }}>
            <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 16, fontWeight: '800' }}>{slide.title}</Text>
            <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: '600' }}>{slide.body}</Text>
          </View>
        </View>
      </Pressable>
    );
  }

  const Icon = slide.id === 'image' ? ImageIcon : slide.id === 'video' ? Play : slide.id === 'motion' ? Rocket : Sparkles;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={slide.title}
      onPress={() => router.push(slide.href as never)}
      style={({ pressed }) => ({
        width,
        opacity: pressed ? 0.82 : 1,
        transform: reduceMotion ? undefined : [{ scale: pressed ? 0.99 : 1 }],
      })}
    >
      <View
        style={{
          height: TOP_SLIDE_HEIGHT,
          borderRadius: 20,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: DASHBOARD_COLORS.border,
          backgroundColor: DASHBOARD_COLORS.surface,
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        {slide.previewVariant ? (
          <ToolPreview
            variant={slide.previewVariant}
            previewUrl={previewUrl}
            icon={<Icon size={18} color="#ffffff" fill={slide.id === 'video' ? 'transparent' : 'rgba(255,255,255,0.14)'} />}
          />
        ) : null}
        <View style={{ gap: 4, flexShrink: 0, paddingHorizontal: 12, paddingBottom: 11, paddingTop: 10 }}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: appTheme.colors.text, fontSize: 16, fontWeight: '800' }}>
            {slide.title}
          </Text>
          <Text numberOfLines={2} style={{ color: DASHBOARD_COLORS.muted, fontSize: 12, lineHeight: 17, fontWeight: '600' }}>
            {slide.body}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

function ToolPreview({
  variant,
  previewUrl,
  icon,
}: {
  variant: 'kingdom' | 'city' | 'runner';
  /** The newest community preview for this tool; the bundled still is the fallback. */
  previewUrl: string | null;
  icon: ReactNode;
}) {
  return (
    // `flexShrink` so the artwork yields height to the caption at large Dynamic
    // Type sizes. The card height is fixed so every slide in the rail matches,
    // and without this the caption was the child that lost the space race — its
    // second line was sliced in half at 1.5x text.
    <View style={{ height: 82, flexShrink: 1, overflow: 'hidden', backgroundColor: DASHBOARD_COLORS.surfaceRaised }}>
      <Image source={TOOL_PREVIEW_IMAGES[variant]} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
      {previewUrl ? (
        <Image
          source={{ uri: previewUrl }}
          cachePolicy="memory-disk"
          contentFit="cover"
          transition={240}
          style={{ position: 'absolute', inset: 0 }}
        />
      ) : null}
      <LinearGradient colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.48)']} style={{ position: 'absolute', inset: 0 }} />
      <View style={{ position: 'absolute', left: 9, top: 9, width: 30, height: 30, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.38)', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
    </View>
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
            <Text style={{ color: active ? DASHBOARD_COLORS.text : DASHBOARD_COLORS.faint, fontSize: 15, fontWeight: '800' }}>
              {chip.label}
            </Text>
            <View
              style={{
                height: 2,
                borderRadius: 1,
                backgroundColor: active ? DASHBOARD_COLORS.coral : 'transparent',
              }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
