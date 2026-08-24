import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useIsFocused, useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  ChevronRight,
  Crown,
  Gift,
  Heart,
  ImageIcon,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Store,
  UserRound,
  Wallet,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, Text, useWindowDimensions, View, type PanResponderGestureState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StableMediaImage } from '@/components/media-preview';
import { FeedLoadMoreErrorFooter } from '@/components/feed-pagination-footer';
import { Reveal } from '@/components/reveal';
import { ProfileGridSkeleton } from '@/components/skeleton';
import { TopScrim } from '@/components/top-scrim';
import { AppText, SecondaryButton, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
import { formatUsdCents, getOwnerPostSalesSummary } from '@/lib/home-view-model';
import { haptic } from '@/lib/haptics';
import { immersiveViewerHref, profileMediaFeedHref, textPostViewerHref } from '@/lib/immersive-preview-view-model';
import { MotionView, usePressMotion } from '@/lib/motion';
import {
  FALLBACK_PROFILE_MEDIA,
  PROFILE_MEDIA_TABS,
  generationToProfileMediaCard,
  getProfileMediaEmptyTitle,
  getProfileMediaSectionTitle,
  getProfileMediaSwipeTarget,
  getProfileHandle,
  getProfileInitials,
  getProfileName,
  getProfileStats,
  ownerPostToProfileMediaCard,
  savedShowcaseToProfileMediaCards,
  type ProfileMediaCard,
  type ProfileMediaSwipeDirection,
  type ProfileMediaTab,
  type ProfilePostsScope,
} from '@/lib/profile-view-model';
import {
  PROFILE_MEDIA_LOAD_MORE_COOLDOWN_MS,
  PROFILE_MEDIA_MIN_FILL_COUNT,
  PROFILE_MEDIA_PAGE_SIZE,
  flattenProfileGenerationPages,
  flattenProfileOwnerPostPages,
  getNextProfileGenerationsCursor,
  getNextProfileOwnerPostsOffset,
  getNextProfileSavedMediaOffset,
  truncateInfiniteDataToFirstPage,
} from '@/lib/profile-media-query';
import { flattenShowcaseFeedPages } from '@/lib/showcase-feed-query';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';
import type {
  GenerationListResponse,
  OwnerPostsResponse,
  ProfileResponse,
  ShowcaseFeedResponse,
} from '@/lib/types';

const PROFILE_GALLERY_COLUMNS = 3;
const PROFILE_GALLERY_GAP = 8;
const PROFILE_GALLERY_ASPECT_RATIO = 0.74;
const PROFILE_MEDIA_SWIPE_START_DISTANCE = 28;
const PROFILE_MEDIA_SWIPE_COMMIT_DISTANCE = 56;
const PROFILE_MEDIA_SWIPE_AXIS_RATIO = 1.25;
// Three rows rise into place when a tab's media lands; later rows mount plain.
const PROFILE_GALLERY_REVEAL_COUNT = PROFILE_GALLERY_COLUMNS * 3;

const PROFILE_COLORS = {
  background: appTheme.colors.background,
  surface: appTheme.colors.panel,
  surfaceRaised: appTheme.colors.panelSoft,
  border: appTheme.colors.border,
  borderStrong: appTheme.colors.borderStrong,
  text: appTheme.colors.text,
  muted: appTheme.colors.muted,
  faint: appTheme.colors.faint,
  coral: appTheme.colors.primary,
  coralSoft: appTheme.colors.pressed,
} as const;

export function ProfileDashboard({
  initialTab = 'Saved',
  highlightedPostId = null,
}: {
  initialTab?: ProfileMediaTab;
  highlightedPostId?: string | null;
} = {}) {
  const { user, api, credits } = useAuth();
  const isFocused = useIsFocused();
  const [activeTab, setActiveTab] = useState<ProfileMediaTab>(initialTab);
  // Archived posts live under their own scope of the Posts tab: the archive
  // dialog promises they can be restored from the profile, so they have to be
  // reachable here.
  const [postsScope, setPostsScope] = useState<ProfilePostsScope>('active');
  const [backgroundMediaReady, setBackgroundMediaReady] = useState(false);
  const queryClient = useQueryClient();
  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMorePageCountRef = useRef<number | null>(null);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 390;
  const horizontalPadding = isCompact ? 16 : 18;

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });

  const generationsQuery = useInfiniteQuery({
    queryKey: ['profile-generations', user?.id],
    enabled: Boolean(user && (activeTab === 'Creations' || backgroundMediaReady)),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.listGenerations(false, {
      cursor: pageParam ?? undefined,
      limit: PROFILE_MEDIA_PAGE_SIZE,
    }),
    getNextPageParam: getNextProfileGenerationsCursor,
    staleTime: 1000 * 60,
  });

  const postsQuery = useInfiniteQuery({
    queryKey: ['profile-owner-posts', user?.id],
    enabled: Boolean(user && (activeTab === 'Posts' || backgroundMediaReady)),
    initialPageParam: 0,
    // Only the first page pays for the sales-summary aggregate.
    queryFn: ({ pageParam }) => api.listOwnerPosts({
      includeArchived: true,
      includeSummary: pageParam === 0,
      limit: PROFILE_MEDIA_PAGE_SIZE,
      offset: pageParam,
      visibility: 'all',
    }),
    getNextPageParam: getNextProfileOwnerPostsOffset,
    staleTime: 1000 * 60,
  });

  const savedQuery = useInfiniteQuery({
    queryKey: ['profile-saved-media', user?.id],
    enabled: Boolean(user && (activeTab === 'Saved' || backgroundMediaReady)),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.getSavedMedia({
      limit: PROFILE_MEDIA_PAGE_SIZE,
      offset: pageParam,
    }),
    getNextPageParam: getNextProfileSavedMediaOffset,
    staleTime: 1000 * 60,
  });

  const activeMediaQuery = activeTab === 'Saved'
    ? savedQuery
    : activeTab === 'Creations'
      ? generationsQuery
      : postsQuery;
  const {
    isFetched: activeMediaIsFetched,
    isFetching: activeMediaIsFetching,
    isStale: activeMediaIsStale,
    refetch: refetchActiveMedia,
  } = activeMediaQuery;

  useEffect(() => {
    setBackgroundMediaReady(false);
  }, [user?.id]);

  useEffect(() => {
    loadingMoreRef.current = false;
    lastLoadMoreAtRef.current = 0;
    lastLoadMorePageCountRef.current = null;
  }, [activeTab, user?.id]);

  useEffect(() => {
    if (user?.id && activeMediaIsFetched) {
      setBackgroundMediaReady(true);
    }
  }, [activeMediaIsFetched, user?.id]);

  useEffect(() => {
    if (
      !isFocused
      || !user
      || activeMediaIsFetching
      || !activeMediaIsStale
    ) return;
    void refetchActiveMedia();
  }, [activeMediaIsFetching, activeMediaIsStale, isFocused, refetchActiveMedia, user?.id]);

  const savedCards = useMemo(
    () => savedShowcaseToProfileMediaCards(flattenShowcaseFeedPages(savedQuery.data?.pages)),
    [savedQuery.data]
  );
  const creationCards = useMemo(
    () => flattenProfileGenerationPages(generationsQuery.data?.pages)
      .map(generationToProfileMediaCard)
      .filter((card) => card.isGridReady),
    [generationsQuery.data]
  );
  const ownerPosts = useMemo(
    () => flattenProfileOwnerPostPages(postsQuery.data?.pages),
    [postsQuery.data]
  );
  const allPostCards = useMemo(
    () => ownerPosts.map(ownerPostToProfileMediaCard).filter((card) => card.isGridReady),
    [ownerPosts]
  );
  const activePostCards = useMemo(() => allPostCards.filter((card) => !card.isArchived), [allPostCards]);
  const archivedPostCards = useMemo(() => allPostCards.filter((card) => card.isArchived), [allPostCards]);
  const postCards = postsScope === 'archived' ? archivedPostCards : activePostCards;
  const salesSummary = useMemo(
    () => postsQuery.data?.pages[0]?.summary ?? getOwnerPostSalesSummary(ownerPosts),
    [ownerPosts, postsQuery.data]
  );
  const profile = profileQuery.data;
  const displayName = getProfileName(profile, user?.email);
  const handle = getProfileHandle(profile, user?.email);
  const initials = getProfileInitials(profile, user?.email);
  const stats = getProfileStats({
    generationsCount: creationCards.length,
    generationsHasMore: generationsQuery.hasNextPage,
    postsCount: activePostCards.length,
    postsHasMore: postsQuery.hasNextPage,
    savedCount: savedCards.length,
    savedHasMore: savedQuery.hasNextPage,
  });
  const tabCards = activeTab === 'Saved' ? savedCards : activeTab === 'Creations' ? creationCards : postCards;
  const signedOutPreviewCards = FALLBACK_PROFILE_MEDIA.filter((card) => (
    activeTab === 'Saved'
      ? card.label === 'Saved'
      : activeTab === 'Creations'
        ? card.label === 'Creation'
        : card.label === 'Post'
  ));
  const isMediaLoading =
    (activeTab === 'Saved' && savedQuery.isLoading)
    || (activeTab === 'Creations' && generationsQuery.isLoading)
    || (activeTab === 'Posts' && postsQuery.isLoading);
  const activeTabPaging = activeTab === 'Saved'
    ? savedQuery
    : activeTab === 'Creations'
      ? generationsQuery
      : postsQuery;
  const activeHasNextPage = activeTabPaging.hasNextPage;
  const activeIsFetchingNextPage = activeTabPaging.isFetchingNextPage;
  const activeIsFetchNextPageError = activeTabPaging.isFetchNextPageError;
  const activePageCount = activeTabPaging.data?.pages.length ?? 0;
  const mediaError = activeIsFetchNextPageError ? null : activeTabPaging.error;

  const requestNextPage = useCallback(() => {
    const now = Date.now();
    if (!canRequestNextFeedPage({
      cooldownMs: PROFILE_MEDIA_LOAD_MORE_COOLDOWN_MS,
      hasNextPage: activeHasNextPage,
      isBusy: activeMediaIsFetching,
      isRequestInFlight: loadingMoreRef.current,
      lastRequestedAt: lastLoadMoreAtRef.current,
      lastRequestedPageCount: lastLoadMorePageCountRef.current,
      now,
      pageCount: activePageCount,
    })) return;

    loadingMoreRef.current = true;
    lastLoadMoreAtRef.current = now;
    lastLoadMorePageCountRef.current = activePageCount;

    if (activeTab === 'Saved') {
      void savedQuery.fetchNextPage().finally(() => { loadingMoreRef.current = false; });
      return;
    }
    if (activeTab === 'Creations') {
      void generationsQuery.fetchNextPage().finally(() => { loadingMoreRef.current = false; });
      return;
    }
    void postsQuery.fetchNextPage().finally(() => { loadingMoreRef.current = false; });
  }, [
    activeHasNextPage,
    activeIsFetchingNextPage,
    activeMediaIsFetching,
    activePageCount,
    activeTab,
    generationsQuery,
    postsQuery,
    savedQuery,
  ]);

  const retryNextPage = useCallback(() => {
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    requestNextPage();
  }, [requestNextPage]);

  // A page that yields few renderable tiles can leave the grid too short to scroll, so
  // onEndReached would never fire again. Top it up until the grid can carry itself.
  useEffect(() => {
    if (isMediaLoading || tabCards.length >= PROFILE_MEDIA_MIN_FILL_COUNT) return;
    requestNextPage();
  }, [isMediaLoading, requestNextPage, tabCards.length]);

  const handleMediaTabChange = useCallback((tab: ProfileMediaTab) => {
    setActiveTab(tab);
  }, []);
  const handleMediaSwipe = useCallback((direction: ProfileMediaSwipeDirection) => {
    setActiveTab((currentTab) => getProfileMediaSwipeTarget(currentTab, direction));
  }, []);
  // Collapse back to a single page before refetching, otherwise React Query refetches every
  // page the user has scrolled through.
  const refreshActiveMedia = () => {
    haptic.light();
    loadingMoreRef.current = false;
    lastLoadMoreAtRef.current = 0;
    lastLoadMorePageCountRef.current = null;

    if (activeTab === 'Saved') {
      queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(
        ['profile-saved-media', user?.id],
        truncateInfiniteDataToFirstPage
      );
      void savedQuery.refetch();
      return;
    }
    if (activeTab === 'Creations') {
      queryClient.setQueryData<InfiniteData<GenerationListResponse>>(
        ['profile-generations', user?.id],
        truncateInfiniteDataToFirstPage
      );
      void generationsQuery.refetch();
      return;
    }
    queryClient.setQueryData<InfiniteData<OwnerPostsResponse>>(
      ['profile-owner-posts', user?.id],
      truncateInfiniteDataToFirstPage
    );
    void postsQuery.refetch();
  };

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  if (!user) {
    return (
      <ProfileMediaList
        activeTab={activeTab}
        cards={signedOutPreviewCards}
        contentBottomPadding={tabBarMetrics.contentBottomOverlapPadding}
        emptyTitle={activeTab === 'Saved' ? 'Sign in to view saved media' : `Sign in to view your ${activeTab.toLowerCase()}`}
        fallbackAvatarInitials="C"
        header={(
          <>
            <ProfileTitle />
            <SignedOutCard />
          </>
        )}
        horizontalPadding={horizontalPadding}
        isLoading={false}
        mediaError={null}
        onSwipeTab={handleMediaSwipe}
        onTabChange={handleMediaTabChange}
        topInset={topInset}
      />
    );
  }

  return (
    <ProfileMediaList
      activeTab={activeTab}
      cards={tabCards}
      contentBottomPadding={tabBarMetrics.contentBottomOverlapPadding}
      emptyTitle={getProfileMediaEmptyTitle(activeTab, postsScope)}
      fallbackAvatarInitials={initials}
      fallbackAvatarUrl={profile?.avatarUrl}
      postsScope={postsScope}
      postsScopeCounts={{ active: activePostCards.length, archived: archivedPostCards.length }}
      onPostsScopeChange={setPostsScope}
      header={(
        <>
          <ProfileTitle />
          {profileQuery.error && !profile ? (
            <View style={{ gap: appTheme.spacing.gap }}>
              <StatusBlock tone="danger" title="Could not load profile" body="Check your connection, then try again." />
              <SecondaryButton label="Retry profile" onPress={() => void profileQuery.refetch()} />
            </View>
          ) : null}
          <ProfileHeroCard
            profile={profile}
            displayName={displayName}
            handle={handle}
            initials={initials}
            email={user.email}
            stats={stats}
            onEdit={() => router.push('/edit-profile' as never)}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <BalanceCard
              icon={<Crown size={19} color="#fbbf24" />}
              label="Credits"
              value={String(credits ?? profile?.credits ?? 0)}
              onPress={() => router.push('/pricing' as never)}
            />
            <BalanceCard
              icon={<Wallet size={19} color={PROFILE_COLORS.coral} />}
              label="Wallet"
              value={formatUsdCents(salesSummary.earningsUsdCents)}
              onPress={() => router.push('/seller-dashboard' as never)}
            />
          </View>
          <InviteAndEarnButton />
          <SellerDashboardButton />
        </>
      )}
      horizontalPadding={horizontalPadding}
      highlightedPostId={highlightedPostId}
      isFetchNextPageError={activeIsFetchNextPageError}
      isFetchingNextPage={activeIsFetchingNextPage}
      isLoading={isMediaLoading}
      isRefreshing={activeMediaIsFetching && !activeIsFetchingNextPage}
      mediaError={mediaError}
      onEndReached={requestNextPage}
      onRetryNextPage={retryNextPage}
      onRefresh={refreshActiveMedia}
      onSwipeTab={handleMediaSwipe}
      onTabChange={handleMediaTabChange}
      title={getProfileMediaSectionTitle(activeTab)}
      topInset={topInset}
    />
  );
}

function ProfileMediaList({
  activeTab,
  cards,
  contentBottomPadding,
  emptyTitle,
  fallbackAvatarInitials,
  fallbackAvatarUrl,
  header,
  horizontalPadding,
  highlightedPostId,
  isFetchNextPageError,
  isFetchingNextPage,
  isLoading,
  isRefreshing,
  mediaError,
  onEndReached,
  onRefresh,
  onRetryNextPage,
  onSwipeTab,
  onTabChange,
  postsScope = 'active',
  postsScopeCounts,
  onPostsScopeChange,
  title,
  topInset,
}: {
  activeTab: ProfileMediaTab;
  cards: ProfileMediaCard[];
  contentBottomPadding: number;
  emptyTitle: string;
  fallbackAvatarInitials: string;
  fallbackAvatarUrl?: string | null;
  header: React.ReactNode;
  horizontalPadding: number;
  highlightedPostId?: string | null;
  isFetchNextPageError?: boolean;
  isFetchingNextPage?: boolean;
  isLoading: boolean;
  isRefreshing?: boolean;
  mediaError?: unknown;
  onEndReached?: () => void;
  onRefresh?: () => void;
  onRetryNextPage?: () => void;
  onSwipeTab: (direction: ProfileMediaSwipeDirection) => void;
  onTabChange: (tab: ProfileMediaTab) => void;
  postsScope?: ProfilePostsScope;
  postsScopeCounts?: Record<ProfilePostsScope, number>;
  onPostsScopeChange?: (scope: ProfilePostsScope) => void;
  title?: string;
  topInset: number;
}) {
  const listRef = useRef<FlashListRef<ProfileMediaCard>>(null);
  useScrollToTop(listRef);
  const { width } = useWindowDimensions();
  const pageWidth = Math.min(width, 430);
  const contentWidth = pageWidth - horizontalPadding * 2;
  const cardWidth = Math.floor((contentWidth - PROFILE_GALLERY_GAP * (PROFILE_GALLERY_COLUMNS - 1)) / PROFILE_GALLERY_COLUMNS);
  const cardHeight = Math.round(cardWidth / PROFILE_GALLERY_ASPECT_RATIO);
  const swipeResponder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => isProfileMediaSwipeGesture(gestureState),
      onPanResponderRelease: (_, gestureState) => {
        const direction = getProfileMediaSwipeDirection(gestureState);
        if (direction) onSwipeTab(direction);
      },
    }),
    [onSwipeTab]
  );

  return (
    <View {...swipeResponder.panHandlers} style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <FlashList
        ref={listRef}
        data={isLoading ? [] : cards}
        drawDistance={400}
        extraData={activeTab}
        getItemType={(item) => item.mediaKind ?? item.previewKind}
        keyExtractor={(item) => `${item.label}-${item.id}`}
        ListHeaderComponent={(
          <View style={{ gap: 14, paddingBottom: 12 }}>
            {header}
            <ProfileMediaHeader
              activeTab={activeTab}
              onRefresh={onRefresh}
              onTabChange={onTabChange}
              title={title}
            />
            {activeTab === 'Posts' && onPostsScopeChange ? (
              <ProfilePostsScopeControl
                value={postsScope}
                counts={postsScopeCounts}
                onChange={onPostsScopeChange}
              />
            ) : null}
            {mediaError ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <StatusBlock tone="danger" title={`Could not load ${activeTab.toLowerCase()}`} body="Your existing media is safe. Check your connection, then retry." />
                {onRefresh ? <SecondaryButton label={`Retry ${activeTab.toLowerCase()}`} onPress={onRefresh} /> : null}
              </View>
            ) : null}
          </View>
        )}
        ListEmptyComponent={isLoading ? (
          <ProfileGridSkeleton
            columns={PROFILE_GALLERY_COLUMNS}
            gap={PROFILE_GALLERY_GAP}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
          />
        ) : (
          <ProfileMediaEmpty title={emptyTitle} />
        )}
        ListFooterComponent={isFetchingNextPage ? <ProfileGridFooterLoader />
          : isFetchNextPageError && onRetryNextPage ? <FeedLoadMoreErrorFooter onRetry={onRetryNextPage} />
            : null}
        numColumns={PROFILE_GALLERY_COLUMNS}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.32}
        onRefresh={onRefresh}
        refreshing={Boolean(isRefreshing)}
        removeClippedSubviews={false}
        renderItem={({ item, index }) => (
          <Reveal
            index={index}
            enabled={index < PROFILE_GALLERY_REVEAL_COUNT}
            style={{
              width: cardWidth,
              marginRight: index % PROFILE_GALLERY_COLUMNS === PROFILE_GALLERY_COLUMNS - 1 ? 0 : PROFILE_GALLERY_GAP,
              marginBottom: PROFILE_GALLERY_GAP,
            }}
          >
            <ProfileMediaTile
              item={item}
              width={cardWidth}
              height={cardHeight}
              fallbackAvatarUrl={fallbackAvatarUrl}
              fallbackAvatarInitials={fallbackAvatarInitials}
              highlighted={activeTab === 'Posts' && highlightedPostId === item.sourceId}
            />
          </Reveal>
        )}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: appTheme.colors.background }}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: topInset + 12,
          paddingHorizontal: horizontalPadding,
          paddingBottom: contentBottomPadding + 20,
        }}
      />

      <TopScrim topInset={topInset} />
    </View>
  );
}

function ProfileTitle() {
  return (
    <View style={{ minHeight: 40, justifyContent: 'center', gap: 2 }}>
      <AppText variant="sectionTitle" style={{ fontSize: 24, lineHeight: 29, fontWeight: '800', letterSpacing: -0.4 }}>
        Profile
      </AppText>
      <AppText variant="caption" color="muted">Your identity, balance, and published work.</AppText>
    </View>
  );
}

function SignedOutCard() {
  return (
    <View
      style={{
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: PROFILE_COLORS.border,
        backgroundColor: PROFILE_COLORS.surface,
        padding: 18,
        gap: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
        <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: PROFILE_COLORS.surfaceRaised, borderWidth: 1, borderColor: PROFILE_COLORS.borderStrong }}>
          <UserRound size={25} color={PROFILE_COLORS.muted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <AppText variant="cardTitle" style={{ fontSize: 19, lineHeight: 24 }}>Sign in to your creator profile</AppText>
          <AppText variant="bodySm" color="muted">
            Keep saved media, creations, and earnings in one place.
          </AppText>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        onPress={() => router.push('/auth')}
        style={({ pressed }) => ({
          minHeight: 50,
          borderRadius: 18,
          backgroundColor: PROFILE_COLORS.coral,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.84 : 1,
        })}
      >
        <Text style={{ color: '#111114', fontSize: 15, fontWeight: '800' }}>Sign in</Text>
      </Pressable>
    </View>
  );
}

function ProfileHeroCard({
  profile,
  displayName,
  handle,
  initials,
  email,
  stats,
  onEdit,
}: {
  profile?: ProfileResponse | null;
  displayName: string;
  handle: string;
  initials: string;
  email?: string;
  stats: ReturnType<typeof getProfileStats>;
  onEdit: () => void;
}) {
  return (
    <View
      style={{
        overflow: 'hidden',
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: PROFILE_COLORS.border,
        backgroundColor: PROFILE_COLORS.surface,
      }}
    >
      <View style={{ height: 84, overflow: 'hidden', backgroundColor: PROFILE_COLORS.surfaceRaised }}>
        {profile?.coverUrl ? (
          <Image source={{ uri: profile.coverUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <View style={{ width: 36, height: 1, backgroundColor: PROFILE_COLORS.borderStrong }} />
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: PROFILE_COLORS.coral }} />
            <View style={{ width: 36, height: 1, backgroundColor: PROFILE_COLORS.borderStrong }} />
          </View>
        )}
        {profile?.coverUrl ? <LinearGradient colors={['rgba(0,0,0,0.06)', 'rgba(0,0,0,0.56)']} style={{ position: 'absolute', inset: 0 }} /> : null}
      </View>

      <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
        <View style={{ marginTop: -32, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <ProfileAvatar profile={profile} initials={initials} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit profile"
            onPress={onEdit}
            style={({ pressed }) => ({
              minHeight: 48,
              borderRadius: 18,
              backgroundColor: PROFILE_COLORS.coral,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              paddingHorizontal: 16,
              opacity: pressed ? 0.78 : 1,
            })}
          >
            <Pencil size={15} color="#111114" />
            <Text style={{ color: '#111114', fontSize: 14, fontWeight: '800' }}>Edit Profile</Text>
          </Pressable>
        </View>

        <View style={{ gap: 5, paddingTop: 12 }}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: PROFILE_COLORS.text, fontSize: 23, lineHeight: 28, fontWeight: '800', letterSpacing: -0.35 }}>{displayName}</Text>
          <Text numberOfLines={1} style={{ color: PROFILE_COLORS.coral, fontSize: 13, fontWeight: '800' }}>{handle}</Text>
          {profile?.bio ? (
            <Text numberOfLines={2} style={{ color: PROFILE_COLORS.muted, fontSize: 13, lineHeight: 19 }}>{profile.bio}</Text>
          ) : (
            <Text numberOfLines={1} style={{ color: PROFILE_COLORS.muted, fontSize: 13, lineHeight: 19 }}>
              {email ? `Signed in as ${email}` : 'Creator profile ready for saved media and posts.'}
            </Text>
          )}
        </View>

        <View style={{ height: 1, backgroundColor: PROFILE_COLORS.border, marginVertical: 13 }} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {stats.map((stat) => (
            <View key={stat.label} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 5 }}>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: PROFILE_COLORS.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{stat.value}</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: PROFILE_COLORS.muted, fontSize: 10, fontWeight: '700' }}>{stat.label}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function ProfileAvatar({ profile, initials }: { profile?: ProfileResponse | null; initials: string }) {
  return (
    <View
      style={{
        width: 68,
        height: 68,
        borderRadius: 34,
        padding: 3,
        backgroundColor: PROFILE_COLORS.background,
      }}
    >
        <View style={{ flex: 1, overflow: 'hidden', borderRadius: 31, alignItems: 'center', justifyContent: 'center', backgroundColor: PROFILE_COLORS.surfaceRaised, borderWidth: 2, borderColor: PROFILE_COLORS.coral }}>
          {profile?.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <Text style={{ color: PROFILE_COLORS.text, fontSize: 21, fontWeight: '800' }}>{initials}</Text>
          )}
        </View>
    </View>
  );
}

function BalanceCard({
  icon,
  label,
  value,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 74,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: PROFILE_COLORS.border,
        backgroundColor: PROFILE_COLORS.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: PROFILE_COLORS.surfaceRaised }}>
        {icon}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: PROFILE_COLORS.muted, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Text>
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.74} style={{ color: PROFILE_COLORS.text, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
      </View>
      <ChevronRight size={16} color={PROFILE_COLORS.faint} strokeWidth={2.3} />
    </Pressable>
  );
}

function SellerDashboardButton() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open seller dashboard"
      onPress={() => router.push('/seller-dashboard' as never)}
      style={({ pressed }) => ({
        minHeight: 58,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: PROFILE_COLORS.border,
        backgroundColor: PROFILE_COLORS.surface,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? 0.82 : 1,
      })}
    >
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: PROFILE_COLORS.coralSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Store size={19} color={PROFILE_COLORS.coral} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="label" numberOfLines={1} style={{ fontSize: 14 }}>Seller Dashboard</AppText>
        <AppText variant="caption" color="muted" numberOfLines={1}>Sales, unlocks, and listings</AppText>
      </View>
      <ChevronRight size={20} color={PROFILE_COLORS.faint} />
    </Pressable>
  );
}

function InviteAndEarnButton() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open Invite and Earn"
      onPress={() => router.push('/invite' as never)}
      style={({ pressed }) => ({
        minHeight: 58,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: `${appTheme.colors.commerce}55`,
        backgroundColor: `${appTheme.colors.commerce}0f`,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? 0.82 : 1,
      })}
    >
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: `${appTheme.colors.commerce}1f`, alignItems: 'center', justifyContent: 'center' }}>
        <Gift size={19} color={appTheme.colors.commerce} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="label" numberOfLines={1} style={{ fontSize: 14 }}>Invite & Earn</AppText>
        <AppText variant="caption" color="muted" numberOfLines={1}>Share your link and earn bonus credits</AppText>
      </View>
      <ChevronRight size={20} color={PROFILE_COLORS.faint} />
    </Pressable>
  );
}

function ProfileMediaHeader({
  activeTab,
  onTabChange,
  onRefresh,
  title,
}: {
  activeTab: ProfileMediaTab;
  onTabChange: (tab: ProfileMediaTab) => void;
  onRefresh?: () => void;
  title?: string;
}) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText variant="sectionTitle" numberOfLines={1} style={{ flex: 1, fontSize: 19, lineHeight: 24 }}>
          {title ?? getProfileMediaSectionTitle(activeTab)}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh media"
          disabled={!onRefresh}
          onPress={onRefresh}
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            borderRadius: 24,
            borderWidth: 1,
            borderColor: PROFILE_COLORS.border,
            backgroundColor: PROFILE_COLORS.surface,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: !onRefresh ? 0.45 : pressed ? 0.72 : 1,
          })}
        >
          <RefreshCw size={19} color={PROFILE_COLORS.muted} />
        </Pressable>
      </View>
      <ProfileSegment value={activeTab} onChange={onTabChange} />
    </View>
  );
}

function ProfileMediaEmpty({ title }: { title: string }) {
  return (
    <View
      style={{
        minHeight: 154,
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        gap: 8,
      }}
    >
      <ImageIcon size={30} color={appTheme.colors.faint} />
      <AppText variant="cardTitle">{title}</AppText>
      <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
        This section will fill as you save media, create generations, or publish posts.
      </AppText>
    </View>
  );
}

function ProfileGridFooterLoader() {
  return (
    <View style={{ minHeight: 52, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={PROFILE_COLORS.coral} />
    </View>
  );
}

function isProfileMediaSwipeGesture(gestureState: PanResponderGestureState) {
  const horizontalDistance = Math.abs(gestureState.dx);
  const verticalDistance = Math.abs(gestureState.dy);
  return horizontalDistance >= PROFILE_MEDIA_SWIPE_START_DISTANCE
    && horizontalDistance > verticalDistance * PROFILE_MEDIA_SWIPE_AXIS_RATIO;
}

function getProfileMediaSwipeDirection(gestureState: PanResponderGestureState): ProfileMediaSwipeDirection | null {
  const horizontalDistance = Math.abs(gestureState.dx);
  const verticalDistance = Math.abs(gestureState.dy);

  if (
    horizontalDistance < PROFILE_MEDIA_SWIPE_COMMIT_DISTANCE
    || horizontalDistance <= verticalDistance * PROFILE_MEDIA_SWIPE_AXIS_RATIO
  ) {
    return null;
  }

  return gestureState.dx < 0 ? 'left' : 'right';
}

function ProfileSegment({ value, onChange }: { value: ProfileMediaTab; onChange: (value: ProfileMediaTab) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, borderRadius: 18, borderWidth: 1, borderColor: PROFILE_COLORS.border, backgroundColor: PROFILE_COLORS.surface, padding: 4 }}>
      {PROFILE_MEDIA_TABS.map((tab) => {
        const active = tab === value;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityLabel={tab}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tab)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: appTheme.touch.compact,
              borderRadius: 14,
              backgroundColor: active ? PROFILE_COLORS.coral : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.78 : 1,
            })}
          >
            <Text numberOfLines={1} style={{ color: active ? '#111114' : PROFILE_COLORS.muted, fontSize: 12, fontWeight: '800' }}>{tab}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProfilePostsScopeControl({
  value,
  counts,
  onChange,
}: {
  value: ProfilePostsScope;
  counts?: Record<ProfilePostsScope, number>;
  onChange: (scope: ProfilePostsScope) => void;
}) {
  const options: Array<{ value: ProfilePostsScope; label: string }> = [
    { value: 'active', label: counts ? `Active (${counts.active})` : 'Active' },
    { value: 'archived', label: counts ? `Archived (${counts.archived})` : 'Archived' },
  ];
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Filter posts" style={{ flexDirection: 'row', gap: 8 }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active, checked: active }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              minHeight: appTheme.touch.compact,
              paddingHorizontal: 14,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: active ? PROFILE_COLORS.coral : PROFILE_COLORS.border,
              backgroundColor: active ? 'rgba(255, 122, 89, 0.14)' : PROFILE_COLORS.surface,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.78 : 1,
            })}
          >
            <Text numberOfLines={1} style={{ color: active ? PROFILE_COLORS.coral : PROFILE_COLORS.muted, fontSize: 12, fontWeight: '800' }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProfileMediaTile({
  item,
  width,
  height,
  fallbackAvatarUrl,
  fallbackAvatarInitials,
  highlighted,
}: {
  item: ProfileMediaCard;
  width: number;
  height: number;
  fallbackAvatarUrl?: string | null;
  fallbackAvatarInitials: string;
  highlighted?: boolean;
}) {
  const avatarUrl = item.avatarUrl ?? fallbackAvatarUrl ?? null;
  const avatarInitials = item.avatarUrl
    ? getGalleryInitials(item.avatarLabel ?? item.meta)
    : item.avatarLabel
      ? getGalleryInitials(item.avatarLabel)
      : fallbackAvatarInitials;
  const countLabel = item.countLabel ?? '0';
  const isFallbackPreview = item.id.startsWith('preview-');
  const isSavedTile = item.label === 'Saved';
  const accessibilityLabel = isSavedTile
    ? `${item.label}, ${item.title}, ${countLabel} likes`
    : item.label === 'Creation'
      ? `${item.label}, ${item.title}, ${item.linkedPostLabel ?? item.statusLabel ?? 'Status unavailable'}`
    : `${item.label}, ${item.title}`;
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressed });

  return (
    <MotionView style={[{ width, height }, motion.animatedStyle]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPressIn={motion.onPressIn}
      onPressOut={motion.onPressOut}
      onPress={() => {
        haptic.light();
        if (isFallbackPreview) {
          router.push(item.href as never);
          return;
        }
        if (item.previewKind === 'text' && item.label !== 'Creation') {
          router.push(textPostViewerHref({
            postId: item.sourceId,
            source: item.viewerSource === 'profile-posts'
              ? 'profile-posts'
              : item.viewerSource === 'profile-saved'
                ? 'profile-saved'
                : undefined,
          }) as never);
          return;
        }
        // Saved media is for looking at, so it opens the reel. Creations and Posts
        // are for managing, so they open the card feed with their controls inline.
        const href = (isSavedTile ? immersiveViewerHref : profileMediaFeedHref)({
          source: item.viewerSource,
          initialId: item.sourceId,
        });
        router.push(href as never);
      }}
      style={{ flex: 1 }}
    >
      <View
        testID={highlighted ? 'profile-highlighted-post-tile' : undefined}
        style={{
          flex: 1,
          overflow: 'hidden',
          borderRadius: 12,
          borderCurve: 'continuous',
          borderWidth: highlighted ? 2 : 1,
          borderColor: highlighted ? PROFILE_COLORS.coral : PROFILE_COLORS.border,
          backgroundColor: PROFILE_COLORS.surface,
        }}
      >
        <ProfileGalleryPreview item={item} height={height} />
        <LinearGradient
          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.16)', 'rgba(0,0,0,0.70)']}
          locations={[0, 0.48, 1]}
          style={{ position: 'absolute', inset: 0 }}
        />
        {item.mediaKind === 'video' ? (
          <View style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.38)' }}>
            <Play size={15} color="#ffffff" fill="#ffffff" strokeWidth={2.4} />
          </View>
        ) : null}
        {isSavedTile ? (
          <ProfileSavedFeedOverlay
            item={item}
            avatarUrl={avatarUrl}
            avatarInitials={avatarInitials}
            countLabel={countLabel}
          />
        ) : (
          <ProfileMinimalMediaOverlay item={item} />
        )}
      </View>
    </Pressable>
    </MotionView>
  );
}

function ProfileSavedFeedOverlay({
  item,
  avatarUrl,
  avatarInitials,
  countLabel,
}: {
  item: ProfileMediaCard;
  avatarUrl: string | null;
  avatarInitials: string;
  countLabel: string;
}) {
  return (
    <View testID="profile-saved-overlay" pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      <View
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          right: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          borderRadius: 14,
          backgroundColor: 'rgba(3,4,13,0.66)',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.16)',
          paddingHorizontal: 6,
          paddingVertical: 5,
        }}
      >
        <View
          style={{
            width: 21,
            height: 21,
            borderRadius: 10.5,
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#27272a',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.24)',
          }}
        >
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <Text style={{ color: '#fff', fontSize: 8, fontWeight: '800' }}>{avatarInitials}</Text>
          )}
        </View>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: '#ffffff', fontSize: 10, fontWeight: '800' }}>
          {item.avatarLabel || item.meta}
        </Text>
      </View>

      {/* The picture is the tile; a title on top of it competed with the
          picture on every cell. The like count stays, in white, as a quiet
          corner signal rather than a coral one. */}
      <View
        style={{
          position: 'absolute',
          right: 8,
          bottom: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <Heart size={14} color="#ffffff" fill="#ffffff" strokeWidth={2.2} />
        <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
          {countLabel}
        </Text>
      </View>
    </View>
  );
}

function ProfileMinimalMediaOverlay({ item }: { item: ProfileMediaCard }) {
  const accent = item.label === 'Creation' ? appTheme.colors.motion : appTheme.colors.image;
  const icon = item.label === 'Creation'
    ? <Sparkles size={13} color={accent} strokeWidth={2.4} />
    : item.mediaKind === 'video'
      ? <Play size={13} color={accent} fill={accent} strokeWidth={2.4} />
      : <ImageIcon size={13} color={accent} strokeWidth={2.4} />;
  const stateColor = item.label === 'Creation'
    ? item.linkedPostLabel && item.linkedPostLabel !== 'Not posted'
      ? appTheme.colors.success
      : appTheme.colors.motion
    : item.visibilityLabel === 'Public'
      ? appTheme.colors.success
      : item.visibilityLabel === 'Private'
        ? appTheme.colors.amber
        : appTheme.colors.image;

  return (
    <View testID="profile-minimal-overlay" pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      <View
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(3,4,13,0.62)',
          borderWidth: 1,
          borderColor: item.label === 'Creation' ? 'rgba(167,139,250,0.35)' : 'rgba(56,189,248,0.3)',
        }}
      >
        {icon}
      </View>

      <View
        style={{
          position: 'absolute',
          bottom: 8,
          left: 8,
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: stateColor,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.72)',
        }}
      />
    </View>
  );
}

function ProfileGalleryPreview({ item, height }: { item: ProfileMediaCard; height: number }) {
  const previewMediaUrl = item.previewState === 'videoPoster'
    ? item.previewUrl
    : item.previewState === 'image'
      ? item.previewUrl ?? item.mediaUrl
      : item.mediaKind === 'image'
        ? item.previewUrl ?? item.mediaUrl
        : null;
  if (previewMediaUrl) {
    return (
      <View style={{ width: '100%', height, overflow: 'hidden', backgroundColor: '#090914' }}>
        <StableMediaImage
          url={previewMediaUrl}
          cacheKey={item.previewCacheKey ?? item.id}
          thumbhash={item.previewThumbhash}
          contentFit="cover"
          transition={120}
          style={{ position: 'absolute', inset: 0 }}
        />
      </View>
    );
  }

  if (item.mediaKind === 'video' && item.mediaUrl) {
    return <ProfileVideoFallback item={item} height={height} />;
  }

  if (item.previewKind === 'text') {
    return <ProfileTextPreview item={item} height={height} />;
  }

  return (
    <ProfileUnavailableFallback item={item} height={height} showTitle={item.label !== 'Post'} />
  );
}

function ProfileTextPreview({ item, height }: { item: ProfileMediaCard; height: number }) {
  const accent = item.label === 'Creation' ? appTheme.colors.motion : appTheme.colors.info;
  const label = item.label === 'Creation' ? 'Text creation' : 'Text post';

  return (
    <View testID="profile-text-preview" style={{ height, overflow: 'hidden', backgroundColor: appTheme.colors.surfaceInset }}>
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 12, paddingTop: 46, paddingBottom: 14 }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: accent }} />
        <View
          style={{
            alignSelf: 'flex-start',
            borderRadius: 999,
            backgroundColor: `${accent}1f`,
            borderWidth: 1,
            borderColor: `${accent}66`,
            paddingHorizontal: 8,
            paddingVertical: 4,
            marginBottom: 8,
          }}
        >
          <Text numberOfLines={1} style={{ color: accent, fontSize: 9, fontWeight: '800' }}>{label}</Text>
        </View>
        <Text numberOfLines={5} style={{ color: '#ffffff', fontSize: 13, lineHeight: 16, fontWeight: '800' }}>
          {item.previewText || item.title}
        </Text>
      </View>
    </View>
  );
}

function ProfileVideoFallback({ item, height }: { item: ProfileMediaCard; height: number }) {
  const label = item.badge ?? 'Video';
  const statusLabel = item.previewStatusLabel ?? (item.label === 'Creation' ? 'Tap to view media' : 'Preview unavailable');

  return (
    <View testID="profile-video-preview-fallback" style={{ height, overflow: 'hidden', backgroundColor: appTheme.colors.surfaceInset }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: `${appTheme.colors.video}1f`,
            borderWidth: 1,
            borderColor: `${appTheme.colors.video}66`,
          }}
        >
          <Play size={18} color="#ffffff" fill="#ffffff" strokeWidth={2.3} />
        </View>
        <Text style={{ marginTop: 10, color: '#ffffff', fontSize: 12, fontWeight: '800' }}>{label}</Text>
        <Text
          numberOfLines={1}
          style={{ marginTop: 3, color: 'rgba(255,255,255,0.66)', fontSize: 9, fontWeight: '800' }}
        >
          {statusLabel}
        </Text>
      </View>
    </View>
  );
}

function ProfileUnavailableFallback({
  item,
  height,
  showTitle = true,
  statusLabel,
}: {
  item: ProfileMediaCard;
  height: number;
  showTitle?: boolean;
  statusLabel?: string;
}) {
  const accent = item.label === 'Creation' ? appTheme.colors.motion : appTheme.colors.image;

  return (
    <View testID="profile-art-preview-fallback" style={{ height, overflow: 'hidden', backgroundColor: appTheme.colors.surfaceInset }}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 10 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: `${accent}1f`,
            borderWidth: 1,
            borderColor: `${accent}66`,
          }}
        >
          {item.label === 'Creation'
            ? <Sparkles size={14} color={accent} strokeWidth={2.4} />
            : <ImageIcon size={14} color={accent} strokeWidth={2.4} />}
        </View>
        {showTitle ? (
          <Text numberOfLines={2} style={{ marginTop: 10, color: '#ffffff', fontSize: 11, lineHeight: 14, fontWeight: '800' }}>
            {item.title}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          style={{ marginTop: showTitle ? 4 : 10, color: 'rgba(255,255,255,0.66)', fontSize: 9, fontWeight: '800' }}
        >
          {statusLabel ?? item.previewStatusLabel ?? 'Preview unavailable'}
        </Text>
      </View>
    </View>
  );
}

function getGalleryInitials(label: string) {
  const words = label
    .replace(/@/g, '')
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join('') || 'C';
}
