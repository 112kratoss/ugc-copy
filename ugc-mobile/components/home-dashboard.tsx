import { FlashList, type ListRenderItem, type ViewToken } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import {
  Bell,
  Crown,
  ImageIcon,
  Menu,
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
  Pressable,
  RefreshControl,
  Share,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CommentsSheet } from '@/components/comments-sheet';
import { FeedFeedbackSheet } from '@/components/feed-feedback-sheet';
import { HomeFeedCardView } from '@/components/home-feed-card';
import { HomeSideMenu } from '@/components/home-side-menu';
import { OnboardingResumeCard } from '@/components/onboarding-resume-card';
import { SecondaryButton, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import {
  HOME_FEED_CHIPS,
  buildHomeFeedCards,
  getHomeFeedCardOpenTarget,
  getHomeFeedSlides,
  type HomeFeedCard,
  type HomeFeedChipId,
  type HomeFeedSlide,
} from '@/lib/home-feed-view-model';
import { getOwnerPostSalesSummary } from '@/lib/home-view-model';
import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
import { SHOWCASE_DRAW_DISTANCE, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS } from '@/lib/media-performance';
import { useReducedMotion } from '@/lib/motion';
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
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { accentColor, appTheme } from '@/lib/theme';
import type {
  ShowcaseFeedEventType,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';
import { getNativeRemixCreateHref } from '@/lib/viewer-actions';
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

export function HomeDashboard() {
  const {
    comments: requestedComments,
    replyTo: requestedReplyTo,
  } = useLocalSearchParams<{
    comments?: string | string[];
    replyTo?: string | string[];
  }>();
  const { user, api, credits, signOut } = useAuth();
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
  const horizontalPadding = isCompact ? 15 : 18;
  const contentWidth = pageWidth - horizontalPadding * 2;
  const slideWidth = Math.round(contentWidth * 0.82);

  const [menuVisible, setMenuVisible] = useState(false);
  const [activeChipId, setActiveChipId] = useState<HomeFeedChipId>('for-you');
  const [activeVideoIds, setActiveVideoIds] = useState<string[]>([]);
  const [feedbackItem, setFeedbackItem] = useState<ShowcaseFeedItem | null>(null);
  const [commentsItem, setCommentsItem] = useState<ShowcaseFeedItem | null>(null);
  const [commentsReplyToId, setCommentsReplyToId] = useState<string | null>(null);
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
    queryKey: ['home-generations', user?.id],
    enabled: Boolean(user),
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
    if (!isFocused || !user || generationsQuery.isFetching || !generationsQuery.isStale) return;
    void generationsQuery.refetch();
  }, [generationsQuery.isFetching, generationsQuery.isStale, isFocused, user?.id]);

  useEffect(() => {
    if (!isFocused || !user || !menuVisible || sellerPostsQuery.isFetching || !sellerPostsQuery.isStale) return;
    void sellerPostsQuery.refetch();
  }, [isFocused, menuVisible, sellerPostsQuery.isFetching, sellerPostsQuery.isStale, user?.id]);

  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMoreItemCountRef = useRef(0);
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
    void runtime.api.recordShowcaseFeedEvent(request).catch(() => null);
  }, []);

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
  const hasItems = cards.length > 0;
  const isFirstLoad = feedQuery.isLoading && !hasItems;
  const isRefreshing = feedQuery.isRefetching && !feedQuery.isFetchingNextPage;

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
    if (
      !feedQuery.hasNextPage ||
      feedQuery.isFetchingNextPage ||
      feedQuery.isLoading ||
      loadingMoreRef.current ||
      lastLoadMoreItemCountRef.current === feedItems.length ||
      now - lastLoadMoreAtRef.current < LOAD_MORE_COOLDOWN_MS
    ) {
      return;
    }

    loadingMoreRef.current = true;
    lastLoadMoreAtRef.current = now;
    lastLoadMoreItemCountRef.current = feedItems.length;
    void feedQuery.fetchNextPage().finally(() => {
      loadingMoreRef.current = false;
    });
  };

  const handleRefresh = () => {
    lastLoadMoreItemCountRef.current = 0;
    lastLoadMoreAtRef.current = 0;
    queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(queryKey, (current) => {
      if (!current?.pages.length) return current;
      return { pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) };
    });
    void feedQuery.refetch();
  };

  const selectChip = (chipId: HomeFeedChipId) => {
    if (chipId === activeChipId) return;
    qualifiedImpressionsRef.current.clear();
    lastLoadMoreItemCountRef.current = 0;
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
   * The immersive viewer is a full-screen media pager, so a post with no media
   * opens its discussion instead of an empty slide.
   */
  const openCard = (card: HomeFeedCard) => {
    if (getHomeFeedCardOpenTarget(card) === 'comments') {
      recordFeedEvent(card.item, 'open');
      setCommentsReplyToId(null);
      setCommentsItem(card.item);
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
    const url = `${env.siteUrl}/showcase/${item.id}`;
    try {
      const result = await Share.share({ title: item.title, message: `${item.title}\n${url}`, url });
      if (result.action === Share.sharedAction) {
        void api.shareShowcasePost(item.id, 'native-share').catch(() => null);
        recordFeedEvent(item, 'share');
      }
    } catch {
      // A dismissed share sheet is not an error worth surfacing.
    }
  };

  const remixItem = async (item: ShowcaseFeedItem) => {
    if (!user) {
      router.push('/auth' as never);
      return;
    }
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
      } else {
        Alert.alert('Could not start remix', 'This post cannot be opened in the creator tools right now.');
      }
    } catch (error) {
      Alert.alert('Could not start remix', error instanceof Error ? error.message : 'Please try again.');
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
              Alert.alert('Could not block user', error instanceof Error ? error.message : 'Please try again.');
            }
          },
        },
      ]
    );
  };

  const renderCard: ListRenderItem<HomeFeedCard> = useCallback(({ item: card }) => (
    <View style={{ paddingHorizontal: horizontalPadding, paddingBottom: 14 }}>
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
          setCommentsReplyToId(null);
          setCommentsItem(card.item);
        }}
        onRemix={() => void remixItem(card.item)}
        onShare={() => void shareItem(card.item)}
      />
    </View>
  ), [contentWidth, expandedBodyIds, horizontalPadding, visibleActiveVideoIds, toggleSave]);

  return (
    <View style={{ flex: 1, backgroundColor: DASHBOARD_COLORS.background, paddingTop: topInset }}>
      <FlashList
        data={cards}
        keyExtractor={(card) => card.id}
        renderItem={renderCard}
        getItemType={(card) => card.previewKind}
        extraData={visibleActiveVideoIds}
        drawDistance={SHOWCASE_DRAW_DISTANCE}
        onEndReached={requestNextPage}
        onEndReachedThreshold={0.32}
        refreshControl={(
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={DASHBOARD_COLORS.faint}
            colors={[DASHBOARD_COLORS.coral]}
            progressBackgroundColor={DASHBOARD_COLORS.surfaceRaised}
          />
        )}
        showsVerticalScrollIndicator={false}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        contentContainerStyle={{ paddingBottom: tabBarMetrics.contentBottomOverlapPadding + 24 }}
        ListHeaderComponent={(
          <View style={{ gap: 18, paddingTop: 10, paddingBottom: 6 }}>
            <View style={{ paddingHorizontal: horizontalPadding }}>
              <HomeTopBar credits={credits ?? 0} onMenuPress={() => setMenuVisible(true)} />
            </View>

            <TopSlider
              activeGenerationCount={activeGenerationCount}
              displayName={displayName}
              horizontalPadding={horizontalPadding}
              reduceMotion={reduceMotion}
              signedIn={Boolean(user)}
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
        ListEmptyComponent={(
          <View style={{ paddingHorizontal: horizontalPadding, paddingTop: 32 }}>
            {isFirstLoad ? (
              <ActivityIndicator color={DASHBOARD_COLORS.faint} />
            ) : feedQuery.isError ? (
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
        ) : null}
      />

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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        onPress={onMenuPress}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 24,
          borderWidth: 1,
          borderColor: DASHBOARD_COLORS.border,
          backgroundColor: DASHBOARD_COLORS.surface,
          opacity: pressed ? 0.72 : 1,
        })}
      >
        <Menu size={22} color={DASHBOARD_COLORS.text} strokeWidth={2.2} />
      </Pressable>

      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minWidth: 0 }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: DASHBOARD_COLORS.coral }} />
        <Text numberOfLines={1} style={{ color: DASHBOARD_COLORS.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2, flexShrink: 1 }}>
          Magicbooklet
        </Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open credits"
          onPress={() => router.push('/pricing' as never)}
          style={({ pressed }) => ({
            minWidth: 68,
            height: 48,
            borderRadius: 24,
            borderWidth: 1,
            borderColor: DASHBOARD_COLORS.border,
            backgroundColor: DASHBOARD_COLORS.surface,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 10,
            opacity: pressed ? 0.78 : 1,
          })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Crown size={15} color="#fbbf24" fill="rgba(251,191,36,0.2)" />
            <Text style={{ color: DASHBOARD_COLORS.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{credits}</Text>
            <Plus size={14} color={DASHBOARD_COLORS.coral} strokeWidth={2.5} />
          </View>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open studio activity"
          onPress={() => router.push('/studio' as never)}
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            borderRadius: 24,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: DASHBOARD_COLORS.border,
            backgroundColor: DASHBOARD_COLORS.surface,
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <Bell size={21} color={DASHBOARD_COLORS.text} strokeWidth={2.1} />
        </Pressable>
      </View>
    </View>
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
  reduceMotion,
  signedIn,
  slideWidth,
}: {
  activeGenerationCount: number;
  displayName: string;
  horizontalPadding: number;
  reduceMotion: boolean;
  signedIn: boolean;
  slideWidth: number;
}) {
  const slides = useMemo(() => getHomeFeedSlides(), []);
  const gap = 10;

  return (
    <FlashList
      data={slides}
      horizontal
      keyExtractor={(slide) => slide.id}
      showsHorizontalScrollIndicator={false}
      snapToInterval={slideWidth + gap}
      snapToAlignment="start"
      disableIntervalMomentum
      decelerationRate="fast"
      style={{ height: TOP_SLIDE_HEIGHT }}
      contentContainerStyle={{ paddingHorizontal: horizontalPadding }}
      renderItem={({ item: slide }) => (
        <View style={{ marginRight: gap }}>
          <TopSlide
            activeGenerationCount={activeGenerationCount}
            displayName={displayName}
            reduceMotion={reduceMotion}
            signedIn={signedIn}
            slide={slide}
            width={slideWidth}
          />
        </View>
      )}
    />
  );
}

function TopSlide({
  activeGenerationCount,
  displayName,
  reduceMotion,
  signedIn,
  slide,
  width,
}: {
  activeGenerationCount: number;
  displayName: string;
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
          <WandSparkles size={17} color={appTheme.colors.onPrimary} strokeWidth={2.5} />
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
  const accent = accentColor(slide.accent);

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
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: accent }} />
        {slide.previewVariant ? (
          <ToolPreview
            variant={slide.previewVariant}
            icon={<Icon size={18} color="#ffffff" fill={slide.id === 'video' ? 'transparent' : 'rgba(255,255,255,0.14)'} />}
          />
        ) : null}
        <View style={{ gap: 4, paddingHorizontal: 12, paddingBottom: 11, paddingTop: 10 }}>
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
  icon,
}: {
  variant: 'kingdom' | 'city' | 'runner';
  icon: ReactNode;
}) {
  return (
    <View style={{ height: 82, overflow: 'hidden', backgroundColor: DASHBOARD_COLORS.surfaceRaised }}>
      <Image source={TOOL_PREVIEW_IMAGES[variant]} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
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
            style={{ minHeight: 44, justifyContent: 'center', gap: 6 }}
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
