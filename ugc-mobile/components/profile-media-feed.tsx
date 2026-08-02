import { FlashList, type FlashListRef, type ViewToken } from '@shopify/flash-list';
import { useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
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
import { buildProfileFeedCards, type ProfileFeedCard } from '@/lib/profile-feed-card-view-model';
import { getProfileHandle } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import { getNativeRemixCreateHref } from '@/lib/viewer-actions';
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
  const positionedRef = useRef(false);
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
   * `initialScrollIndex` is only honoured at mount. The source query usually resolves
   * from cache synchronously, but when it doesn't the list has already painted at the
   * top by the time the tapped item exists — so land on it explicitly once it does.
   * Scrolling (rather than reordering) is what keeps the items above it reachable.
   */
  useEffect(() => {
    if (positionedRef.current || !cards.length || initialIndex <= 0) return;
    positionedRef.current = true;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [cards.length, initialIndex]);

  const openItem = useCallback((
    item: ImmersivePreviewItem,
    options: { comments?: boolean } = {}
  ) => {
    router.push(immersivePreviewOpenHref(item, options) as never);
  }, []);

  const shareItem = useCallback(async (item: ImmersivePreviewItem) => {
    if (!item.canShare) return;
    const url = item.sharePath ? `${env.siteUrl}${item.sharePath}` : null;
    await Share.share({
      title: item.title,
      message: url ? `${item.title}\n${url}` : `${item.title}\n${item.displayText}`,
      url: url ?? undefined,
    });
  }, []);

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
    postId: string,
    visibility: 'public' | 'unlisted' | 'private',
    action: string
  ) => {
    setPendingAction(action);
    try {
      await api.updatePost(postId, { visibility });
      await refreshViewerMediaCaches(queryClient, user?.id);
      await sourceQuery.refetch();
    } catch {
      Alert.alert('Could not update visibility', 'Please try again.');
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
      case 'change-visibility':
        Alert.alert('Change visibility', 'Choose who can see this post.', [
          { text: 'Public', onPress: () => void applyPostVisibility(item.id, 'public', action) },
          { text: 'Unlisted', onPress: () => void applyPostVisibility(item.id, 'unlisted', action) },
          { text: 'Private', onPress: () => void applyPostVisibility(item.id, 'private', action) },
          { text: 'Cancel', style: 'cancel' },
        ]);
        return;
      case 'make-private':
      case 'make-public': {
        const linkedPostId = item.linkedPostId;
        if (!linkedPostId) return;
        const nextVisibility = action === 'make-private' ? 'private' : 'public';
        const label = action === 'make-private' ? 'Make private' : 'Make public';
        Alert.alert(
          `${label}?`,
          action === 'make-private'
            ? 'This linked post will leave public surfaces until you make it public again.'
            : 'This linked post will return to public surfaces.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: label, onPress: () => void applyPostVisibility(linkedPostId, nextVisibility, action) },
          ]
        );
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
        onViewableItemsChanged={({ viewableItems }: { viewableItems: Array<ViewToken<ProfileFeedCard>> }) => {
          const firstVideo = viewableItems.find((token) => token.item?.item.mediaKind === 'video');
          setActiveVideoId(firstVideo?.item?.id ?? null);
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
        <ArrowLeft size={24} color={appTheme.colors.text} strokeWidth={2.3} />
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
