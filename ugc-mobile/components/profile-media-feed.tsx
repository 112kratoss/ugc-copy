import { FlashList, type FlashListRef, type ViewToken } from '@shopify/flash-list';
import { useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Share,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CommentsSheet } from '@/components/comments-sheet';
import { ProfileFeedCardView } from '@/components/profile-feed-card';
import { SecondaryButton, StatusBlock } from '@/components/ui';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import {
  buildViewerItems,
  loadImmersiveSourceData,
  normalizeParam,
  normalizeViewerSource,
  readCachedImmersiveSourceData,
  readCachedProfile,
} from '@/lib/immersive-preview-source-data';
import {
  getImmersiveInitialIndex,
  immersivePreviewOpenHref,
  type ImmersivePreviewItem,
} from '@/lib/immersive-preview-view-model';
import {
  FEED_LANDING_RETRY_DELAYS_MS,
  buildProfileFeedCards,
  shouldReassertFeedLanding,
  type ProfileFeedCard,
} from '@/lib/profile-feed-card-view-model';
import { getProfileHandle } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { BackGlyph } from '@/lib/platform-glyphs';
import { appTheme } from '@/lib/theme';
import { getNativeRemixCreateHref, getViewerShareIntent, getViewerShareSourceSurface } from '@/lib/viewer-actions';
import {
  changePostVisibility,
  pickPostVisibility,
  toPostLifecyclePost,
  type PostLifecyclePost,
} from '@/lib/post-lifecycle';
import type { PostLifecycleVisibility } from '@/lib/post-lifecycle-policy';
import { refreshViewerMediaCaches } from '@/lib/viewer-media-cache';

type ProfileMediaFeedParams = {
  source?: string | string[];
  initialId?: string | string[];
};

const CARD_GAP = 12;

/**
 * Creations and Posts open here rather than in the reel: owned media is managed,
 * not consumed, so it reads as a card feed in the same visual language as Home,
 * with the ownership controls inline. Opening a text post uses its dedicated
 * reading screen; image and video cards still open the reel.
 */
export function ProfileMediaFeedScreen() {
  const params = useLocalSearchParams<ProfileMediaFeedParams>();
  const source = normalizeViewerSource(params.source);
  const initialId = normalizeParam(params.initialId);
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const listRef = useRef<FlashListRef<ProfileFeedCard>>(null);
  const landedRef = useRef(false);
  const readerTookOverRef = useRef(false);
  const landingAttemptsRef = useRef(0);
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

  const sourceQuery = useQuery({
    queryKey: ['immersive-preview-source', source, user?.id ?? 'guest', initialId, '', ''],
    enabled: Boolean(source),
    initialData: () => readCachedImmersiveSourceData(queryClient, source, user?.id, initialId),
    queryFn: () => loadImmersiveSourceData({ api, source, initialId }),
    staleTime: 1000 * 45,
  });

  const ownerInfo = useMemo(() => ({
    creatorLabel: user ? getProfileHandle(profileQuery.data, user.email) : '@creator',
    creatorAvatar: profileQuery.data?.avatarUrl ?? null,
    creatorId: user?.id ?? null,
  }), [profileQuery.data, user]);

  const items = useMemo(
    () => buildViewerItems(source, sourceQuery.data, ownerInfo),
    [source, sourceQuery.data, ownerInfo]
  );
  const cards = useMemo(() => buildProfileFeedCards(items), [items]);
  const initialIndex = useMemo(() => getImmersiveInitialIndex(items, initialId), [items, initialId]);
  const activeItem = useMemo(
    () => items.find((item) => item.id === actionsOpenItemId) ?? null,
    [items, actionsOpenItemId]
  );
  const commentsItem = useMemo(
    () => items.find((item) => item.id === commentsOpenItemId) ?? null,
    [items, commentsOpenItemId]
  );

  /**
   * Land on the tapped card, re-asserting until it is actually on screen.
   * Scrolling (rather than reordering) is what keeps the items above it reachable.
   *
   * The previous single deferred frame could be dropped entirely: it marked itself
   * done synchronously but scrolled a frame later, so any change to `cards` or
   * `initialIndex` in between — routine, since the source and profile queries settle
   * independently — cancelled the pending frame and the re-run then saw the work as
   * already done. Whatever position the list happened to hold became final, which is
   * how tapping the sixth creation opened the oldest one on iOS.
   */
  useEffect(() => {
    landedRef.current = false;
    readerTookOverRef.current = false;
    landingAttemptsRef.current = 0;
  }, [initialId]);

  const landOnTarget = useCallback(() => {
    if (!shouldReassertFeedLanding({
      targetIndex: initialIndex,
      cardCount: cards.length,
      landed: landedRef.current,
      readerTookOver: readerTookOverRef.current,
      attempts: landingAttemptsRef.current,
    })) return;

    landingAttemptsRef.current += 1;
    listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
  }, [cards.length, initialIndex]);

  useEffect(() => {
    landOnTarget();
    const timers = FEED_LANDING_RETRY_DELAYS_MS.map((delay) => setTimeout(landOnTarget, delay));

    return () => timers.forEach(clearTimeout);
  }, [landOnTarget]);

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
      recreateTool: item.recreateTool,
      prompt: item.recreatePrompt,
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
        await refreshViewerMediaCaches(queryClient, user?.id);
        await sourceQuery.refetch();
      }
    } finally {
      setPendingAction(null);
    }
  }, [api, queryClient, sourceQuery, user?.id]);

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
        const post = toPostLifecyclePost({
          id: item.linkedPostId,
          visibility: item.linkedPostVisibility,
          archivedAt: item.linkedPostArchivedAt,
          bundle: item.linkedPostBundle ?? null,
        });
        pickPostVisibility(post.visibility, (next) => void applyPostVisibility(post, next, action));
        return;
      }
      default:
        return;
    }
  }, [applyPostVisibility, openItem, recreateItem, shareItem, user]);

  if (!cards.length && sourceQuery.isLoading) {
    return (
      <FeedShell topInset={topInset} bottomInset={bottomInset}>
        <ActivityIndicator accessibilityLabel="Loading media" color={appTheme.colors.primary} />
      </FeedShell>
    );
  }

  if (!cards.length && sourceQuery.isError) {
    return (
      <FeedShell topInset={topInset} bottomInset={bottomInset}>
        <View style={{ width: '100%', maxWidth: 420, gap: 12 }}>
          <StatusBlock tone="danger" title="Couldn't load this media" body="Check your connection and try again." />
          <SecondaryButton label="Try again" onPress={() => void sourceQuery.refetch()} />
        </View>
      </FeedShell>
    );
  }

  if (!cards.length) {
    return (
      <FeedShell topInset={topInset} bottomInset={bottomInset}>
        <Text style={{ color: appTheme.colors.text, ...appTheme.type.sectionTitle, fontWeight: '800' }}>Nothing here yet</Text>
        <Text style={{ color: appTheme.colors.muted, marginTop: 8 }}>This item may have been removed.</Text>
      </FeedShell>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <FeedTopBar
        title={source === 'profile-creations' ? 'Creations' : 'Posts'}
        topInset={topInset}
      />
      {/* FlashList rather than FlatList: cards are variable height (media aspect ratio
          and body length both differ), so FlatList could not implement getItemLayout and
          could not jump to the tapped card. */}
      <View style={{ flex: 1, width: contentWidth, alignSelf: 'center' }}>
      <FlashList
        ref={listRef}
        testID="profile-media-feed-list"
        data={cards}
        keyExtractor={(card) => card.id}
        initialScrollIndex={initialIndex}
        getItemType={(card) => card.isTextOnly ? 'text' : card.item.mediaKind ?? 'image'}
        extraData={{ activeVideoId, expandedBodyIds, pendingAction }}
        onScrollBeginDrag={() => {
          // The reader's own scroll outranks the landing: never yank them back.
          readerTookOverRef.current = true;
        }}
        onViewableItemsChanged={({ viewableItems }: { viewableItems: Array<ViewToken<ProfileFeedCard>> }) => {
          const firstVideo = viewableItems.find((token) => token.item?.item.mediaKind === 'video');
          setActiveVideoId(firstVideo?.item?.id ?? null);

          if (!landedRef.current && initialId
            && viewableItems.some((token) => token.item?.id === initialId)) {
            landedRef.current = true;
          }
        }}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        ItemSeparatorComponent={() => <View style={{ height: CARD_GAP }} />}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingBottom: bottomInset + 28,
          paddingTop: 12,
        }}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        renderItem={({ item: card }) => (
          <ProfileFeedCardView
            card={card}
            contentWidth={cardWidth}
            showActiveVideo={isFocused && activeVideoId === card.id}
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
      </View>
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
          onSourceRefresh={() => void sourceQuery.refetch()}
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
        onPress={() => router.back()}
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

function FeedShell({
  topInset,
  bottomInset,
  children,
}: {
  topInset: number;
  bottomInset: number;
  children: React.ReactNode;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <FeedTopBar title="Media" topInset={topInset} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: bottomInset, paddingHorizontal: 24 }}>
        {children}
      </View>
    </View>
  );
}
