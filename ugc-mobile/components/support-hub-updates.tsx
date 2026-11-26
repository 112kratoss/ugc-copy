import { useIsFocused } from '@react-navigation/native';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Megaphone, MessageCircle, MessageCircleOff, Sparkles } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { SkeletonBone } from '@/components/skeleton';
import { SupportHubReactions } from '@/components/support-hub-reactions';
import { AppText, SecondaryButton, StatusBlock } from '@/components/ui';
import { useAppForeground } from '@/lib/app-foreground';
import { useAuth } from '@/lib/auth';
import { verticalHitSlop } from '@/lib/hit-target';
import { textPostViewerHref } from '@/lib/immersive-preview-view-model';
import { openSignUpSheet } from '@/lib/join-navigation';
import {
  SUPPORT_HUB_WORDS,
  supportHubPath,
  type SupportHubReactionEmoji,
  type SupportUpdatesPage,
} from '@/lib/support-hub-policy/support-hub-policy';
import {
  SUPPORT_UPDATES_LATEST_QUERY_KEY,
  createSupportHubReactor,
  supportUpdateCard,
  supportUpdatesFromPages,
  supportUpdatesLatestAt,
  supportUpdatesNextCursor,
  supportUpdatesQueryKey,
  withSupportUpdateReaction,
  type SupportUpdateCard,
} from '@/lib/support-hub-view-model';
import { markSupportUpdatesSeen } from '@/lib/support-updates-seen';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** The comment line at a card's foot: one line of text with a button's reach. */
const COMMENT_LINK_HEIGHT = 32;

/** Opens an update on the post page, where its comments are: the route a text post opens on from a feed. */
function openUpdate(postId: string) {
  router.push(textPostViewerHref({ postId }) as never);
}

/**
 * Help & Support's Updates: news from the Magicbooklet team, newest first,
 * twenty to a page. Each card says its kind, title, date and first lines,
 * with its reactions and its comments; the card opens the update's post page.
 * Everyone reads them; a guest's reaction asks them to sign up. Once the
 * newest update has been shown here the unread dot goes, on this tab and on
 * the side menu.
 */
export function SupportUpdatesTab({ active }: { active: boolean }) {
  const { api, user } = useAuth();
  const theme = useAppTheme();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const updatesQuery = useInfiniteQuery({
    queryKey: supportUpdatesQueryKey(userId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.getSupportUpdates({ cursor: pageParam }),
    getNextPageParam: supportUpdatesNextCursor,
  });
  // A pull the reader made, not a refetch: on iOS a `refreshing` the list did
  // not ask for drags it down and can leave it there (comments-sheet.tsx).
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [failedId, setFailedId] = useState<string | null>(null);

  const pages = updatesQuery.data?.pages;
  const readAt = updatesQuery.dataUpdatedAt;
  const cards = useMemo(() => {
    const now = new Date(readAt);
    return supportUpdatesFromPages(pages).map((update) => supportUpdateCard(update, now));
  }, [pages, readAt]);
  const latestAt = supportUpdatesLatestAt(pages);

  // The newest update has been shown: the dot goes, here and on the menu, and
  // the menu's own read of the newest takes this fresher one. Shown means
  // looked at: the tab in front, on the screen in front, with the app open,
  // so a read that lands under a pushed post page or in the background clears
  // nothing until the reader is back.
  const isFocused = useIsFocused();
  const foreground = useAppForeground();
  const lookedAt = active && isFocused && foreground;
  useEffect(() => {
    if (!lookedAt || latestAt === undefined) return;
    queryClient.setQueryData(SUPPORT_UPDATES_LATEST_QUERY_KEY, latestAt);
    if (latestAt) void markSupportUpdatesSeen(latestAt);
  }, [lookedAt, latestAt, queryClient]);

  const reactor = useMemo(() => createSupportHubReactor({
    send: (id, emoji) => api.reactToSupportUpdate(id, emoji),
    draw: (id, state) => {
      queryClient.setQueryData<InfiniteData<SupportUpdatesPage>>(
        supportUpdatesQueryKey(userId),
        (data) => withSupportUpdateReaction(data, id, state),
      );
    },
    failed: (id) => setFailedId(id),
  }), [api, queryClient, userId]);

  const react = (card: SupportUpdateCard, emoji: SupportHubReactionEmoji) => {
    setFailedId((current) => (current === card.id ? null : current));
    reactor.press(card.id, card.reactions, emoji);
  };

  const signIn = () => openSignUpSheet(router, supportHubPath('updates'));

  const refresh = () => {
    setPullRefreshing(true);
    void updatesQuery.refetch().finally(() => setPullRefreshing(false));
  };

  const emptyState = updatesQuery.isError ? (
    <View style={{ gap: appTheme.spacing.gap }}>
      <StatusBlock tone="danger" title={SUPPORT_HUB_WORDS.updatesLoadFailed} />
      <SecondaryButton
        label={SUPPORT_HUB_WORDS.tryAgain}
        loading={updatesQuery.isRefetching}
        onPress={() => void updatesQuery.refetch()}
      />
    </View>
  ) : updatesQuery.isPending ? (
    <SupportUpdatesSkeleton />
  ) : (
    <StatusBlock title={SUPPORT_HUB_WORDS.updatesEmptyTitle} body={SUPPORT_HUB_WORDS.updatesEmptyBody} />
  );

  return (
    <FlatList
      data={cards}
      extraData={failedId}
      keyExtractor={(card) => card.id}
      renderItem={({ item }) => (
        <SupportUpdateCardView
          card={item}
          canReact={Boolean(user)}
          failed={failedId === item.id}
          onOpen={() => openUpdate(item.id)}
          onReact={(emoji) => react(item, emoji)}
          onSignIn={signIn}
        />
      )}
      ItemSeparatorComponent={UpdateSeparator}
      ListEmptyComponent={emptyState}
      ListFooterComponent={updatesQuery.hasNextPage ? (
        // Wrapped rather than styled: a styled button grows to fill its parent (`flexGrow`),
        // which drew the roadmap's "Read the update" as a tall empty pill on the iPhone.
        <View style={{ marginTop: appTheme.spacing.gap }}>
          <SecondaryButton
            label={SUPPORT_HUB_WORDS.loadMore}
            loading={updatesQuery.isFetchingNextPage}
            disabled={updatesQuery.isFetchingNextPage}
            onPress={() => void updatesQuery.fetchNextPage()}
          />
        </View>
      ) : null}
      onRefresh={refresh}
      refreshing={pullRefreshing}
      // No field here; should the chat's keyboard still be on its way down, a press on a card answers.
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{
        paddingHorizontal: appTheme.spacing.screen,
        paddingTop: appTheme.spacing.compact,
        paddingBottom: appTheme.spacing.section,
      }}
    />
  );
}

function UpdateSeparator() {
  return <View style={{ height: appTheme.spacing.gap }} />;
}

function SupportUpdateCardView({
  card,
  canReact,
  failed,
  onOpen,
  onReact,
  onSignIn,
}: {
  card: SupportUpdateCard;
  canReact: boolean;
  failed: boolean;
  onOpen: () => void;
  onReact: (emoji: SupportHubReactionEmoji) => void;
  onSignIn: () => void;
}) {
  const theme = useAppTheme();
  const KindIcon = card.kind === 'shipped' ? Sparkles : Megaphone;
  const CommentIcon = card.commentsLocked ? MessageCircleOff : MessageCircle;

  return (
    <View
      style={{
        gap: appTheme.spacing.gap,
        padding: appTheme.spacing.card,
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.panel,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={card.accessibilityLabel}
        accessibilityHint="Opens the update and its comments"
        onPress={onOpen}
        style={({ pressed }) => ({ gap: appTheme.spacing.compact, opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: appTheme.spacing.unit,
              paddingHorizontal: appTheme.spacing.compact,
              paddingVertical: appTheme.spacing.unit,
              borderRadius: appTheme.radii.pill,
              backgroundColor: card.kind === 'shipped' ? theme.colors.selected : theme.colors.surfaceStrong,
            }}
          >
            <KindIcon size={appTheme.icon.xs} color={card.kind === 'shipped' ? theme.colors.primary : theme.colors.textSecondary} />
            <AppText variant="caption" color={card.kind === 'shipped' ? 'primary' : 'textSecondary'} numberOfLines={1}>
              {card.kindLabel}
            </AppText>
          </View>
          <AppText variant="caption" color="faint" numberOfLines={1} style={{ flexShrink: 1 }}>
            {card.dateLabel}
          </AppText>
        </View>
        {card.title ? <AppText variant="cardTitle">{card.title}</AppText> : null}
        {card.preview ? (
          <AppText variant="bodySm" color="textSecondary" numberOfLines={4}>
            {card.preview}
          </AppText>
        ) : null}
      </Pressable>
      <SupportHubReactions
        subject={card.title}
        state={card.reactions}
        canReact={canReact}
        failed={failed}
        onReact={onReact}
        onSignIn={onSignIn}
        trailing={(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={card.commentWords}
            accessibilityHint="Opens the update and its comments"
            onPress={onOpen}
            hitSlop={verticalHitSlop(COMMENT_LINK_HEIGHT)}
            style={({ pressed }) => ({
              minHeight: COMMENT_LINK_HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              gap: appTheme.spacing.unit,
              paddingHorizontal: appTheme.spacing.unit,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <CommentIcon size={appTheme.icon.sm} color={theme.colors.muted} />
            <AppText variant="label" color="muted" numberOfLines={1}>{card.commentWords}</AppText>
          </Pressable>
        )}
      />
    </View>
  );
}

/** Two cards' bones while the first page loads: the kind and date, a title, the first lines and the reactions. */
function SupportUpdatesSkeleton() {
  const theme = useAppTheme();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading updates" style={{ gap: appTheme.spacing.gap }}>
      {[0, 1].map((index) => (
        <View
          key={index}
          style={{
            gap: appTheme.spacing.gap,
            padding: appTheme.spacing.card,
            borderRadius: appTheme.radii.lg,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.panel,
          }}
        >
          {/* Uneven widths so the stack reads as content rather than a pattern. */}
          <SkeletonBone width="38%" height={20} radius={appTheme.radii.pill} />
          <SkeletonBone width={index === 0 ? '74%' : '60%'} height={22} strong />
          <SkeletonBone width="100%" height={13} radius={appTheme.radii.pill} />
          <SkeletonBone width="82%" height={13} radius={appTheme.radii.pill} />
          <SkeletonBone width="44%" height={32} radius={appTheme.radii.pill} />
        </View>
      ))}
    </View>
  );
}
