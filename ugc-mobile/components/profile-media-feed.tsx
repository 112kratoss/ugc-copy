import { FlashList, type FlashListRef, type ViewToken } from '@shopify/flash-list';
import { useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { RefreshCw } from 'lucide-react-native';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
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
import { ProfileFeedCardView } from '@/components/profile-feed-card';
import { SecondaryButton, StatusBlock } from '@/components/ui';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
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
  INITIAL_FEED_LANDING,
  buildProfileFeedCards,
  reduceFeedLanding,
  shouldScrollToFeedTarget,
  type ProfileFeedCard,
} from '@/lib/profile-feed-card-view-model';
import { refreshProfileLibraryHead } from '@/lib/profile-library-head';
import { PROFILE_MEDIA_LOAD_MORE_COOLDOWN_MS } from '@/lib/profile-media-query';
import { getProfileHandle } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { BackGlyph } from '@/lib/platform-glyphs';
import { appTheme } from '@/lib/theme';
import { getNativeRemixCreateHref, getViewerShareIntent, getViewerShareSourceSurface } from '@/lib/viewer-actions';
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

type ProfileMediaFeedParams = {
  source?: string | string[];
  initialId?: string | string[];
  scope?: string | string[];
};

const CARD_GAP = 12;
/** How often a landing checks its budget and retries after layout has advanced. */
const LANDING_TICK_MS = 250;

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
  const params = useLocalSearchParams<ProfileMediaFeedParams>();
  const source = normalizeViewerSource(params.source);
  const initialId = normalizeParam(params.initialId);
  const postsScope = normalizeParam(params.scope) === 'archived' ? 'archived' : 'active';
  const libraryName = source === 'profile-creations' ? 'Creations' : 'Posts';
  const noun = source === 'profile-creations' ? 'creation' : 'post';
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const listRef = useRef<FlashListRef<ProfileFeedCard>>(null);
  const [actionsOpenItemId, setActionsOpenItemId] = useState<string | null>(null);
  const [commentsOpenItemId, setCommentsOpenItemId] = useState<string | null>(null);
  const [expandedBodyIds, setExpandedBodyIds] = useState<Record<string, boolean>>({});
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);

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
    selection,
  } = library;
  const cards = useMemo(() => buildProfileFeedCards(items), [items]);
  const activeItem = useMemo(
    () => items.find((item) => item.id === actionsOpenItemId) ?? null,
    [items, actionsOpenItemId]
  );
  const commentsItem = useMemo(
    () => items.find((item) => item.id === commentsOpenItemId) ?? null,
    [items, commentsOpenItemId]
  );

  // Coming back to the feed revalidates the library it shares with the grid.
  const refreshLibraryHead = useCallback(
    () => refreshProfileLibraryHead({ api, queryClient, userId: user?.id, library: libraryName }),
    [api, libraryName, queryClient, user?.id]
  );
  useProfileMediaRevalidation({
    enabled: isFocused && Boolean(user),
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
  const [landing, dispatchLanding] = useReducer(reduceFeedLanding, INITIAL_FEED_LANDING);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [listReady, setListReady] = useState(false);
  const landingSeekingRef = useRef(false);
  const landingScrollInFlightRef = useRef(false);
  const landingTargetVisibleRef = useRef(false);
  const targetIndex = initialId ? cards.findIndex((card) => card.id === initialId) : -1;

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
      });
  }, [cards.length, landing, layoutRevision, listReady]);

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

  const openItem = useCallback((
    item: ImmersivePreviewItem,
    options: { comments?: boolean } = {}
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

    const result = await Share.share({ ...intent.content });
    if (result.action !== Share.sharedAction || !item.showcasePostId) return;
    await api
      .shareShowcasePost(item.showcasePostId, { sourceSurface: getViewerShareSourceSurface(item.source) })
      .catch(() => null);
  }, [api]);

  const recreateItem = useCallback((item: ImmersivePreviewItem) => {
    if (!user) {
      router.push('/auth');
      return;
    }
    const href = getNativeRemixCreateHref({
      generationId: item.generationId,
      recreateTool: item.recreateTool,
      prompt: item.recreatePrompt,
      context: { postId: item.showcasePostId, title: item.title, creatorLabel: item.creatorLabel,
        thumbnailUrl: item.mediaKind === 'image' ? item.mediaUrl : null },
    });
    router.push((href ?? `/create/${item.recreateTool}`) as never);
  }, [user]);

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
    if (!user) {
      router.push('/auth');
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
  }, [api, applyPostVisibility, openItem, recreateItem, shareItem, user]);

  if (library.isLoading || selection === 'loading') {
    return (
      <FeedShell title={libraryName} topInset={topInset} bottomInset={bottomInset}>
        <ActivityIndicator accessibilityLabel="Loading media" color={appTheme.colors.primary} />
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
        <Text style={{ color: appTheme.colors.text, ...appTheme.type.sectionTitle, fontWeight: '800' }}>Nothing here yet</Text>
        <Text style={{ color: appTheme.colors.muted, marginTop: 8 }}>This item may have been removed.</Text>
      </FeedShell>
    );
  }

  const showEnrichmentNotice = library.enrichmentFailed && items.some((item) => Boolean(item.linkedPostId));

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
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
      <MediaZoomSurface>
      <View style={{ flex: 1, width: contentWidth, alignSelf: 'center' }}>
      <FlashList
        ref={listRef}
        testID="profile-media-feed-list"
        data={cards}
        keyExtractor={(card) => card.id}
        accessibilityElementsHidden={landing.phase === 'seeking'}
        importantForAccessibility={landing.phase === 'seeking' ? 'no-hide-descendants' : 'auto'}
        pointerEvents={landing.phase === 'seeking' ? 'none' : 'auto'}
        getItemType={(card) => card.isTextOnly
          ? 'text'
          : card.sourceUnavailable
            ? 'unavailable'
            : card.item.mediaKind ?? 'image'}
        extraData={{ activeVideoId, expandedBodyIds, isFocused, pendingAction }}
        maintainVisibleContentPosition={{ disabled: true }}
        onLoad={() => {
          setListReady(true);
          acknowledgeListLayout();
        }}
        onContentSizeChange={acknowledgeListLayout}
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
        onEndReached={requestNextPage}
        onEndReachedThreshold={0.6}
        ListFooterComponent={isFetchingNextPage
          ? <FeedFooterLoader />
          : isFetchNextPageError
            ? <FeedLoadMoreErrorFooter onRetry={retryNextPage} />
            : null}
        ItemSeparatorComponent={() => <View style={{ height: CARD_GAP }} />}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingBottom: bottomInset + 28,
          paddingTop: 12,
        }}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, opacity: landing.phase === 'seeking' ? 0 : 1 }}
        renderItem={({ item: card }) => (
          <ProfileFeedCardView
            card={card}
            contentWidth={cardWidth}
            showActiveVideo={isFocused && activeVideoId === card.id}
            mediaWatchdog={isFocused}
            bodyExpanded={Boolean(expandedBodyIds[card.id])}
            pendingAction={pendingAction}
            onOpen={() => openItem(card.item)}
            onToggleBody={() => setExpandedBodyIds((current) => ({
              ...current,
              [card.id]: !current[card.id],
            }))}
            onActionsOpen={() => setActionsOpenItemId(card.id)}
            onAction={(action) => runCardAction(action, card.item)}
          />
        )}
      />
      {landing.phase === 'seeking' ? (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}
        >
          <ActivityIndicator accessibilityLabel={`Opening ${noun}`} color={appTheme.colors.primary} />
        </View>
      ) : null}
      </View>
      </MediaZoomSurface>
      {activeItem ? (
        <ViewerActionSheet
          item={activeItem}
          onClose={() => setActionsOpenItemId(null)}
          onComments={activeItem.canComment ? () => {
            setActionsOpenItemId(null);
            if (activeItem.previewKind === 'text' && activeItem.sourceType !== 'generation') {
              openItem(activeItem, { comments: true });
              return;
            }
            setCommentsOpenItemId(activeItem.id);
          } : undefined}
          onDetails={() => {
            setActionsOpenItemId(null);
            openItem(activeItem);
          }}
          onRecreate={() => recreateItem(activeItem)}
          onShare={() => void shareItem(activeItem)}
          onDeleted={() => setActionsOpenItemId(null)}
          onSourceRefresh={() => void library.refetch()}
          visible={actionsOpenItemId === activeItem.id}
        />
      ) : null}
      {commentsItem?.canComment && commentsItem.showcasePostId ? (
        <CommentsSheet
          key={commentsItem.showcasePostId}
          postId={commentsItem.showcasePostId}
          postCreatorId={commentsItem.creatorId ?? null}
          commentCount={commentsItem.commentCount}
          onClose={() => setCommentsOpenItemId(null)}
          visible={commentsOpenItemId === commentsItem.id}
        />
      ) : null}
    </View>
  );
}

function leaveFeed() {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/(tabs)/profile' as never);
}

function FeedTopBar({ title, topInset }: { title: string; topInset: number }) {
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
        borderBottomColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.background,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={leaveFeed}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 22,
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        <BackGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
      </Pressable>
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.sectionTitle, fontWeight: '800' }}>
        {title}
      </Text>
    </View>
  );
}

/** A non-blocking problem the reader can act on, above the cards it concerns. */
function FeedNotice({ label, onPress }: { label: string; onPress: () => void }) {
  const tone = appTheme.semantic.warning;

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
  return (
    <View style={{ minHeight: 64, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator accessibilityLabel="Loading more" color={appTheme.colors.primary} />
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
  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <FeedTopBar title={title} topInset={topInset} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: bottomInset, paddingHorizontal: 24 }}>
        {children}
      </View>
    </View>
  );
}
