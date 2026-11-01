import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useIsFocused, useScrollToTop } from '@react-navigation/native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  AtSign,
  AudioLines,
  ChevronRight,
  CircleAlert,
  Crown,
  Gift,
  Globe,
  Heart,
  ImageIcon,
  Images,
  LockKeyhole,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  UserRound,
  Wallet,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, Share, Text, useWindowDimensions, View, type PanResponderGestureState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StableMediaImage } from '@/components/media-preview';
import { ReturnedVideoPreview } from '@/components/returned-video-preview';
import { isAppleZoomAvailable } from '@/lib/apple-zoom-available';
import { getShowcasePlaybackUrl } from '@/lib/showcase-media';
import { FeedLoadMoreErrorFooter } from '@/components/feed-pagination-footer';
import { PushOfferCard } from '@/components/push-offer-card';
import { Reveal } from '@/components/reveal';
import { ProfileGridSkeleton } from '@/components/skeleton';
import { TopScrim } from '@/components/top-scrim';
import { AppText, IconButton, SecondaryButton, StatusBlock } from '@/components/ui';
import { loadActiveGenerationRecord } from '@/lib/active-generation-record';
import { useAppForeground } from '@/lib/app-foreground';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { isClaimedProfileUsername } from '@/lib/edit-profile-form';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
import { getGenerationKind, getGenerationLabel } from '@/lib/generation-media';
import { haptic } from '@/lib/haptics';
import { MediaZoomSourceView, MediaZoomSurface, useMediaZoomSource } from '@/components/media-zoom';
import { formatOutputCount, immersiveViewerHref, profileMediaFeedHref, textPostViewerHref } from '@/lib/immersive-preview-view-model';
import { MotionView, usePressMotion } from '@/lib/motion';
import {
  DEFAULT_PROFILE_MEDIA_TAB,
  FALLBACK_PROFILE_MEDIA,
  OWN_PROFILE_SHARE_SOURCE,
  PROFILE_MEDIA_EMPTY_BODY,
  PROFILE_MEDIA_TABS,
  generationToProfileMediaCard,
  getOwnerCreationScopeCounts,
  getOwnerPostScopeCounts,
  getProfileCreationsScopeOptions,
  getProfileMediaEmptyBody,
  getProfileMediaEmptyTitle,
  getProfileMediaSwipeTarget,
  getProfileHandle,
  getProfileInitials,
  getProfileName,
  getProfilePostsScopeOptions,
  getProfileStats,
  getWalletCardContent,
  ownProfileShareUrl,
  ownerPostToProfileMediaCard,
  savedShowcaseToProfileMediaCards,
  type ProfileCreationsScope,
  type ProfileMediaCard,
  type ProfileMediaSwipeDirection,
  type ProfileMediaTab,
  type ProfileMediaTabScope,
  type ProfilePostsScope,
  type ProfileScopeOption,
} from '@/lib/profile-view-model';
import { refreshProfileFailedCreationsHead, refreshProfileLibraryHead } from '@/lib/profile-library-head';
import { invalidateProfileStats } from '@/lib/profile-stats';
import {
  PROFILE_MEDIA_LOAD_MORE_COOLDOWN_MS,
  PROFILE_MEDIA_MIN_FILL_COUNT,
  PROFILE_RENDERING_REFRESH_INTERVAL_MS,
  flattenProfileGenerationPages,
  flattenProfileOwnerPostPages,
  formatRenderingStartedLabel,
  profileFailedGenerationsQueryKey,
  profileFailedGenerationsQueryOptions,
  profileGenerationsQueryOptions,
  profileOwnerPostsQueryOptions,
  profileSavedMediaQueryOptions,
  selectFailedCreations,
  selectRenderingCreations,
  truncateInfiniteDataToFirstPage,
} from '@/lib/profile-media-query';
import { useProfileMediaRevalidation } from '@/lib/use-profile-media-revalidation';
import { useCreatorPayoutState } from '@/lib/use-creator-payout-state';
import { flattenShowcaseFeedPages } from '@/lib/showcase-feed-query';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { formatCreditBalance } from '@/lib/pricing';
import { SHOWCASE_PLAYBACK_VIEWABILITY } from '@/lib/showcase-feed-events';
import { useTabBarAmbientFeed } from '@/lib/tab-bar-ambient';
import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme, mediaColors, themes } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type {
  CreatorToolId,
  GenerationListItem,
  GenerationListResponse,
  OwnerPostsResponse,
  ProfileResponse,
  ShowcaseFeedResponse,
} from '@/lib/types';
import type { AppleZoomOpen } from '@/lib/apple-zoom';

const PROFILE_GALLERY_COLUMNS = 3;
const PROFILE_GALLERY_GAP = 8;
const PROFILE_GALLERY_ASPECT_RATIO = 0.74;
const PROFILE_MEDIA_SWIPE_START_DISTANCE = 28;
const PROFILE_MEDIA_SWIPE_COMMIT_DISTANCE = 56;
const PROFILE_MEDIA_SWIPE_AXIS_RATIO = 1.25;
// Three rows rise into place when a tab's media lands; later rows mount plain.
const PROFILE_GALLERY_REVEAL_COUNT = PROFILE_GALLERY_COLUMNS * 3;

export function ProfileDashboard({
  initialTab = DEFAULT_PROFILE_MEDIA_TAB,
  highlightedPostId = null,
  justPublishedPostId = null,
}: {
  initialTab?: ProfileMediaTab;
  highlightedPostId?: string | null;
  /** A post the composer just published, which earns the notifications offer. */
  justPublishedPostId?: string | null;
} = {}) {
  const theme = useAppTheme();
  const { user, api, credits, creditsUpdatedAt, isGuest, identityUserId } = useAuth();
  // A guest's own creations are its library too, keyed by its identity: the
  // server serves a guest its creations, and Posts and Saved stay behind
  // sign-in (02-1). For an account this is its id.
  const creationsUserId = user?.id ?? (isGuest ? identityUserId ?? undefined : undefined);
  const guestCreations = !user && Boolean(creationsUserId);

  // Profile offered no way to share or preview the public page (the web
  // /profile has both). Filed as the owner's own share, not a visitor's.
  const shareOwnProfile = async (username: string, name: string) => {
    const url = ownProfileShareUrl(env.siteUrl, username);
    const result = await Share.share({ message: `${name} on Magicbooklet\n${url}`, url, title: name });
    if (result.action !== Share.sharedAction) return;
    await api.shareCreatorProfile(username, { sourceSurface: OWN_PROFILE_SHARE_SOURCE }).catch(() => null);
  };
  const isFocused = useIsFocused();
  const [activeTab, setActiveTab] = useState<ProfileMediaTab>(initialTab);
  // Archived posts live under their own scope of the Posts tab: the archive
  // dialog promises they can be restored from the profile, so they have to be
  // reachable here.
  const [creationsScope, setCreationsScope] = useState<ProfileCreationsScope>('active');
  // The library whose Failed scope has been opened: its query stays on from
  // then, since an infinite query that goes from off to on while stale requests
  // every page it holds again. Kept as the owner, not a flag, so the render in
  // which another library takes over never turns that library's query on.
  const [failedScopeOwner, setFailedScopeOwner] = useState<string | undefined>(undefined);
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
  const payoutQuery = useCreatorPayoutState();

  // The card feed and the reel read these same queries, so a tile can only ever
  // open onto the pages, order and freshness the grid is showing.
  const generationsQuery = useInfiniteQuery({
    ...profileGenerationsQueryOptions(api, creationsUserId),
    enabled: Boolean(creationsUserId && (activeTab === 'Creations' || backgroundMediaReady)),
  });
  // The Failed scope pages failed runs alone, from the first time it is opened;
  // the Creations tab then pages, refreshes and waits on it while it is shown.
  const failedGenerationsQuery = useInfiniteQuery({
    ...profileFailedGenerationsQueryOptions(api, creationsUserId),
    enabled: Boolean(creationsUserId && failedScopeOwner === creationsUserId),
  });
  const creationsQuery = creationsScope === 'failed' ? failedGenerationsQuery : generationsQuery;

  const postsQuery = useInfiniteQuery({
    ...profileOwnerPostsQueryOptions(api, user?.id),
    enabled: Boolean(user && (activeTab === 'Posts' || backgroundMediaReady)),
  });

  const savedQuery = useInfiniteQuery({
    ...profileSavedMediaQueryOptions(api, user?.id),
    enabled: Boolean(user && (activeTab === 'Saved' || backgroundMediaReady)),
  });

  const activeMediaQuery = activeTab === 'Saved'
    ? savedQuery
    : activeTab === 'Creations'
      ? creationsQuery
      : postsQuery;
  const {
    data: activeMediaData,
    isFetched: activeMediaIsFetched,
    isFetching: activeMediaIsFetching,
    isStale: activeMediaIsStale,
  } = activeMediaQuery;

  useEffect(() => {
    setBackgroundMediaReady(false);
  }, [user?.id]);

  // Failed stays while chosen; another library, a fresh guest's included, starts on Active.
  useEffect(() => {
    setCreationsScope('active');
  }, [creationsUserId]);

  // The Failed scope pages a query of its own, whose page count the last request's says nothing about.
  useEffect(() => {
    loadingMoreRef.current = false;
    lastLoadMoreAtRef.current = 0;
    lastLoadMorePageCountRef.current = null;
  }, [activeTab, creationsScope, creationsUserId]);

  useEffect(() => {
    if (user?.id && activeMediaIsFetched) {
      setBackgroundMediaReady(true);
    }
  }, [activeMediaIsFetched, user?.id]);

  // Freshness from events — focus, a tab change, the app returning — refreshing
  // only the first page. The effect this replaces re-fired whenever a fetch
  // settled, so a failing refresh looped, and each refetch re-requested every
  // page the reader had loaded (audit C7).
  const refreshMediaHead = useCallback(
    (library: string) => (library === 'Failed'
      // The library's first page as well as the scope's own: the Rendering
      // strip over Failed reads the library, so a run tried again from a
      // failure shows there, and its refresh brings it here if it fails again.
      ? Promise.all([
        refreshProfileLibraryHead({ api, queryClient, userId: creationsUserId, library: 'Creations' }),
        refreshProfileFailedCreationsHead({ api, queryClient, userId: creationsUserId }),
      ])
      : refreshProfileLibraryHead({
        api,
        queryClient,
        userId: creationsUserId,
        library: library as ProfileMediaTab,
      })),
    [api, queryClient, creationsUserId]
  );
  // The events that read the runs again read the Creations scope totals with
  // them: a run that failed while the reader was in a creator never passed
  // through the Rendering strip, which reads them as a run leaves it.
  const revalidateMediaHead = useCallback((library: string) => {
    if (library === 'Creations' || library === 'Failed') void invalidateProfileStats(queryClient, user?.id);
    return refreshMediaHead(library);
  }, [queryClient, refreshMediaHead, user?.id]);
  useProfileMediaRevalidation({
    // A guest has only its Creations to keep fresh.
    enabled: isFocused && (Boolean(user) || (guestCreations && activeTab === 'Creations')),
    // The Failed scope's pages are a library of their own, with their own schedule.
    scope: activeTab === 'Creations' && creationsScope === 'failed' ? 'Failed' : activeTab,
    hasData: Boolean(activeMediaData),
    isFetching: activeMediaIsFetching,
    isStale: activeMediaIsStale,
    refresh: revalidateMediaHead,
  });

  const savedCards = useMemo(
    () => savedShowcaseToProfileMediaCards(flattenShowcaseFeedPages(savedQuery.data?.pages)),
    [savedQuery.data]
  );
  const allCreationCards = useMemo(
    () => flattenProfileGenerationPages(generationsQuery.data?.pages)
      .map(generationToProfileMediaCard)
      .filter((card) => card.isGridReady),
    [generationsQuery.data]
  );
  const activeCreationCards = useMemo(() => allCreationCards.filter((card) => !card.isArchived), [allCreationCards]);
  const archivedCreationCards = useMemo(() => allCreationCards.filter((card) => card.isArchived), [allCreationCards]);
  const renderingCreations = useMemo(
    () => selectRenderingCreations(flattenProfileGenerationPages(generationsQuery.data?.pages)),
    [generationsQuery.data]
  );
  // The Failed scope's runs: its own pages once they have come, and until then
  // the failures the library has loaded, so opening it draws what is known.
  // Filtered either way: a server from before `status=failed` sends every run.
  const failedCreations = useMemo(
    () => selectFailedCreations(flattenProfileGenerationPages((failedGenerationsQuery.data ?? generationsQuery.data)?.pages)),
    [failedGenerationsQuery.data, generationsQuery.data]
  );
  // The Failed scope's rows: the list pages, windows and recycles them as it does tiles.
  const failedCreationCards = useMemo(() => failedCreations.map(generationToProfileMediaCard), [failedCreations]);
  const creationCardsByScope: Record<ProfileCreationsScope, ProfileMediaCard[]> = {
    active: activeCreationCards,
    failed: failedCreationCards,
    archived: archivedCreationCards,
  };
  const creationCards = creationCardsByScope[creationsScope];
  // Over Failed as well as Active: a run tried again from its failure is watched
  // from here, and one that fails again joins the list under the strip.
  const showRenderingStrip = activeTab === 'Creations' && creationsScope !== 'archived' && renderingCreations.length > 0;
  // The run a Rendering tile opened. Its status page in the reel reads this
  // library, and Profile, under the reel and out of focus, keeps reading the
  // first page while the run renders, so that page turns into the run's media,
  // or its failure, while the reader watches it there.
  const [watchedRunId, setWatchedRunId] = useState<string | null>(null);
  useEffect(() => {
    if (isFocused) setWatchedRunId(null);
  }, [isFocused]);
  const watchingRun = watchedRunId !== null && renderingCreations.some((item) => item.id === watchedRunId);
  const appForeground = useAppForeground(showRenderingStrip);
  // While the strip shows a run, the first page is read again every 15 s and
  // merged, as every refresh here is, so a finished run leaves the strip for the
  // grid without a pull. A plain refetch would request every page loaded.
  useEffect(() => {
    if (!showRenderingStrip || !(isFocused || watchingRun) || !appForeground) return;
    const timer = setInterval(() => {
      void refreshMediaHead('Creations').catch(() => undefined);
    }, PROFILE_RENDERING_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [appForeground, isFocused, refreshMediaHead, showRenderingStrip, watchingRun]);
  // A run leaving the strip has finished or failed: the totals the header and
  // the scope chips read have moved, and a failure belongs on the Failed
  // scope's first page, read again here once that scope has been opened.
  const renderingIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ids = new Set(renderingCreations.map((item) => item.id));
    const left = [...renderingIdsRef.current].some((id) => !ids.has(id));
    renderingIdsRef.current = ids;
    if (!left) return;
    void invalidateProfileStats(queryClient, user?.id);
    void refreshProfileFailedCreationsHead({ api, queryClient, userId: creationsUserId }).catch(() => undefined);
  }, [api, creationsUserId, queryClient, renderingCreations, user?.id]);
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
  const profile = profileQuery.data;
  const wallet = getWalletCardContent(payoutQuery);
  const creditBalance = fresherCreditBalance({
    authCredits: credits,
    authUpdatedAt: creditsUpdatedAt,
    profileCredits: profile?.credits,
    profileUpdatedAt: profileQuery.dataUpdatedAt,
  });
  const displayName = getProfileName(profile, user?.email);
  const handle = getProfileHandle(profile, user?.email);
  const initials = getProfileInitials(profile, user?.email);
  // Server totals first; a loaded library's paged count with a `+` while a
  // server without them is live; a dash for a library that has not answered.
  const stats = getProfileStats({
    totals: profile?.stats ?? null,
    generationsCount: activeCreationCards.length,
    generationsHasMore: generationsQuery.hasNextPage,
    generationsLoaded: Boolean(generationsQuery.data),
    postsCount: activePostCards.length,
    postsHasMore: postsQuery.hasNextPage,
    postsLoaded: Boolean(postsQuery.data),
    savedCount: savedCards.length,
    savedHasMore: savedQuery.hasNextPage,
    savedLoaded: Boolean(savedQuery.data),
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
    // The Failed scope waits on its first page only with nothing to draw meanwhile.
    || (activeTab === 'Creations' && creationsQuery.isLoading && creationCards.length === 0)
    || (activeTab === 'Posts' && postsQuery.isLoading);
  const activeTabPaging = activeTab === 'Saved'
    ? savedQuery
    : activeTab === 'Creations'
      ? creationsQuery
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
      void creationsQuery.fetchNextPage().finally(() => { loadingMoreRef.current = false; });
      return;
    }
    void postsQuery.fetchNextPage().finally(() => { loadingMoreRef.current = false; });
  }, [
    activeHasNextPage,
    activeIsFetchingNextPage,
    activeMediaIsFetching,
    activePageCount,
    activeTab,
    creationsQuery,
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
  // Choosing Failed turns its query on for this library from then on.
  const changeCreationsScope = useCallback((scope: ProfileCreationsScope) => {
    setCreationsScope(scope);
    if (scope === 'failed') setFailedScopeOwner(creationsUserId);
  }, [creationsUserId]);
  const handleMediaSwipe = useCallback((direction: ProfileMediaSwipeDirection) => {
    setActiveTab((currentTab) => getProfileMediaSwipeTarget(currentTab, direction));
  }, []);
  // Collapse back to a single page before refetching, otherwise React Query refetches every
  // page the user has scrolled through.
  // `pullRefreshing` keeps the RefreshControl off query fetch state: on iOS a
  // programmatic `refreshing` drags the list down and can strand it there, so
  // only a refresh the user asked for may engage the control (see the note in
  // app/(tabs)/showcase.tsx). Background refetches update the grid silently.
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const refreshActiveMedia = () => {
    haptic.light();
    setPullRefreshing(true);
    loadingMoreRef.current = false;
    lastLoadMoreAtRef.current = 0;
    lastLoadMorePageCountRef.current = null;

    if (activeTab === 'Saved') {
      queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(
        ['profile-saved-media', user?.id],
        truncateInfiniteDataToFirstPage
      );
      void savedQuery.refetch().finally(() => setPullRefreshing(false));
      return;
    }
    if (activeTab === 'Creations') {
      queryClient.setQueryData<InfiniteData<GenerationListResponse>>(
        creationsScope === 'failed' ? profileFailedGenerationsQueryKey(creationsUserId) : ['profile-generations', creationsUserId],
        truncateInfiniteDataToFirstPage
      );
      // The scope chips' totals ride on the profile: a pull reads them again with the runs.
      void invalidateProfileStats(queryClient, user?.id);
      // Over Failed the library's first page is merged too, for the Rendering strip.
      if (creationsScope === 'failed') void refreshMediaHead('Creations').catch(() => undefined);
      void creationsQuery.refetch().finally(() => setPullRefreshing(false));
      return;
    }
    queryClient.setQueryData<InfiniteData<OwnerPostsResponse>>(
      ['profile-owner-posts', user?.id],
      truncateInfiniteDataToFirstPage
    );
    void postsQuery.refetch().finally(() => setPullRefreshing(false));
  };

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  if (!user && !(guestCreations && activeTab === 'Creations')) {
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

  // The public page and its link wait for a claimed handle. Every account
  // starts on a `creator-xxxxxxxx` placeholder, whose page stops resolving the
  // moment a handle is claimed; until then the hero offers to claim one.
  const publicUsername = profile?.username && isClaimedProfileUsername(profile.username) ? profile.username : null;
  // Said once the guest has something to keep, so it never names an empty grid;
  // failed runs wait under their own chip.
  const guestHasCreations = allCreationCards.length > 0 || renderingCreations.length > 0;
  // Each tab's chips and empty state read only that tab's scopes, and its chips
  // set only its own: Posts can never be handed Failed. Saved has no chips. The
  // empty state names the tab shown, narrowed rather than retyped, so it cannot
  // describe another one, and a tab added later must be given its own case.
  const tabScope: ProfileMediaTabScope = activeTab === 'Creations'
    ? [activeTab, creationsScope]
    : activeTab === 'Posts' ? [activeTab, postsScope] : [activeTab];
  const scopeControl = activeTab === 'Creations' ? (
    <ProfileMediaScopeControl
      label="Filter creations"
      value={creationsScope}
      options={getProfileCreationsScopeOptions(creationsScope, getOwnerCreationScopeCounts(profile?.stats, {
        active: activeCreationCards.length,
        failed: failedCreations.length,
        archived: archivedCreationCards.length,
      }))}
      onChange={changeCreationsScope}
    />
  ) : activeTab === 'Posts' ? (
    <ProfileMediaScopeControl
      label="Filter posts"
      value={postsScope}
      options={getProfilePostsScopeOptions(getOwnerPostScopeCounts(profile?.stats, {
        active: activePostCards.length,
        archived: archivedPostCards.length,
      }))}
      onChange={setPostsScope}
    />
  ) : null;

  return (
    <ProfileMediaList
      activeTab={activeTab}
      cards={tabCards}
      contentBottomPadding={tabBarMetrics.contentBottomOverlapPadding}
      emptyTitle={getProfileMediaEmptyTitle(...tabScope)}
      emptyBody={getProfileMediaEmptyBody(...tabScope)}
      fallbackAvatarInitials={initials}
      fallbackAvatarUrl={profile?.avatarUrl}
      scopeControl={scopeControl}
      renderingCreations={showRenderingStrip ? renderingCreations : undefined}
      // Times on the strip are as of the page they were read from, which the
      // 15 s refresh renews; a clock read during render would be kept by memo.
      renderingAsOf={generationsQuery.dataUpdatedAt}
      onRenderingRunOpen={setWatchedRunId}
      // Never over the Failed scope: its runs made nothing to keep.
      notice={!user && guestHasCreations && creationsScope !== 'failed' ? <GuestCreationsNotice /> : undefined}
      header={user ? (
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
            onViewPublic={publicUsername ? () => router.push(`/creators/${encodeURIComponent(publicUsername)}` as never) : undefined}
            onShare={publicUsername ? () => void shareOwnProfile(publicUsername, displayName) : undefined}
            onClaimHandle={profile && !publicUsername ? () => router.push('/edit-profile' as never) : undefined}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {/* The balance opens what moved it, as the Wallet opens Your Sales
                (D6, finding 03-11); the history offers the credit packs from
                its balance, and Settings and the side menu still open them. */}
            <BalanceCard
              icon={<Crown size={appTheme.icon.default} color={theme.colors.commerce} />}
              label="Credits"
              value={formatCreditBalance(creditBalance)}
              accessibilityLabel={creditBalance === null ? 'Credits, balance loading' : `Credits, ${formatCreditBalance(creditBalance)}`}
              accessibilityHint="Opens your credit history"
              onPress={() => router.push('/credit-history' as never)}
            />
            <BalanceCard
              icon={<Wallet size={appTheme.icon.default} color={theme.colors.primary} />}
              label="Wallet"
              value={wallet.value}
              caption={wallet.caption}
              accessibilityLabel={wallet.accessibilityLabel}
              // The way to Recipe Sales on the profile; the side menu has the other.
              accessibilityHint="Opens Recipe Sales"
              onPress={() => router.push('/seller-dashboard' as never)}
            />
          </View>
          <InviteAndEarnButton />
        </>
      ) : (
        <>
          <ProfileTitle />
          <SignedOutCard />
        </>
      )}
      horizontalPadding={horizontalPadding}
      highlightedPostId={highlightedPostId}
      justPublishedPostId={justPublishedPostId}
      isFetchNextPageError={activeIsFetchNextPageError}
      isFetchingNextPage={activeIsFetchingNextPage}
      isLoading={isMediaLoading}
      isRefreshing={pullRefreshing}
      mediaError={mediaError}
      onEndReached={requestNextPage}
      onRetryNextPage={retryNextPage}
      onRefresh={refreshActiveMedia}
      onSwipeTab={handleMediaSwipe}
      onTabChange={handleMediaTabChange}
      topInset={topInset}
    />
  );
}

function ProfileMediaList({
  activeTab,
  cards,
  contentBottomPadding,
  emptyBody,
  emptyTitle,
  fallbackAvatarInitials,
  fallbackAvatarUrl,
  header,
  horizontalPadding,
  highlightedPostId,
  justPublishedPostId,
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
  scopeControl,
  renderingAsOf = 0,
  renderingCreations,
  onRenderingRunOpen,
  notice,
  topInset,
}: {
  activeTab: ProfileMediaTab;
  cards: ProfileMediaCard[];
  contentBottomPadding: number;
  emptyBody?: string;
  emptyTitle: string;
  fallbackAvatarInitials: string;
  fallbackAvatarUrl?: string | null;
  header: React.ReactNode;
  horizontalPadding: number;
  highlightedPostId?: string | null;
  justPublishedPostId?: string | null;
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
  /** The chips under the tabs, which the dashboard builds from the shown tab's own scopes. */
  scopeControl?: React.ReactNode;
  renderingAsOf?: number;
  renderingCreations?: GenerationListItem[];
  /** A Rendering tile opened its run's status page. */
  onRenderingRunOpen?: (generationId: string) => void;
  /** A line above the grid about the reader's own media (a guest's creations). */
  notice?: React.ReactNode;
  topInset: number;
}) {
  const theme = useAppTheme();
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

  // Focus is read here rather than threaded down from ProfileDashboard: the
  // grid is the thing that knows which tiles are on screen, so the reset and the
  // reporting stay in one component.
  const isFocused = useIsFocused();
  const reportAmbientMedia = useTabBarAmbientFeed(isFocused);
  const visibleIds = useRef(new Set<string>());
  const revealItem = useCallback((itemId: string) => {
    if (visibleIds.current.has(itemId) || isLoading) return;
    const index = cards.findIndex(card => card.sourceId === itemId);
    if (index >= 0) void listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
  }, [cards, isLoading]);
  const viewabilityConfigCallbackPairs = useRef([
    {
      viewabilityConfig: SHOWCASE_PLAYBACK_VIEWABILITY,
      onViewableItemsChanged: reportAmbientMedia,
    },
    {
      viewabilityConfig: { itemVisiblePercentThreshold: 50 },
      onViewableItemsChanged: ({ viewableItems }: { viewableItems: { item: ProfileMediaCard }[] }) => {
        visibleIds.current = new Set(viewableItems.map(({ item }) => item.sourceId));
      },
    },
  ]).current;

  // The notifications offer and the Rendering strip join the header one commit
  // after the first page does. FlashList sizes the render that delivers its
  // first data against the previous render's header height, so a header that
  // grows in that same render leaves its scroll offset stale (Explore's
  // first-visit autoplay bug).
  const [headerExtrasReady, setHeaderExtrasReady] = useState(false);
  useEffect(() => {
    if (!isLoading) setHeaderExtrasReady(true);
  }, [isLoading]);
  const pushOfferPostId = headerExtrasReady && activeTab === 'Posts' ? justPublishedPostId : null;

  return (
    // Saved tiles here are what the reel grows out of and returns to.
    <MediaZoomSurface revealItem={revealItem}>
    <View {...swipeResponder.panHandlers} style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <FlashList
        keyboardShouldPersistTaps="never"
        ref={listRef}
        data={isLoading ? [] : cards}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        drawDistance={400}
        extraData={`${activeTab}:${isFocused}`}
        getItemType={(item) => (item.runFailed ? 'failed' : item.mediaKind ?? item.previewKind)}
        keyExtractor={(item) => `${item.label}-${item.id}`}
        ListHeaderComponent={(
          <View style={{ gap: 14, paddingBottom: 12 }}>
            {header}
            <ProfileMediaHeader
              activeTab={activeTab}
              onRefresh={onRefresh}
              onTabChange={onTabChange}
            />
            {scopeControl}
            {headerExtrasReady && notice ? notice : null}
            {headerExtrasReady && renderingCreations?.length ? (
              <ProfileRenderingStrip
                items={renderingCreations}
                asOf={renderingAsOf}
                tileWidth={cardWidth}
                onOpenRun={onRenderingRunOpen}
              />
            ) : null}
            {pushOfferPostId ? (
              <PushOfferCard key={`post:${pushOfferPostId}`} moment="post" occasion={`post:${pushOfferPostId}`} />
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
          <ProfileMediaEmpty title={emptyTitle} body={emptyBody} />
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
            {item.runFailed ? (
              <ProfileFailedTile item={item} width={cardWidth} />
            ) : (
              <ProfileMediaTile
                item={item}
                width={cardWidth}
                height={cardHeight}
                // A background tab's views are detached and never start loading,
                // so tiles only count down to a stall while Profile is on screen.
                mediaWatchdog={isFocused}
                fallbackAvatarUrl={fallbackAvatarUrl}
                fallbackAvatarInitials={fallbackAvatarInitials}
                highlighted={activeTab === 'Posts' && highlightedPostId === item.sourceId}
              />
            )}
          </Reveal>
        )}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: topInset + 12,
          paddingHorizontal: horizontalPadding,
          paddingBottom: contentBottomPadding + 20,
        }}
      />

      <TopScrim topInset={topInset} />
    </View>
    </MediaZoomSurface>
  );
}

/**
 * `pageTitle` unmodified, and announced as a header — the same two things the
 * other tab roots do (Explore, Alerts).
 *
 * The old title took `sectionTitle` and then overrode `fontWeight` back to
 * `'800'`, which is exactly what every display variant sets `'400'` to avoid.
 * Captured on both platforms: iOS keeps the Bricolage face and ignores the
 * incompatible weight, but **Android drops the face altogether** and renders
 * the system sans — so the app's own front-door title was the one title on
 * Android not in the app's typeface. The registered family carries a single
 * weight, and asking Android for a heavier one loses the family rather than
 * synthesizing within it.
 *
 * The strapline below it is gone. Branding: "people seldom need to be reminded
 * which app they're using, and it's usually better to use the space to give
 * people valuable information and controls" — and the card immediately beneath
 * this title already shows the identity, the balance and the counts it was
 * describing.
 */
function ProfileTitle() {
  return (
    <View style={{ minHeight: 40, justifyContent: 'center' }}>
      <AppText variant="pageTitle" accessibilityRole="header" numberOfLines={1}>
        Profile
      </AppText>
    </View>
  );
}

function SignedOutCard() {
  const theme = useAppTheme();
  return (
    <View
      style={{
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panel,
        padding: 18,
        gap: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
        <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.panelSoft, borderWidth: 1, borderColor: theme.colors.borderStrong }}>
          <UserRound size={appTheme.icon.feature} color={theme.colors.muted} />
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
        // Back to Profile once signed in: without it sign-in ends on Home.
        onPress={() => router.push({ pathname: '/auth', params: { returnTo: '/profile' } } as never)}
        style={({ pressed }) => ({
          minHeight: 50,
          borderRadius: 18,
          backgroundColor: theme.colors.primaryFill,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        <Text style={{ color: theme.colors.onPrimary, fontSize: 15, fontWeight: '800' }}>Sign in</Text>
      </Pressable>
    </View>
  );
}

/**
 * Above a guest's creations. They belong to this device's guest identity until
 * an account is made, and an account keeps them on every device (02-1): the
 * offer Pricing makes a guest who buys, made where the creations are.
 */
function GuestCreationsNotice() {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Create an account to keep these on every device"
      accessibilityHint="Opens sign-up"
      // Back to Profile once the account exists, where these creations then are.
      onPress={() => router.push({ pathname: '/auth', params: { mode: 'signup', returnTo: '/profile' } } as never)}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 14,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panel,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <UserRound size={appTheme.icon.sm} color={theme.colors.primary} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="label">Create an account to keep these on every device</AppText>
        <AppText variant="caption" color="muted">Until then they stay on this device.</AppText>
      </View>
      <ChevronRight size={appTheme.icon.sm} color={theme.colors.faint} />
    </Pressable>
  );
}

/**
 * The balance the Credits card shows: the auth context's when it was set after
 * the profile was read (a purchase, a run's charge, a refresh on resume), else
 * the profile's, read with the page. The card preferred the auth copy however
 * old it was, so a purchase push that opened Profile showed the balance from
 * before the purchase over the profile it had just read (03-4).
 */
function fresherCreditBalance({
  authCredits,
  authUpdatedAt,
  profileCredits,
  profileUpdatedAt,
}: {
  authCredits: number | null;
  /** When this run last set the auth balance, epoch ms; null when it never has. */
  authUpdatedAt: number | null | undefined;
  profileCredits: number | null | undefined;
  /** The profile query's `dataUpdatedAt`: 0 before it has answered. */
  profileUpdatedAt: number;
}): number | null {
  if (profileCredits === null || profileCredits === undefined) return authCredits;
  if (authCredits === null) return profileCredits;
  return typeof authUpdatedAt === 'number' && authUpdatedAt > profileUpdatedAt ? authCredits : profileCredits;
}

function ProfileHeroCard({
  profile,
  displayName,
  handle,
  initials,
  email,
  stats,
  onEdit,
  onViewPublic,
  onShare,
  onClaimHandle,
}: {
  profile?: ProfileResponse | null;
  displayName: string;
  handle: string;
  initials: string;
  email?: string;
  stats: ReturnType<typeof getProfileStats>;
  onEdit: () => void;
  /** Present once a handle is claimed: the public page exists then. */
  onViewPublic?: () => void;
  onShare?: () => void;
  /** Present while the account still holds the signup placeholder. */
  onClaimHandle?: () => void;
}) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        overflow: 'hidden',
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panel,
      }}
    >
      <View style={{ height: 84, overflow: 'hidden', backgroundColor: theme.colors.panelSoft }}>
        {profile?.coverUrl ? (
          <Image source={{ uri: profile.coverUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <View style={{ width: 36, height: 1, backgroundColor: theme.colors.borderStrong }} />
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.primary }} />
            <View style={{ width: 36, height: 1, backgroundColor: theme.colors.borderStrong }} />
          </View>
        )}
        {profile?.coverUrl ? <LinearGradient colors={[hexWithAlpha(mediaColors.mediaGround, 0.06), hexWithAlpha(mediaColors.mediaGround, 0.56)]} style={{ position: 'absolute', inset: 0 }} /> : null}
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
              backgroundColor: theme.colors.primaryFill,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              paddingHorizontal: 16,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Pencil size={appTheme.icon.sm} color={theme.colors.onPrimary} />
            {/* The name the control has always had in its accessibility label,
                now the name it draws — and the name the screen it opens gives
                itself. S10's rule, on a smaller scale: a destination answers to
                the control that reaches it. */}
            <Text style={{ color: theme.colors.onPrimary, fontSize: 14, fontWeight: '800' }}>Edit profile</Text>
          </Pressable>
        </View>
        {onViewPublic || onShare ? (
          <View style={{ flexDirection: 'row', gap: 8, paddingTop: 10 }}>
            {onViewPublic ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="View public profile"
                onPress={onViewPublic}
                style={({ pressed }) => ({
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '700' }}>View public profile</Text>
              </Pressable>
            ) : null}
            {onShare ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Share profile"
                onPress={onShare}
                style={({ pressed }) => ({
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '700' }}>Share profile</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {onClaimHandle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Claim your handle"
            accessibilityHint="Opens Edit profile"
            onPress={onClaimHandle}
            style={({ pressed }) => ({
              marginTop: 10,
              minHeight: 44,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: theme.colors.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingHorizontal: 12,
              paddingVertical: 8,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <AtSign size={appTheme.icon.sm} color={theme.colors.primary} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, fontWeight: '700' }}>Claim your handle</Text>
              {/* The web's line for the same step (`/profile`'s setup card). */}
              <Text numberOfLines={2} style={{ color: theme.colors.muted, fontSize: 12, lineHeight: 16 }}>
                Choose a custom handle for your public URL
              </Text>
            </View>
            <ChevronRight size={appTheme.icon.sm} color={theme.colors.faint} />
          </Pressable>
        ) : null}

        <View style={{ gap: 5, paddingTop: 12 }}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: theme.colors.text, fontSize: 23, lineHeight: 28, fontWeight: '800', letterSpacing: -0.35 }}>{displayName}</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '800' }}>{handle}</Text>
          {profile?.bio ? (
            <Text numberOfLines={2} style={{ color: theme.colors.muted, fontSize: 13, lineHeight: 19 }}>{profile.bio}</Text>
          ) : (
            <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 13, lineHeight: 19 }}>
              {email ? `Signed in as ${email}` : 'Creator profile ready for saved media and posts.'}
            </Text>
          )}
        </View>

        <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 13 }} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {stats.map((stat) => (
            <View key={stat.label} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 5 }}>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: theme.colors.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{stat.value}</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700' }}>{stat.label}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function ProfileAvatar({ profile, initials }: { profile?: ProfileResponse | null; initials: string }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        width: 68,
        height: 68,
        borderRadius: 34,
        padding: 3,
        backgroundColor: theme.colors.background,
      }}
    >
        <View style={{ flex: 1, overflow: 'hidden', borderRadius: 31, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.panelSoft, borderWidth: 2, borderColor: theme.colors.primary }}>
          {profile?.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <Text style={{ color: theme.colors.text, fontSize: 21, fontWeight: '800' }}>{initials}</Text>
          )}
        </View>
    </View>
  );
}

function BalanceCard({
  icon,
  label,
  value,
  caption,
  accessibilityLabel = label,
  accessibilityHint,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** What the figure is, when the label alone does not say. */
  caption?: string;
  accessibilityLabel?: string;
  /** Where the card goes, when its label does not say. */
  accessibilityHint?: string;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 74,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panel,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        // Room above and below once a caption makes the text taller than the card.
        paddingVertical: 10,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.panelSoft }}>
        {icon}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Text>
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.74} style={{ color: theme.colors.text, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
        {/* Two lines in a half-width card on most phones, and free to wrap
            further at larger text sizes rather than be cut off. Part of a
            button, so not selectable text. */}
        {caption ? (
          <AppText variant="caption" color="muted" selectable={false}>{caption}</AppText>
        ) : null}
      </View>
      <ChevronRight size={16} color={theme.colors.faint} />
    </Pressable>
  );
}

function InviteAndEarnButton() {
  const theme = useAppTheme();
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
        borderColor: `${theme.colors.commerce}55`,
        backgroundColor: `${theme.colors.commerce}0f`,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: `${theme.colors.commerce}1f`, alignItems: 'center', justifyContent: 'center' }}>
        <Gift size={appTheme.icon.default} color={theme.colors.commerce} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="label" numberOfLines={1} style={{ fontSize: 14 }}>Invite & Earn</AppText>
        <AppText variant="caption" color="muted" numberOfLines={1}>Share your link and earn bonus credits</AppText>
      </View>
      <ChevronRight size={20} color={theme.colors.faint} />
    </Pressable>
  );
}

/**
 * The section title above this control used to name the selected tab -- literally
 * "Creations" over a pill reading "Creations", and "Saved Media" over one reading
 * "Saved". Segmented controls: "A segmented control that displays text labels
 * doesn't need introductory text." The control keeps the naming; refresh moves
 * onto its row rather than being left alone on a heading row with nothing to head.
 */
function ProfileMediaHeader({
  activeTab,
  onTabChange,
  onRefresh,
}: {
  activeTab: ProfileMediaTab;
  onTabChange: (tab: ProfileMediaTab) => void;
  onRefresh?: () => void;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ProfileSegment value={activeTab} onChange={onTabChange} />
      </View>
      <IconButton
        disabled={!onRefresh}
        icon={RefreshCw}
        label={`Refresh ${activeTab}`}
        onPress={onRefresh}
      />
    </View>
  );
}

/**
 * Runs still rendering, above the grid and read from its query. The grid keeps
 * the library rule, under which a run with nothing to play is not a member, so
 * these get a row of their own; Home's "render in progress" opens onto it.
 */
function ProfileRenderingStrip({
  items,
  asOf,
  tileWidth,
  onOpenRun,
}: {
  items: GenerationListItem[];
  asOf: number;
  tileWidth: number;
  onOpenRun?: (generationId: string) => void;
}) {
  const { identityUserId } = useAuth();
  // The run this device started and is still watching for, which its creator
  // picks up again with live progress (`lib/active-generation-record.ts`).
  const [resumable, setResumable] = useState<{ generationId: string | null; tool: CreatorToolId } | null>(null);
  const runIds = items.map((item) => item.id).join(',');
  useEffect(() => {
    if (!identityUserId) return;
    let active = true;
    void loadActiveGenerationRecord(identityUserId).then(
      (record) => {
        if (active) setResumable(record);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [identityUserId, runIds]);

  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      <AppText variant="label" color="muted" accessibilityRole="header">
        {`Rendering (${items.length})`}
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: PROFILE_GALLERY_GAP }}>
        {items.map((item) => (
          <ProfileRenderingTile
            key={item.id}
            item={item}
            asOf={asOf}
            width={tileWidth}
            resumeTool={resumable?.generationId === item.id ? resumable.tool : null}
            onOpen={onOpenRun}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * One rendering run. A tap opens its status page in the reel, which follows the
 * run to its end. The creator picks a run up only from the record this device
 * keeps, so it is offered as Resume for that run alone: for any other run (one
 * started on the web, a second one, an older one) it opened blank, with Generate
 * ready to charge for another (audit 02-8).
 */
function ProfileRenderingTile({
  item,
  asOf,
  width,
  resumeTool,
  onOpen,
}: {
  item: GenerationListItem;
  asOf: number;
  width: number;
  resumeTool: CreatorToolId | null;
  onOpen?: (generationId: string) => void;
}) {
  const theme = useAppTheme();
  const label = getGenerationLabel(getGenerationKind(item), item.audioKind);
  const started = formatRenderingStartedLabel(item.created_at, asOf);
  const spokenLabel = `${label}, rendering, ${started.toLowerCase()}`;

  return (
    <View
      style={{
        width,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panel,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spokenLabel}
        accessibilityHint="Opens the run's status"
        onPress={() => {
          onOpen?.(item.id);
          router.push(immersiveViewerHref({ source: 'profile-creations', initialId: item.id }) as never);
        }}
        style={({ pressed }) => ({ minHeight: 84, padding: 10, gap: 6, opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <ActivityIndicator color={theme.colors.primary} size="small" style={{ alignSelf: 'flex-start' }} />
        <AppText variant="label" numberOfLines={1}>{label}</AppText>
        <AppText variant="caption" color="muted" numberOfLines={2}>{started}</AppText>
      </Pressable>
      {resumeTool ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Resume in the ${resumeTool} creator`}
          onPress={() => router.push(`/create/${resumeTool}` as never)}
          style={({ pressed }) => ({
            minHeight: 44,
            justifyContent: 'center',
            paddingHorizontal: 10,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <AppText variant="label" color="primary" numberOfLines={1}>Resume</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * A row of the Failed scope: the web Studio's Failed section, under a chip of
 * its own so the Active grid starts with what was made. Failed runs are not
 * library members, so a run that failed while Profile showed it left the
 * Rendering strip for nowhere, findable again only through its alert (audit
 * 01-9). The tile opens the run's status page, where its alert lands too: what
 * came back, why it failed, and Try again, Archive and Delete.
 */
function ProfileFailedTile({ item, width }: { item: ProfileMediaCard; width: number }) {
  const theme = useAppTheme();
  const label = item.badge ?? 'Creation';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, failed, ${item.title}`}
      accessibilityHint="Opens what happened to the run"
      onPress={() => router.push(immersiveViewerHref({ source: 'studio-creations', initialId: item.sourceId }) as never)}
      style={({ pressed }) => ({
        width,
        minHeight: 84,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panel,
        padding: 10,
        gap: 6,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <CircleAlert size={appTheme.icon.sm} color={theme.colors.danger} />
      <AppText variant="label" color="danger" numberOfLines={1}>Failed</AppText>
      <AppText variant="caption" color="muted" numberOfLines={2}>{item.title}</AppText>
    </Pressable>
  );
}

function ProfileMediaEmpty({ title, body = PROFILE_MEDIA_EMPTY_BODY }: { title: string; body?: string }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        minHeight: 154,
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        gap: 8,
      }}
    >
      <ImageIcon size={appTheme.icon.hero} color={theme.colors.faint} />
      <AppText variant="cardTitle">{title}</AppText>
      <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
        {body}
      </AppText>
    </View>
  );
}

function ProfileGridFooterLoader() {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 52, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={theme.colors.primary} />
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
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 4, borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.panel, padding: 4 }}>
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
              backgroundColor: active ? theme.colors.primaryFill : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text numberOfLines={1} style={{ color: active ? theme.colors.onPrimary : theme.colors.muted, fontSize: 12, fontWeight: '800' }}>{tab}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProfileMediaScopeControl<Scope extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Scope;
  /** One library's chips, in order: `onChange` is only ever handed that library's scopes. */
  options: readonly ProfileScopeOption<Scope>[];
  onChange: (scope: Scope) => void;
}) {
  const theme = useAppTheme();
  return (
    // Three chips with counts outgrow a narrow row at larger text sizes; the row wraps.
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
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
              borderColor: active ? theme.colors.primary : theme.colors.border,
              backgroundColor: active ? hexWithAlpha(theme.colors.primary, 0.14) : theme.colors.panel,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text numberOfLines={1} style={{ color: active ? theme.colors.primary : theme.colors.muted, fontSize: 12, fontWeight: '800' }}>
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
  mediaWatchdog = false,
}: {
  item: ProfileMediaCard;
  width: number;
  height: number;
  fallbackAvatarUrl?: string | null;
  fallbackAvatarInitials: string;
  highlighted?: boolean;
  mediaWatchdog?: boolean;
}) {
  const theme = useAppTheme();
  const avatarUrl = item.avatarUrl ?? fallbackAvatarUrl ?? null;
  const avatarInitials = item.avatarUrl
    ? getGalleryInitials(item.avatarLabel ?? item.meta)
    : item.avatarLabel
      ? getGalleryInitials(item.avatarLabel)
      : fallbackAvatarInitials;
  const countLabel = item.countLabel ?? '0';
  const isFallbackPreview = item.id.startsWith('preview-');
  const isSavedTile = item.label === 'Saved';
  const nativeZoomTile = isSavedTile && !isFallbackPreview && item.previewKind !== 'text' && isAppleZoomAvailable();
  // The outputs badge carries a count alone; the label says it in words.
  const outputsLabel = formatOutputCount(item.outputCount);
  // A Post tile said only "Post, <title>" -- the badge in its corner reported
  // Public or Private and the label reported neither, so the state was
  // available to sighted users alone. Both tiles now read out the state their
  // badge draws, from the one place that decides it.
  const accessibilityLabel = isSavedTile
    ? `${item.label}, ${item.title}, ${countLabel} likes`
    : `${item.label}, ${item.title}, ${getProfileTileState(item).label}${outputsLabel ? `, ${outputsLabel}` : ''}`;
  // UIKit captures this view at its laid-out size. A simultaneous press scale
  // exposes the light grid inside the opening veil and shifts the zoom source.
  const motion = usePressMotion(nativeZoomTile, { scale: appTheme.motion.scale.pressed });
  // Saved tiles open the reel, and the reel grows out of this tile. Creations
  // and Posts open the card feed, which is not a zoom.
  const previewUrl = item.previewUrl ?? item.mediaUrl;
  const zoomSource = useMediaZoomSource({
    itemId: item.sourceId,
    radius: 12,
    // The media's own shape: the cell crops every post to the same one.
    aspectRatio: item.aspectRatio ?? null,
    preview: previewUrl ? { url: previewUrl, cacheKey: item.previewCacheKey ?? item.id, thumbhash: item.previewThumbhash } : null,
    // The post as the reel lists it, so the window carries its rail and caption.
    post: item.post ?? null,
    enabled: isSavedTile && !isFallbackPreview && item.previewKind !== 'text',
  });

  return (
    <MotionView style={[{ width, height }, motion.animatedStyle]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPressIn={() => {
        motion.onPressIn();
        zoomSource.prepare();
      }}
      onPressOut={motion.onPressOut}
      onPress={() => {
        haptic.light();
        // Saved media is for looking at, so it opens the reel. Creations and Posts
        // are for managing, so they open the card feed with their controls inline.
        // The reel's href carries the zoom the tile hands the push on iOS 18
        // (lib/apple-zoom.ts); the card feed and the reading screen take none.
        const hrefFor = (zoom: AppleZoomOpen | null) => (isFallbackPreview
          ? item.href
          : item.previewKind === 'text' && item.label !== 'Creation'
            ? textPostViewerHref({
              postId: item.sourceId,
              source: item.viewerSource === 'profile-posts'
                ? 'profile-posts'
                : item.viewerSource === 'profile-saved'
                  ? 'profile-saved'
                  : undefined,
            })
            : isSavedTile
              ? immersiveViewerHref({ source: item.viewerSource, initialId: item.sourceId, zoom })
              : profileMediaFeedHref({
                source: item.viewerSource,
                initialId: item.sourceId,
                // The feed holds the scope the tile was drawn in; active is its default.
                scope: item.isArchived ? 'archived' : undefined,
              }));
        // Every way a tile opens goes through `capture`, zoomed or not, so a tap
        // repeated while the first is still opening opens nothing a second time.
        zoomSource.capture((zoom) => router.push(hrefFor(zoom) as never));
      }}
      style={{ flex: 1 }}
    >
      <MediaZoomSourceView source={zoomSource} style={{ width, height }}>
      <View
        testID={highlighted ? 'profile-highlighted-post-tile' : undefined}
        style={{
          flex: 1,
          overflow: 'hidden',
          borderRadius: 12,
          borderCurve: 'continuous',
          // A light outline becomes a bright frame when UIKit enlarges it.
          borderWidth: highlighted ? 2 : nativeZoomTile ? 0 : 1,
          borderColor: highlighted ? theme.colors.primary : theme.colors.border,
          backgroundColor: theme.colors.panel,
        }}
      >
        <ProfileGalleryPreview item={item} height={height} watchdog={mediaWatchdog} />
        {/* The shade keeps the corner marks legible over a picture. An audio
            plate has no picture, and under the shade its own words went grey. */}
        {item.previewKind === 'audio' ? null : (
          <LinearGradient
            colors={[hexWithAlpha(mediaColors.mediaGround, 0), hexWithAlpha(mediaColors.mediaGround, 0.16), mediaColors.mediaScrimStrong]}
            locations={[0, 0.48, 1]}
            style={{ position: 'absolute', inset: 0 }}
          />
        )}
        {item.mediaKind === 'video' ? (
          <View style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: mediaColors.mediaScrim }}>
            <Play size={appTheme.icon.sm} color={mediaColors.onMedia} fill={mediaColors.onMedia} />
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
      </MediaZoomSourceView>
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
          backgroundColor: mediaColors.mediaChip,
          borderWidth: 1,
          borderColor: hexWithAlpha(mediaColors.onMedia, 0.16),
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
            backgroundColor: themes.dark.colors.panelSoft,
            borderWidth: 1,
            borderColor: hexWithAlpha(mediaColors.onMedia, 0.24),
          }}
        >
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <Text style={{ color: mediaColors.onMedia, fontSize: 11, fontWeight: '800' }}>{avatarInitials}</Text>
          )}
        </View>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: mediaColors.onMedia, fontSize: 11, fontWeight: '800' }}>
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
        <Heart size={14} color={mediaColors.onMedia} fill={mediaColors.onMedia} />
        <Text numberOfLines={1} style={{ color: mediaColors.onMedia, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
          {countLabel}
        </Text>
      </View>
    </View>
  );
}

/**
 * The state a Creations or Posts tile reports -- shared by the badge the tile
 * draws and the label a screen reader hears, so the two cannot say different
 * things. A creation reports whether it reached a post; a post reports who can
 * see it.
 */
/**
 * The state glyph drawn on a grid tile. It sits on a dark glass chip over the
 * picture, so it takes the dark palette's bright tones in both schemes — the
 * deep light-scheme tones would vanish on that chip.
 */
export function getProfileTileState(item: ProfileMediaCard): {
  label: string;
  color: string;
  glyph: 'globe' | 'lock' | 'sparkles' | 'audio';
} {
  if (item.label === 'Creation') {
    if (item.moderationRemoved) {
      return { label: 'Removed by moderation', color: themes.dark.colors.danger, glyph: 'lock' };
    }
    // A step of a template run that did not succeed can never be posted.
    if (item.templateNote) {
      return { label: item.templateNote, color: themes.dark.colors.amber, glyph: 'sparkles' };
    }
    // Audio cannot be posted, so its tile reports what it is where the others
    // report whether they reached a post.
    if (item.previewKind === 'audio') {
      return { label: item.badge ?? 'Audio', color: themes.dark.colors.motion, glyph: 'audio' };
    }
    const posted = Boolean(item.linkedPostLabel && item.linkedPostLabel !== 'Not posted');
    return posted
      ? { label: item.linkedPostLabel ?? 'Posted', color: themes.dark.colors.success, glyph: 'globe' }
      : { label: 'Not posted', color: themes.dark.colors.motion, glyph: 'sparkles' };
  }
  if (item.visibilityLabel === 'Public') {
    return { label: 'Public', color: themes.dark.colors.success, glyph: 'globe' };
  }
  return {
    label: item.visibilityLabel ?? 'Private',
    color: themes.dark.colors.amber,
    glyph: 'lock',
  };
}

function ProfileMinimalMediaOverlay({ item }: { item: ProfileMediaCard }) {
  // Drawn over the picture: the dark theme in both schemes.
  const theme = themes.dark;
  const accent = item.label === 'Creation' ? theme.colors.motion : theme.colors.image;
  const icon = item.label === 'Creation'
    ? <Sparkles size={appTheme.icon.xs} color={accent} />
    : item.mediaKind === 'video'
      ? <Play size={appTheme.icon.xs} color={accent} fill={accent} />
      : <ImageIcon size={appTheme.icon.xs} color={accent} />;
  const state = getProfileTileState(item);
  const StateGlyph = state.glyph === 'globe'
    ? Globe
    : state.glyph === 'lock'
      ? LockKeyhole
      : state.glyph === 'audio' ? AudioLines : Sparkles;

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
          backgroundColor: mediaColors.mediaChip,
          borderWidth: 1,
          borderColor: item.label === 'Creation' ? hexWithAlpha(themes.dark.colors.motion, 0.35) : hexWithAlpha(themes.dark.colors.image, 0.3),
        }}
      >
        {icon}
      </View>

      {/* Was a bare 10pt dot whose hue was the only thing separating a public
          post from a private one. Color: "Avoid relying solely on color to
          differentiate between objects, indicate interactivity, or communicate
          essential information ... you can use text labels or glyph shapes to
          identify objects or states." A tile is too small for the label, so the
          glyph carries the state and the tile's accessibility label says it in
          words -- the same pairing the card feed already uses for these posts
          through `ProfileStateChip`. */}
      <View
        testID="profile-tile-state-badge"
        style={{
          position: 'absolute',
          bottom: 8,
          left: 8,
          width: 22,
          height: 22,
          borderRadius: 11,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: mediaColors.mediaChip,
          borderWidth: 1,
          borderColor: state.color,
        }}
      >
        <StateGlyph size={appTheme.icon.xs} color={state.color} />
      </View>

      {/* The library sends a run's first file only, so a run that made
          several says how many; the details slide lists them. A count beside
          a glyph, not the card's "3 outputs": the words do not fit beside the
          state badge on a 104pt tile at the 11pt floor. */}
      {item.outputCount ? (
        <View
          testID="profile-tile-outputs-badge"
          style={{
            position: 'absolute',
            bottom: 8,
            right: 8,
            minHeight: 22,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 3,
            borderRadius: 11,
            paddingHorizontal: 6,
            backgroundColor: mediaColors.mediaChip,
            borderWidth: 1,
            borderColor: hexWithAlpha(mediaColors.onMedia, 0.24),
          }}
        >
          <Images size={appTheme.icon.xs} color={mediaColors.onMedia} />
          <Text style={{ color: mediaColors.onMedia, fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
            {item.outputCount}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function ProfileGalleryPreview({
  item,
  height,
  watchdog = false,
}: {
  item: ProfileMediaCard;
  height: number;
  watchdog?: boolean;
}) {
  const theme = useAppTheme();
  // `previewState` is the whole answer to what a tile draws, so the tile does
  // not second-guess it. It used to fall through to "any image card can paint
  // its own media", which reached past a state that had already decided
  // otherwise: a creation whose poster job failed would pull its full-size
  // original into a grid cell, which is the egress the 720px derivative exists
  // to avoid. Where there is no poster there is a plate.
  const previewMediaUrl = item.previewState === 'videoPoster'
    ? item.previewUrl
    : item.previewState === 'image'
      ? item.previewUrl ?? item.mediaUrl
      : null;
  if (previewMediaUrl) {
    return (
      <View style={{ width: '100%', height, overflow: 'hidden', backgroundColor: theme.colors.surfaceInset }}>
        <StableMediaImage
          url={previewMediaUrl}
          cacheKey={item.previewCacheKey ?? item.id}
          thumbhash={item.previewThumbhash}
          contentFit="cover"
          transition={120}
          watchdog={watchdog}
          diagnosticsSurface="profile-grid"
          style={{ position: 'absolute', inset: 0 }}
        />
        {item.label === 'Saved' && item.post?.mediaItems[0]?.mediaKind === 'video' && isAppleZoomAvailable() ? (
          <ReturnedVideoPreview key={item.sourceId} url={getShowcasePlaybackUrl(item.post.mediaItems[0])} />
        ) : null}
      </View>
    );
  }

  if (item.mediaKind === 'video' && item.mediaUrl) {
    return <ProfileVideoFallback item={item} height={height} />;
  }

  if (item.previewKind === 'text') {
    return <ProfileTextPreview item={item} height={height} />;
  }

  if (item.previewKind === 'audio') {
    return <ProfileAudioPreview item={item} height={height} />;
  }

  return (
    <ProfileUnavailableFallback item={item} height={height} showTitle={item.label !== 'Post'} />
  );
}

/**
 * An audio creation's tile: what it is, and the script or prompt it was made
 * from. The plate a text creation draws, since both are a creation with no
 * picture. It does not play here; the tile opens the card that does.
 */
function ProfileAudioPreview({ item, height }: { item: ProfileMediaCard; height: number }) {
  const theme = useAppTheme();
  const accent = theme.colors.motion;

  return (
    <View testID="profile-audio-preview" style={{ height, overflow: 'hidden', backgroundColor: theme.colors.surfaceInset }}>
      {/* Laid out from the top, clear of the mark in each corner, so the label
          sits at one height on every tile however long the title runs. */}
      <View style={{ flex: 1, paddingHorizontal: 12, paddingTop: 46, paddingBottom: 38 }}>
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
          <Text numberOfLines={1} style={{ color: accent, fontSize: 11, fontWeight: '800' }}>{item.badge ?? 'Audio'}</Text>
        </View>
        <Text numberOfLines={3} style={{ color: theme.colors.text, fontSize: 13, lineHeight: 16, fontWeight: '800' }}>
          {item.title}
        </Text>
      </View>
    </View>
  );
}

function ProfileTextPreview({ item, height }: { item: ProfileMediaCard; height: number }) {
  const theme = useAppTheme();
  const accent = item.label === 'Creation' ? theme.colors.motion : theme.colors.info;
  const label = item.label === 'Creation' ? 'Text creation' : 'Text post';

  return (
    <View testID="profile-text-preview" style={{ height, overflow: 'hidden', backgroundColor: theme.colors.surfaceInset }}>
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
          <Text numberOfLines={1} style={{ color: accent, fontSize: 11, fontWeight: '800' }}>{label}</Text>
        </View>
        <Text numberOfLines={5} style={{ color: theme.colors.text, fontSize: 13, lineHeight: 16, fontWeight: '800' }}>
          {item.previewText || item.title}
        </Text>
      </View>
    </View>
  );
}

function ProfileVideoFallback({ item, height }: { item: ProfileMediaCard; height: number }) {
  const theme = useAppTheme();
  const label = item.badge ?? 'Video';
  const statusLabel = item.previewStatusLabel ?? (item.label === 'Creation' ? 'Tap to view media' : 'Preview unavailable');

  return (
    <View testID="profile-video-preview-fallback" style={{ height, overflow: 'hidden', backgroundColor: theme.colors.surfaceInset }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: `${theme.colors.video}1f`,
            borderWidth: 1,
            borderColor: `${theme.colors.video}66`,
          }}
        >
          <Play size={18} color={theme.colors.video} fill={theme.colors.video} />
        </View>
        <Text style={{ marginTop: 10, color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>{label}</Text>
        <Text
          numberOfLines={1}
          style={{ marginTop: 3, color: theme.colors.muted, fontSize: 11, fontWeight: '800' }}
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
  const theme = useAppTheme();
  const accent = item.label === 'Creation' ? theme.colors.motion : theme.colors.image;

  return (
    <View testID="profile-art-preview-fallback" style={{ height, overflow: 'hidden', backgroundColor: theme.colors.surfaceInset }}>
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
            ? <Sparkles size={14} color={accent} />
            : <ImageIcon size={14} color={accent} />}
        </View>
        {showTitle ? (
          <Text numberOfLines={2} style={{ marginTop: 10, color: theme.colors.text, fontSize: 11, lineHeight: 14, fontWeight: '800' }}>
            {item.title}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          style={{ marginTop: showTitle ? 4 : 10, color: theme.colors.muted, fontSize: 11, fontWeight: '800' }}
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
