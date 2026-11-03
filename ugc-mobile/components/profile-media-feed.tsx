import { FlashList, type FlashListRef, type ViewToken } from '@shopify/flash-list';
import { useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { RefreshCw } from 'lucide-react-native';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  Share,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CommentsSheet } from '@/components/comments-sheet';
import { FeedLoadMoreErrorFooter } from '@/components/feed-pagination-footer';
import { MediaZoomSurface } from '@/components/media-zoom';
import { ZoomVeilScope } from '@/components/zoom-veil';
import { ProfileFeedCardView } from '@/components/profile-feed-card';
import { IconButton, SecondaryButton, StatusBlock } from '@/components/ui';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { ViewerActionsMenuProvider } from '@/components/viewer-actions-menu';
import { changeGenerationArchive, type ViewerActionCallbacks } from '@/lib/use-viewer-action-handlers';
import { audioCreationPlayback } from '@/lib/audio-creation-native-player';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
import { feedReadMoreSection } from '@/lib/feed-read-more';
import {
  normalizeParam,
  normalizeViewerSource,
  readCachedProfile,
} from '@/lib/immersive-preview-source-data';
import {
  immersivePreviewOpenHref,
  type ImmersivePreviewItem,
} from '@/lib/immersive-preview-view-model';
import {
  buildProfileFeedCards,
  feedLandingCardPlace,
  feedLandingScrollArrived,
  initialFeedLanding,
  reduceFeedLanding,
  shouldScrollToFeedTarget,
  type FeedLandingCardPlace,
  type ProfileFeedCard,
} from '@/lib/profile-feed-card-view-model';
import { refreshProfileLibraryHead } from '@/lib/profile-library-head';
import { PROFILE_MEDIA_LOAD_MORE_COOLDOWN_MS } from '@/lib/profile-media-query';
import { getProfileHandle } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { useReducedMotion } from '@/lib/motion';
import { BackGlyph } from '@/lib/platform-glyphs';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import {
  getNativeRemixCreateHref,
  getRemixSourceContext,
  getViewerShareIntent,
  getViewerShareSourceSurface,
  isViewerOwnGeneration,
} from '@/lib/viewer-actions';
import {
  changePostVisibility,
  pickPostVisibility,
  resolveLinkedLifecyclePost,
  toPostLifecyclePost,
  type PostLifecyclePost,
} from '@/lib/post-lifecycle';
import type { PostLifecycleVisibility } from '@/lib/post-lifecycle-policy';
import { useProfileLibrarySource } from '@/lib/use-profile-library-source';
import { useProfileMediaRevalidation } from '@/lib/use-profile-media-revalidation';
import { applyPostVisibilityToCaches } from '@/lib/viewer-media-cache';
import type { AppleZoomOpen } from '@/lib/apple-zoom';

type ProfileMediaFeedParams = {
  source?: string | string[];
  initialId?: string | string[];
  scope?: string | string[];
  /** Set by sign-in from a card's comments: the thread to open again, and the reply it was for. */
  comments?: string | string[];
  replyTo?: string | string[];
};

/**
 * This feed as it was opened — library, card and scope — for sign-in to come
 * back to (audit 01-12). Sign-in pops back to the feed underneath with these
 * same params, so it stands as the reader left it; before, every card action
 * that asked for an account ended on Home.
 */
function profileMediaFeedReturnPath(source: string, initialId: string, scope: 'active' | 'archived') {
  const params = [
    ['source', source],
    ...(initialId ? [['initialId', initialId]] : []),
    ...(scope === 'archived' ? [['scope', 'archived']] : []),
  ];
  return `/profile-media-feed?${params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')}`;
}

/** How often a landing checks its budget and retries after layout has advanced. */
const LANDING_TICK_MS = 250;

/** The list's padding above its first card, which the opened card is drawn under too when it is that card. */
const LIST_PADDING_TOP = 12;

/**
 * How long the opened card takes to give way to the list once the list has
 * landed on it (`OpeningCard`).
 */
const OPENING_CARD_HANDOVER_MS = 120;

/**
 * Creations and Posts open here rather than in the reel: owned media is managed,
 * not consumed, so it reads as a card feed in the same visual language as Home,
 * with the ownership controls inline. Opening a text post uses its dedicated
 * reading screen; image and video cards still open the reel.
 *
 * The feed reads the grid's own library — the same pages, order, freshness and
 * membership rule — and continues past the loaded pages through the grid's
 * cursor, so the card a tile opens is always that tile's (2026-09-16 Creations
 * reliability audit, C1, C3, C8).
 */
export function ProfileMediaFeedScreen() {
  const theme = useAppTheme();
  const params = useLocalSearchParams<ProfileMediaFeedParams>();
  const source = normalizeViewerSource(params.source);
  const initialId = normalizeParam(params.initialId);
  const postsScope = normalizeParam(params.scope) === 'archived' ? 'archived' : 'active';
  const authReturnTo = profileMediaFeedReturnPath(source, initialId, postsScope);
  const requestedCommentsPostId = normalizeParam(params.comments).trim() || null;
  const requestedReplyToId = normalizeParam(params.replyTo).trim() || null;
  const libraryName = source === 'profile-creations' ? 'Creations' : 'Posts';
  const noun = source === 'profile-creations' ? 'creation' : 'post';
  const { api, user, isGuest, identityUserId } = useAuth();
  // Whose library this feed revalidates and changes: a guest's Creations are
  // its own, keyed by its identity as the Profile grid keys them (02-1). A
  // guest has no posts.
  const libraryOwnerId = user?.id ?? (isGuest && libraryName === 'Creations' ? identityUserId ?? undefined : undefined);
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const listRef = useRef<FlashListRef<ProfileFeedCard>>(null);
  const [actionsOpenItemId, setActionsOpenItemId] = useState<string | null>(null);
  // The reader deleted the card the feed was opened on. The cards around it
  // stay; the lookup that would call the opened item missing is not asked.
  const [openedItemDeleted, setOpenedItemDeleted] = useState(false);
  const [commentsOpenItemId, setCommentsOpenItemId] = useState<string | null>(null);
  const [commentsReplyToId, setCommentsReplyToId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  // An audio creation scrolled right off the screen has no control left to stop
  // it with. Left alone it played on until the list reused its row, at no point
  // a person could predict, and lost its place when it did; so its sound stops
  // as its card leaves, and its place is kept for the way back. Any part of the
  // card on screen counts as there: the player may be the part still showing.
  // Held in state because FlashList reads the pairs once, when the list is made.
  const [audioViewabilityPairs] = useState(() => [{
    viewabilityConfig: { itemVisiblePercentThreshold: 0, minimumViewTime: 0 },
    onViewableItemsChanged: ({ changed }: { changed: Array<ViewToken<ProfileFeedCard>> }) => {
      for (const token of changed) {
        if (!token.isViewable && token.item?.audio) audioCreationPlayback.pause(token.item.id);
      }
    },
  }]);

  const contentWidth = Math.min(width, 430);
  const horizontalPadding = contentWidth < 390 ? 12 : 14;
  const cardWidth = contentWidth - horizontalPadding * 2;

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    initialData: () => readCachedProfile(queryClient, user?.id),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });

  const ownerInfo = useMemo(() => ({
    creatorLabel: user ? getProfileHandle(profileQuery.data, user.email) : '@creator',
    creatorAvatar: profileQuery.data?.avatarUrl ?? null,
    creatorId: user?.id ?? null,
  }), [profileQuery.data, user]);

  const library = useProfileLibrarySource({
    api,
    userId: user?.id,
    source,
    initialId,
    postsScope,
    owner: ownerInfo,
  });
  const {
    fetchNextPage,
    hasNextPage,
    isFetching: libraryIsFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    items,
    pageCount,
  } = library;
  const selection = openedItemDeleted ? 'found' : library.selection;
  const cards = useMemo(() => buildProfileFeedCards(items), [items]);
  const activeItem = useMemo(
    () => items.find((item) => item.id === actionsOpenItemId) ?? null,
    [items, actionsOpenItemId]
  );
  const commentsItem = useMemo(
    () => items.find((item) => item.id === commentsOpenItemId) ?? null,
    [items, commentsOpenItemId]
  );

  // Back from signing in to comment: the route names the thread, so it opens
  // again on the reply it was for, as Home and the reel do.
  useEffect(() => {
    if (!requestedCommentsPostId) return;
    const target = items.find((item) => item.canComment && item.showcasePostId === requestedCommentsPostId);
    if (!target) return;
    setCommentsReplyToId(requestedReplyToId);
    setCommentsOpenItemId(target.id);
    router.setParams({ comments: undefined, replyTo: undefined } as never);
  }, [items, requestedCommentsPostId, requestedReplyToId]);

  // Coming back to the feed revalidates the library it shares with the grid.
  const refreshLibraryHead = useCallback(
    () => refreshProfileLibraryHead({ api, queryClient, userId: libraryOwnerId, library: libraryName }),
    [api, libraryName, libraryOwnerId, queryClient]
  );
  useProfileMediaRevalidation({
    enabled: isFocused && Boolean(libraryOwnerId),
    scope: libraryName,
    hasData: library.hasData,
    isFetching: libraryIsFetching,
    isStale: library.isStale,
    refresh: refreshLibraryHead,
  });

  /**
   * Bring the tapped card on screen and keep it there until the reader moves.
   * The list's own reports drive each attempt — the card arriving, the list
   * loading or changing size, the card turning viewable — and the reducer bounds
   * them, saying so when it could not get there instead of leaving the reader on
   * another card. Scrolling rather than reordering keeps the cards above it
   * reachable.
   */
  const targetIndex = initialId ? cards.findIndex((card) => card.id === initialId) : -1;
  const [landing, dispatchLanding] = useReducer(reduceFeedLanding, targetIndex, initialFeedLanding);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [listReady, setListReady] = useState(false);
  const landingSeekingRef = useRef(false);
  const landingScrollInFlightRef = useRef(false);
  /** The index the landing scroll in flight is taking the list to. */
  const landingScrollIndexRef = useRef<number | null>(null);
  const landingTargetVisibleRef = useRef(false);

  // The opened card stands over the hidden list while the list seeks it
  // (`OpeningCard`), so the screen comes in with it rather than empty. A card
  // that arrives after the screen does (fetched on its own, or a cold open) is
  // first held in a waiting landing for one render, which the `target` effect
  // then starts; the card stands from that render too, or the top of the list
  // would show for a frame. It goes at once when the reader takes the list over
  // or the landing gives up, and after its fade once the list has landed.
  const openingCard = targetIndex >= 0 ? cards[targetIndex] : null;
  const openingCardDue = landing.phase === 'seeking' || (landing.phase === 'waiting' && openingCard !== null);
  const [openingCardShown, setOpeningCardShown] = useState(openingCardDue);
  if (openingCardDue && !openingCardShown) setOpeningCardShown(true);
  if (openingCardShown && !openingCardDue && landing.phase !== 'landed') setOpeningCardShown(false);
  const handOverOpeningCard = useCallback(() => setOpeningCardShown(false), []);
  // Where the card stands is read from the cards when it is first drawn, and
  // kept while it stands for that index. Opened on the last card loaded, a page
  // landing under it moved it from the list's foot to its top while the list
  // was still landing it on its foot (review of #679, finding 10). A reorder
  // that starts a landing on another index stands it afresh.
  const openingCardStands = openingCardShown && openingCard !== null;
  const [openingCardStand, setOpeningCardStand] = useState(() => (
    openingCardStands ? { index: targetIndex, place: feedLandingCardPlace(targetIndex, cards.length) } : null
  ));
  if (!openingCardStands && openingCardStand) setOpeningCardStand(null);
  if (openingCardStands && openingCardStand?.index !== targetIndex) {
    setOpeningCardStand({ index: targetIndex, place: feedLandingCardPlace(targetIndex, cards.length) });
  }
  // Where the landed list stands the card, from the list's top: the card's
  // place among the cards less how far the list has scrolled. FlashList records
  // a native scroll before it passes the event on, so this is current from the
  // early reveal's scroll as much as from the promise.
  const openedCardLandedTop = useCallback(() => {
    const list = listRef.current;
    const layout = list?.getLayout(landing.targetIndex);
    return list && layout ? layout.y + list.getFirstItemOffset() - list.getAbsoluteLastScrollOffset() : null;
  }, [landing.targetIndex]);

  useEffect(() => {
    landingSeekingRef.current = landing.phase === 'seeking';
  }, [landing.phase]);

  useEffect(() => {
    landingTargetVisibleRef.current = false;
    if (initialId) dispatchLanding({ type: 'target', index: targetIndex, now: Date.now() });
  }, [initialId, targetIndex]);

  useEffect(() => {
    if (listReady && targetIndex === 0) {
      dispatchLanding({ type: 'viewable', targetVisible: true });
    }
  }, [listReady, targetIndex]);

  useEffect(() => {
    if (!listReady || !shouldScrollToFeedTarget(landing, cards.length)) return;
    const list = listRef.current;
    if (!list || landingScrollInFlightRef.current) return;
    const index = landing.targetIndex;
    landingScrollInFlightRef.current = true;
    landingScrollIndexRef.current = index;
    void list.scrollToIndex({ index, animated: false, viewPosition: 0 })
      .then(() => {
        const visible = list.computeVisibleIndices();
        dispatchLanding({
          type: 'scroll-complete',
          index,
          targetVisible: landingTargetVisibleRef.current
            || (index >= visible.startIndex && index <= visible.endIndex),
        });
      })
      .finally(() => {
        landingScrollInFlightRef.current = false;
        landingScrollIndexRef.current = null;
      });
  }, [cards.length, landing, layoutRevision, listReady]);

  // The landing scroll's one native move: the feed shows from it rather than
  // from the promise, which resolves 200 ms later (`feedLandingScrollArrived`).
  // iOS only until it has been watched on Android, where cards overlapped as a
  // jump settled (docs/audits/creations-feed-landing-fix-2026-09-16.md); the
  // promise is what was checked there.
  const noteLandingScroll = useCallback((nativeOffset: number) => {
    const index = landingScrollIndexRef.current;
    const list = listRef.current;
    if (index === null || !list || !landingSeekingRef.current) return;
    const layout = list.getLayout(index);
    if (!layout || !feedLandingScrollArrived(nativeOffset, layout.y + list.getFirstItemOffset())) return;
    const visible = list.computeVisibleIndices();
    dispatchLanding({
      type: 'scroll-complete',
      index,
      targetVisible: index >= visible.startIndex && index <= visible.endIndex,
    });
  }, []);

  useEffect(() => {
    if (landing.phase !== 'seeking') return;
    const timer = setInterval(() => dispatchLanding({ type: 'tick', now: Date.now() }), LANDING_TICK_MS);
    return () => clearInterval(timer);
  }, [landing.phase]);

  useEffect(() => {
    if (landing.phase === 'failed') {
      AccessibilityInfo.announceForAccessibility(`Couldn't scroll to the ${noun} you opened.`);
    }
  }, [landing.phase, noun]);

  // A load or size report is another chance to land, while a landing is under way.
  const acknowledgeListLayout = useCallback(() => {
    if (landingSeekingRef.current) setLayoutRevision((revision) => revision + 1);
  }, []);

  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMorePageCountRef = useRef<number | null>(null);
  const requestNextPage = useCallback(() => {
    const now = Date.now();
    if (!canRequestNextFeedPage({
      cooldownMs: PROFILE_MEDIA_LOAD_MORE_COOLDOWN_MS,
      hasNextPage,
      isBusy: libraryIsFetching,
      isRequestInFlight: loadingMoreRef.current,
      lastRequestedAt: lastLoadMoreAtRef.current,
      lastRequestedPageCount: lastLoadMorePageCountRef.current,
      now,
      pageCount,
    })) return;

    loadingMoreRef.current = true;
    lastLoadMoreAtRef.current = now;
    lastLoadMorePageCountRef.current = pageCount;
    void fetchNextPage().finally(() => {
      loadingMoreRef.current = false;
    });
  }, [fetchNextPage, hasNextPage, libraryIsFetching, pageCount]);

  const retryNextPage = useCallback(() => {
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    requestNextPage();
  }, [requestNextPage]);

  // The landing's own scroll to a card near the end of the list reaches its
  // end, and the page asked for then landed while the list was still seeking
  // the card (review of #679, finding 10). The end is noted instead, and the
  // page asked for once the landing is over and the library is not mid-read:
  // FlashList reports an end once per arrival, so one dropped here would wait
  // until the reader had left the end and come back.
  const endReachedWhileSeekingRef = useRef(false);
  const holdEndReached = useCallback(() => {
    endReachedWhileSeekingRef.current = true;
  }, []);
  useEffect(() => {
    if (landing.phase === 'seeking' || libraryIsFetching || !endReachedWhileSeekingRef.current) return;
    endReachedWhileSeekingRef.current = false;
    requestNextPage();
  }, [landing.phase, libraryIsFetching, requestNextPage]);

  const openItem = useCallback((
    item: ImmersivePreviewItem,
    options: { comments?: boolean; initialPage?: 'details'; initialSection?: 'story' | 'prompt'; zoom?: AppleZoomOpen | null } = {}
  ) => {
    router.push(immersivePreviewOpenHref(item, options) as never);
  }, []);

  const shareItem = useCallback(async (item: ImmersivePreviewItem) => {
    const intent = getViewerShareIntent(item, env.siteUrl);
    if (intent.kind === 'unavailable') return;

    if (intent.kind === 'publish') {
      router.push({ pathname: '/post/new', params: { generationId: intent.generationId, shareAfterPublish: '1' } } as never);
      return;
    }
    if (intent.kind === 'make-public') {
      router.push({ pathname: '/post/new', params: { postId: intent.postId, shareAfterPublish: '1' } } as never);
      return;
    }

    // A dismissed share sheet is not an error worth surfacing.
    const result = await Share.share({ ...intent.content }).catch(() => null);
    // Android's share intent cannot report a dismissal (it answers "shared" either way), so only iOS counts a share.
    if (Platform.OS !== 'ios' || result?.action !== Share.sharedAction || !item.showcasePostId) return;
    await api
      .shareShowcasePost(item.showcasePostId, { sourceSurface: getViewerShareSourceSurface(item.source) })
      .catch(() => null);
  }, [api]);

  const recreateItem = useCallback((item: ImmersivePreviewItem) => {
    // A guest can generate, so its own creation opens in the creator, as the
    // reel opens it; anything else asks a guest to sign in first.
    if (!user && !(isGuest && isViewerOwnGeneration(item, identityUserId))) {
      router.push({ pathname: '/auth', params: { returnTo: authReturnTo } } as never);
      return;
    }
    const href = getNativeRemixCreateHref({
      generationId: item.generationId,
      recreateTool: item.recreateTool,
      prompt: item.recreatePrompt,
      context: getRemixSourceContext(item),
    });
    router.push((href ?? `/create/${item.recreateTool}`) as never);
  }, [authReturnTo, identityUserId, isGuest, user]);

  const applyPostVisibility = useCallback(async (
    post: PostLifecyclePost,
    visibility: PostLifecycleVisibility,
    action: string
  ) => {
    setPendingAction(action);
    try {
      const outcome = await changePostVisibility({ api, post, visibility });
      if (outcome === 'done') {
        // Patched into the loaded pages rather than collapsing them, so the
        // reader stays on the card they just changed.
        await applyPostVisibilityToCaches(queryClient, user?.id, post.id, visibility);
      }
    } finally {
      setPendingAction(null);
    }
  }, [api, queryClient, user?.id]);

  /**
   * Card actions dispatch the same action ids the More sheet uses, so a control
   * on the card and the same control in the sheet run one code path.
   */
  const runCardAction = useCallback((action: string, item: ImmersivePreviewItem) => {
    // A guest's own creation is its to restore (the server takes a guest's
    // restore, as the ••• already sends it) and to recreate; every other card
    // action is an account's.
    const guestOwnCreationAction = isGuest
      && (action === 'restore' || action === 'recreate')
      && isViewerOwnGeneration(item, identityUserId);
    if (!user && !guestOwnCreationAction) {
      router.push({ pathname: '/auth', params: { returnTo: authReturnTo } } as never);
      return;
    }

    switch (action) {
      case 'publish':
        router.push({ pathname: '/post/new', params: { generationId: item.id } } as never);
        return;
      case 'edit-linked-resources':
        if (item.linkedPostId) {
          router.push({
            pathname: '/post/new',
            params: { postId: item.linkedPostId, focus: 'resources' },
          } as never);
        }
        return;
      case 'comment':
        if (item.previewKind === 'text' && item.sourceType !== 'generation') {
          openItem(item, { comments: true });
          return;
        }
        setCommentsOpenItemId(item.id);
        return;
      case 'share':
        void shareItem(item);
        return;
      case 'view-details':
        openItem(item);
        return;
      case 'recreate':
      case 'unlock-remix':
        recreateItem(item);
        return;
      case 'restore':
        // An archived creation's card offers its way back where Share was.
        if (item.sourceType === 'generation') {
          void changeGenerationArchive({ api, queryClient, userId: libraryOwnerId, item, archive: false });
        }
        return;
      case 'save':
      case 'unsave':
        return;
      case 'change-visibility': {
        const post = toPostLifecyclePost({
          id: item.id,
          visibility: item.visibility,
          archivedAt: item.archivedAt,
          bundle: item.ownerPostBundle ?? null,
        });
        pickPostVisibility(post.visibility, (next) => void applyPostVisibility(post, next, action));
        return;
      }
      case 'change-linked-visibility': {
        if (!item.linkedPostId) return;
        // Whether the change needs a confirmation depends on the linked post's
        // bundle; read the post first when its details never loaded.
        void resolveLinkedLifecyclePost({ api, item }).then((post) => {
          if (post) pickPostVisibility(post.visibility, (next) => void applyPostVisibility(post, next, action));
        });
        return;
      }
      default:
        return;
    }
  }, [api, applyPostVisibility, authReturnTo, identityUserId, isGuest, libraryOwnerId, openItem, queryClient, recreateItem, shareItem, user]);

  if (library.isLoading || selection === 'loading') {
    return (
      <FeedShell title={libraryName} topInset={topInset} bottomInset={bottomInset}>
        <ActivityIndicator accessibilityLabel="Loading media" color={theme.colors.primary} />
      </FeedShell>
    );
  }

  if (library.isError) {
    return (
      <FeedShell title={libraryName} topInset={topInset} bottomInset={bottomInset}>
        <View style={{ width: '100%', maxWidth: 420, gap: 12 }}>
          <StatusBlock tone="danger" title="Couldn't load this media" body="Check your connection and try again." />
          <SecondaryButton label="Try again" onPress={() => void library.refetch()} />
        </View>
      </FeedShell>
    );
  }

  if (selection === 'error') {
    return (
      <FeedShell title={libraryName} topInset={topInset} bottomInset={bottomInset}>
        <View style={{ width: '100%', maxWidth: 420, gap: 12 }}>
          <StatusBlock tone="danger" title={`Couldn't load this ${noun}`} body="Check your connection and try again." />
          <SecondaryButton label="Try again" onPress={() => void library.retrySelection()} />
        </View>
      </FeedShell>
    );
  }

  // The item the reader opened is not theirs to open any more. Say that; never
  // show them a different card in its place.
  if (selection === 'missing') {
    return (
      <FeedShell title={libraryName} topInset={topInset} bottomInset={bottomInset}>
        <View style={{ width: '100%', maxWidth: 420, gap: 12 }}>
          <StatusBlock
            title={`This ${noun} isn't available`}
            body="It may have been deleted or archived, or it's no longer on this account."
          />
          <SecondaryButton label="Go back" onPress={leaveFeed} />
        </View>
      </FeedShell>
    );
  }

  if (!cards.length) {
    return (
      <FeedShell title={libraryName} topInset={topInset} bottomInset={bottomInset}>
        <Text style={{ color: theme.colors.text, ...appTheme.type.sectionTitle, fontWeight: '800' }}>Nothing here yet</Text>
        <Text style={{ color: theme.colors.muted, marginTop: 8 }}>This item may have been removed.</Text>
      </FeedShell>
    );
  }

  const showEnrichmentNotice = library.enrichmentFailed && items.some((item) => Boolean(item.linkedPostId));

  // The screen's side of a card's actions: each card's ⋮ asks for it for its
  // own item (`components/viewer-actions-menu.tsx`), and the sheet below — the
  // fallback where native menus are missing — takes it for the open item.
  const actionCallbacksFor = (item: ImmersivePreviewItem): ViewerActionCallbacks => ({
    onComments: item.canComment ? () => {
      setActionsOpenItemId(null);
      if (item.previewKind === 'text' && item.sourceType !== 'generation') {
        openItem(item, { comments: true });
        return;
      }
      setCommentsOpenItemId(item.id);
    } : undefined,
    onDetails: () => {
      setActionsOpenItemId(null);
      openItem(item);
    },
    onRecreate: () => recreateItem(item),
    onShare: () => void shareItem(item),
    onDeleted: () => {
      setActionsOpenItemId(null);
      if (item.sourceType !== 'generation') return;
      if (item.id === initialId) setOpenedItemDeleted(true);
      // The last card gone leaves nothing to manage here.
      if (cards.every((card) => card.id === item.id)) leaveFeed();
    },
    onSourceRefresh: () => void library.refetch(),
    authReturnTo,
  });

  return (
    <ViewerActionsMenuProvider callbacksFor={actionCallbacksFor}>
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <FeedTopBar title={libraryName} topInset={topInset} />
      {landing.phase === 'failed' ? (
        <FeedNotice
          label={`Couldn't scroll to the ${noun} you opened. Tap to try again.`}
          onPress={() => dispatchLanding({ type: 'retry', now: Date.now() })}
        />
      ) : null}
      {showEnrichmentNotice ? (
        <FeedNotice
          label="Couldn't load linked post details. Tap to retry."
          onPress={() => void library.retryEnrichment()}
        />
      ) : null}
      {/* FlashList rather than FlatList: cards are variable height (media aspect ratio
          and body length both differ), so FlatList could not implement getItemLayout and
          could not jump to the tapped card. */}
      {/* Black over this screen while a reel grows out of a card or shrinks back (lib/zoom-veil.ts). */}
      <ZoomVeilScope>
      <MediaZoomSurface>
      <View style={{ flex: 1, width: contentWidth, alignSelf: 'center' }}>
      <FlashList
        keyboardShouldPersistTaps="never"
        ref={listRef}
        testID="profile-media-feed-list"
        data={cards}
        keyExtractor={(card) => card.id}
        accessibilityElementsHidden={landing.phase === 'seeking'}
        importantForAccessibility={landing.phase === 'seeking' ? 'no-hide-descendants' : 'auto'}
        pointerEvents={landing.phase === 'seeking' ? 'none' : 'auto'}
        getItemType={(card) => card.isTextOnly
          ? 'text'
          : card.audio
            ? 'audio'
            : card.sourceUnavailable
              ? 'unavailable'
              : card.item.mediaKind ?? 'image'}
        extraData={{ activeVideoId, isFocused, pendingAction }}
        maintainVisibleContentPosition={{ disabled: true }}
        onLoad={() => {
          setListReady(true);
          acknowledgeListLayout();
        }}
        onContentSizeChange={acknowledgeListLayout}
        onScroll={Platform.OS === 'ios' ? (event) => noteLandingScroll(event.nativeEvent.contentOffset.y) : undefined}
        onScrollBeginDrag={() => {
          // The reader's own scroll outranks the landing: never yank them back.
          dispatchLanding({ type: 'reader-scrolled' });
        }}
        onViewableItemsChanged={({ viewableItems }: { viewableItems: Array<ViewToken<ProfileFeedCard>> }) => {
          const firstVideo = viewableItems.find((token) => token.item?.item.mediaKind === 'video');
          setActiveVideoId(firstVideo?.item?.id ?? null);

          if (initialId) {
            const targetVisible = viewableItems.some((token) => token.item?.id === initialId);
            landingTargetVisibleRef.current = targetVisible;
            dispatchLanding({
              type: 'viewable',
              targetVisible,
            });
          }
        }}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        viewabilityConfigCallbackPairs={audioViewabilityPairs}
        onEndReached={landing.phase === 'seeking' ? holdEndReached : requestNextPage}
        onEndReachedThreshold={0.6}
        ListFooterComponent={isFetchingNextPage
          ? <FeedFooterLoader />
          : isFetchNextPageError
            ? <FeedLoadMoreErrorFooter onRetry={retryNextPage} />
            : null}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingBottom: bottomInset + 28,
          paddingTop: LIST_PADDING_TOP,
        }}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, opacity: landing.phase === 'seeking' ? 0 : 1 }}
        renderItem={({ item: card }) => (
          <ProfileFeedCardView
            card={card}
            contentWidth={cardWidth}
            showActiveVideo={isFocused && activeVideoId === card.id}
            screenFocused={isFocused}
            mediaWatchdog={isFocused}
            pendingAction={pendingAction}
            onOpen={(zoom) => openItem(card.item, { zoom })}
            onReadMore={() => openItem(card.item, {
              initialPage: 'details',
              initialSection: feedReadMoreSection(card.bodyText, card.item.details ?? {}),
            })}
            onActionsOpen={() => setActionsOpenItemId(card.id)}
            onAction={(action) => runCardAction(action, card.item)}
          />
        )}
      />
      {openingCardShown && openingCard && openingCardStand ? (
        <OpeningCard
          card={openingCard}
          place={openingCardStand.place}
          cardWidth={cardWidth}
          horizontalPadding={horizontalPadding}
          pendingAction={pendingAction}
          leaving={landing.phase === 'landed'}
          landedTop={openedCardLandedTop}
          onLeft={handOverOpeningCard}
        />
      ) : null}
      </View>
      </MediaZoomSurface>
      </ZoomVeilScope>
      {activeItem ? (
        <ViewerActionSheet
          item={activeItem}
          onClose={() => setActionsOpenItemId(null)}
          {...actionCallbacksFor(activeItem)}
          visible={actionsOpenItemId === activeItem.id}
        />
      ) : null}
      {commentsItem?.canComment && commentsItem.showcasePostId ? (
        <CommentsSheet
          key={commentsItem.showcasePostId}
          authReturnTo={authReturnTo}
          postId={commentsItem.showcasePostId}
          postCreatorId={commentsItem.creatorId ?? null}
          commentCount={commentsItem.commentCount}
          initialReplyToId={commentsReplyToId}
          onClose={() => {
            setCommentsReplyToId(null);
            setCommentsOpenItemId(null);
          }}
          visible={commentsOpenItemId === commentsItem.id}
        />
      ) : null}
    </View>
    </ViewerActionsMenuProvider>
  );
}

function leaveFeed() {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/(tabs)/profile' as never);
}

/**
 * The card the feed was opened on, drawn where the list will show it once
 * landed (`feedLandingCardPlace`), with the list's own padding and width, while
 * the list underneath is hidden seeking it. Without it the page slid in with
 * only its top bar and the card cut in after: on the iPhone simulator the slide
 * ended at +415 ms and the card appeared at +370 to 910 ms, later for a deeper
 * tile, and the Android emulator showed about 0.17 s of blank (2026-11-03). It
 * also stands in for the spinner a slow landing put over the empty list: over a
 * card already drawn, a spinner only flashes.
 *
 * It is the list's own card component, so it measures as the list's card does
 * whatever the media's shape and the length of the text, and its video shows
 * its poster, the clip's first frame. It takes no touches and nothing of it
 * reaches a screen reader: the list is hidden from both while it seeks, and the
 * list's card is the one that answers once landed. It has a `MediaZoomSurface`
 * of its own because the register of zoom tiles keys on surface and post: in
 * the list's, its tile would replace the list card's and take it away on
 * unmount, leaving a reel opened later nothing to close into. In its own it
 * still takes its media's shape from its zoom source under UIKit's zoom, as the
 * list's card does.
 *
 * It sits on the page's ground, so once the list has landed its fade brings the
 * list in round the card while the card crosses onto an identical one. The list
 * can stand the card elsewhere than it was drawn: in a list shorter than the
 * screen nothing scrolls, and cards after it too short to fill the list stop
 * the scroll early, neither of which `feedLandingCardPlace` can see. Then the
 * card first moves to where the list has it, over the ground the list is still
 * under, so it never shows twice; under Reduce Motion the two cross instead.
 */
function OpeningCard({
  card,
  place,
  cardWidth,
  horizontalPadding,
  pendingAction,
  leaving,
  landedTop,
  onLeft,
}: {
  card: ProfileFeedCard;
  place: FeedLandingCardPlace;
  cardWidth: number;
  horizontalPadding: number;
  /** The list's, so the card's actions dim as the list card's do. */
  pendingAction: string | null;
  /** The list has landed: move to where it stands the card, fade, then `onLeft`. */
  leaving: boolean;
  /** Where the landed list stands the card, from the list's top; null when it cannot say. */
  landedTop: () => number | null;
  onLeft: () => void;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1, { useNativeDriver: true }));
  const [shift] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  /** Where the card's top was laid out, from the list's top. */
  const drawnTopRef = useRef<number | null>(null);

  useEffect(() => {
    if (!leaving) {
      // A landing begun again before the handover had run, as when the list
      // reorders under the card: the card stands whole, where it was drawn.
      opacity.setValue(1);
      shift.setValue(0);
      return undefined;
    }
    const target = landedTop();
    const drawn = drawnTopRef.current;
    const distance = target === null || drawn === null ? 0 : target - drawn;
    const fade = Animated.timing(opacity, {
      toValue: 0,
      duration: OPENING_CARD_HANDOVER_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    const handover = reducedMotion || Math.abs(distance) < 1 ? fade : Animated.sequence([
      Animated.timing(shift, {
        toValue: distance,
        duration: OPENING_CARD_HANDOVER_MS,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      fade,
    ]);
    handover.start(({ finished }) => {
      if (finished) onLeft();
    });
    return () => handover.stop();
  }, [landedTop, leaving, onLeft, opacity, reducedMotion, shift]);

  return (
    <Animated.View
      testID="profile-media-feed-opening-card"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // One surface as it fades. Android's per-child alpha would thin the
      // ground under the card and dim the card halfway through, as it darkened
      // the reel's dissolve (`zoom-returns-the-video.test.ts`).
      needsOffscreenAlphaCompositing
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        backgroundColor: theme.colors.background,
        opacity,
      }}
    >
      {place === 'end' ? <View style={{ flexGrow: 1 }} /> : null}
      <Animated.View
        onLayout={(event) => {
          drawnTopRef.current = event.nativeEvent.layout.y + (place === 'padded' ? LIST_PADDING_TOP : 0);
        }}
        style={{
          flexShrink: 0,
          paddingHorizontal: horizontalPadding,
          paddingTop: place === 'padded' ? LIST_PADDING_TOP : 0,
          transform: [{ translateY: shift }],
        }}
      >
        <MediaZoomSurface>
          <ProfileFeedCardView
            card={card}
            contentWidth={cardWidth}
            showActiveVideo={false}
            // Its audio player cannot be reached, so it never keeps a sound going.
            screenFocused={false}
            pendingAction={pendingAction}
            onOpen={ignore}
            onReadMore={ignore}
            onActionsOpen={ignore}
            onAction={ignore}
          />
        </MediaZoomSurface>
      </Animated.View>
    </Animated.View>
  );
}

/** For the opened card's controls, which take no touches. */
function ignore() {}

function FeedTopBar({ title, topInset }: { title: string; topInset: number }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        paddingTop: topInset + 6,
        paddingBottom: 10,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.background,
      }}
    >
      <IconButton icon={BackGlyph} label="Go back" variant="plain" onPress={leaveFeed} />
      <Text style={{ color: theme.colors.text, ...appTheme.type.sectionTitle, fontWeight: '800' }}>
        {title}
      </Text>
    </View>
  );
}

/** A non-blocking problem the reader can act on, above the cards it concerns. */
function FeedNotice({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useAppTheme();
  const tone = theme.semantic.warning;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        marginHorizontal: 14,
        marginTop: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: appTheme.radii.sm,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: tone.border,
        backgroundColor: tone.background,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <RefreshCw size={appTheme.icon.sm} color={tone.foreground} />
      <Text style={{ flex: 1, color: tone.foreground, ...appTheme.type.label }}>{label}</Text>
    </Pressable>
  );
}

function FeedFooterLoader() {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 64, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator accessibilityLabel="Loading more" color={theme.colors.primary} />
    </View>
  );
}

function FeedShell({
  title,
  topInset,
  bottomInset,
  children,
}: {
  title: string;
  topInset: number;
  bottomInset: number;
  children: React.ReactNode;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <FeedTopBar title={title} topInset={topInset} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: bottomInset, paddingHorizontal: 24 }}>
        {children}
      </View>
    </View>
  );
}
