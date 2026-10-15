import { useFocusEffect } from '@react-navigation/native';
import { useInfiniteQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import {
  Gift,
  RotateCcw,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';

import { FeedEndFooter, FeedLoadMoreErrorFooter } from '@/components/feed-pagination-footer';
import { CardListSkeleton } from '@/components/skeleton';
import { AppText, Card, Kicker, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import {
  CREDIT_HISTORY_PAGE_SIZE,
  creditChangeDirection,
  creditHistoryQueryKey,
  describeCreditHistoryEntry,
  flattenCreditHistoryPages,
  formatCreditChange,
  formatCreditHistoryTime,
  nextCreditHistoryCursor,
  parseCreditHistoryPage,
} from '@/lib/credit-history-view-model';
import { haptic } from '@/lib/haptics';
import { CREDIT_BALANCE_LOADING_LABEL, formatCreditAmount } from '@/lib/pricing';
import { truncateInfiniteDataToFirstPage } from '@/lib/profile-media-query';
import { appTheme, type ThemeColorName } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { CreditHistoryEntry, CreditHistoryEntryKind, CreditHistoryResponse } from '@/lib/types';

/**
 * Back to the newest page and read it again; the older pages go and are asked
 * for anew as the reader scrolls (see the query's note below).
 */
function readNewestAgain(queryClient: QueryClient, key: ReturnType<typeof creditHistoryQueryKey>) {
  queryClient.setQueryData<InfiniteData<CreditHistoryResponse>>(key, truncateInfiniteDataToFirstPage);
  return queryClient.refetchQueries({ queryKey: key, exact: true });
}

/**
 * Every credit added to the balance and taken from it, newest first (decision
 * D6, finding 03-11): purchases, welcome and referral credits, refunds of
 * failed creations, reversed purchases, what each creation and unlock spent,
 * and adjustments. A balance that drops after a refund had no explanation
 * anywhere before this list. Guests have one too: their credits sit on their
 * own identity, and an account's list carries the rows of every guest it took
 * in. Opened from Pricing's balance and from the Profile's Credits card.
 */
export default function CreditHistoryScreen() {
  const theme = useAppTheme();
  // `identityUserId`, not `user`: a guest holds credits on its own identity,
  // and the server lists a guest's history as it lists an account's (C4).
  const { identityUserId, api, credits, refreshProfile } = useAuth();
  // Opened from Pricing, Back is the way to buy; from anywhere else the
  // balance offers it.
  const { source } = useLocalSearchParams<{ source?: string }>();
  const queryClient = useQueryClient();
  const historyQuery = useInfiniteQuery({
    queryKey: creditHistoryQueryKey(identityUserId),
    enabled: Boolean(identityUserId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => parseCreditHistoryPage(
      await api.getCreditHistory({ cursor: pageParam, limit: CREDIT_HISTORY_PAGE_SIZE }),
    ),
    getNextPageParam: nextCreditHistoryCursor,
    // React Query reads an infinite query again page by page, with the cursors
    // it first used. A row written since moves where the first page ends, so
    // the rows between that end and the second page's old cursor would be
    // skipped: a ledger with a hole in it. Only the first page is ever read
    // again, on each arrival (below) and on a pull, and the older pages go.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Each arrival reads the newest page again: back from Pricing after a
  // purchase, or opened again after a creation spent credits. A first visit's
  // read is the query's own, and already under way when this runs; a read
  // still out (an older page, a pull) is left to finish.
  useFocusEffect(useCallback(() => {
    if (!identityUserId) return;
    const key = creditHistoryQueryKey(identityUserId);
    const state = queryClient.getQueryState(key);
    if (!state || state.data === undefined || state.fetchStatus !== 'idle') return;
    void readNewestAgain(queryClient, key);
  }, [identityUserId, queryClient]));

  // Bound to the reader's own pull, never to a background read: on iOS a
  // `refreshing` that flips without a drag shifts the list down and can leave
  // it there (the note in components/home-dashboard.tsx).
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const refreshHistory = () => {
    if (!identityUserId) return;
    haptic.light();
    setPullRefreshing(true);
    // The balance above the list is read again with it, so the two agree.
    void Promise.allSettled([readNewestAgain(queryClient, creditHistoryQueryKey(identityUserId)), refreshProfile()])
      .finally(() => setPullRefreshing(false));
  };

  const loadOlder = () => {
    // A page that failed waits for its Retry: reaching the end again would
    // fail the same way. Nor is a page asked for while the first is read
    // again, which would cancel that read.
    if (!historyQuery.hasNextPage || historyQuery.isFetching || historyQuery.isFetchNextPageError) return;
    void historyQuery.fetchNextPage();
  };

  const entries = flattenCreditHistoryPages(historyQuery.data?.pages);
  // C4 answers a cursor it cannot read 400. The server wrote that cursor, so
  // the history changed under it (a deploy, a guest taken in): asking again
  // with it would fail the same way, and the list starts over from the newest.
  const cursorRefused = historyQuery.isFetchNextPageError
    && historyQuery.error instanceof ApiError
    && historyQuery.error.status === 400;

  const header = (
    <View style={{ gap: appTheme.spacing.section, paddingBottom: appTheme.spacing.panel }}>
      <SectionTitle
        eyebrow="Your credits"
        title="Credits in and out."
        body="Purchases, welcome and referral credits, refunds, and what your creations and unlocks spent, newest first."
      />
      <BalanceSummary credits={credits} offerCredits={source !== 'pricing'} />
      {entries.length > 0 && historyQuery.isRefetchError ? (
        <StatusBlock
          tone="danger"
          title="Could not refresh your credit history"
          body="This is what loaded before. Check your connection, then pull down to try again."
        />
      ) : null}
    </View>
  );

  const emptyState = !identityUserId ? (
    // The guest session has not landed yet (first launch, offline). The query
    // starts by itself once it does.
    <StatusBlock
      title="Your session is still starting"
      body="Your credit history appears once your session is ready. The app keeps trying in the background, and this screen updates by itself."
    />
  ) : historyQuery.isPending ? (
    <CardListSkeleton label="Loading credit history" />
  ) : historyQuery.isError ? (
    <View style={{ gap: appTheme.spacing.gap }}>
      <StatusBlock
        tone="danger"
        title="Could not load your credit history"
        body="Your credits are safe. Check your connection, then try again."
      />
      <SecondaryButton label="Try again" onPress={() => void historyQuery.refetch()} />
    </View>
  ) : (
    <StatusBlock
      title="No credit activity yet"
      body="Credits you buy or receive, and what your creations and unlocks spend, are listed here."
    />
  );

  const footer = historyQuery.isFetchingNextPage ? (
    <View style={{ minHeight: 64, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator accessibilityLabel="Loading older credit history" color={theme.colors.primary} />
    </View>
  ) : cursorRefused ? (
    <View style={{ gap: appTheme.spacing.gap, paddingTop: appTheme.spacing.section }}>
      <StatusBlock
        title="Your credit history changed since it was opened"
        body="Reload it from the newest to read further back."
      />
      <SecondaryButton
        label="Reload from the newest"
        disabled={historyQuery.isFetching}
        onPress={() => {
          if (identityUserId) void readNewestAgain(queryClient, creditHistoryQueryKey(identityUserId));
        }}
      />
    </View>
  ) : historyQuery.isFetchNextPageError ? (
    <FeedLoadMoreErrorFooter onRetry={() => void historyQuery.fetchNextPage()} />
  ) : historyQuery.hasNextPage ? (
    // Scrolling asks for the older page a screen before the end, so the
    // spinner has this place by the time it shows. It stays for the reader
    // who reached the end while the newest page was being read again: the
    // list does not ask twice for the same length of content.
    <View style={{ paddingTop: appTheme.spacing.section }}>
      <SecondaryButton label="Load more" disabled={historyQuery.isFetching} onPress={loadOlder} />
    </View>
  ) : entries.length > 0 ? (
    <FeedEndFooter message="Your credit history starts here." />
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <FlatList
        data={entries}
        keyExtractor={(entry) => entry.id}
        // The first and last rows round the group's corners, so the old last
        // row is drawn again when an older page lands below it.
        extraData={entries.length}
        renderItem={({ item, index }) => (
          <CreditHistoryRow entry={item} first={index === 0} last={index === entries.length - 1} />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={emptyState}
        ListFooterComponent={footer}
        onEndReached={loadOlder}
        onEndReachedThreshold={1}
        initialNumToRender={12}
        refreshControl={identityUserId ? (
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={refreshHistory}
            tintColor={theme.colors.faint}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.panelSoft}
          />
        ) : undefined}
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{
          paddingHorizontal: appTheme.spacing.screen,
          paddingTop: appTheme.spacing.screen,
          paddingBottom: 36,
        }}
      />
    </View>
  );
}

/**
 * The balance the rows add up to, as Pricing draws it. Opened from anywhere but
 * Pricing it offers the packs too, since the Profile's Credits card, which used
 * to open Pricing, now opens this screen.
 */
function BalanceSummary({ credits, offerCredits }: { credits: number | null; offerCredits: boolean }) {
  return (
    <Card accent="commerce" padding="sm">
      <View style={{ gap: 4, padding: appTheme.spacing.compact }}>
        <Kicker color="commerce">Available balance</Kicker>
        <AppText variant="sectionTitle" style={{ fontVariant: ['tabular-nums'] }}>
          {credits === null ? CREDIT_BALANCE_LOADING_LABEL : `${formatCreditAmount(credits)} credits`}
        </AppText>
      </View>
      {offerCredits ? (
        <SecondaryButton
          label="Get credits"
          accessibilityHint="Opens the credit packs"
          onPress={() => router.push('/pricing' as never)}
        />
      ) : null}
    </Card>
  );
}

/** What each kind of entry is drawn with; a kind the server adds later is read as an adjustment. */
const KIND_LOOK: Record<CreditHistoryEntryKind, { icon: LucideIcon; color: ThemeColorName }> = {
  purchase: { icon: ShoppingBag, color: 'commerce' },
  grant: { icon: Gift, color: 'success' },
  refund: { icon: RotateCcw, color: 'success' },
  reversal: { icon: Undo2, color: 'warning' },
  spend: { icon: Sparkles, color: 'primary' },
  adjustment: { icon: SlidersHorizontal, color: 'info' },
};

const GROUP_RADIUS = appTheme.radii.xl;

/**
 * One entry, as a row of one grouped panel: the panel's corners and outline
 * are drawn by its first and last rows, and a hairline sits between rows.
 * Nothing opens from a row, so it is read as one piece of text, not a button.
 */
function CreditHistoryRow({ entry, first, last }: { entry: CreditHistoryEntry; first: boolean; last: boolean }) {
  const theme = useAppTheme();
  const look = KIND_LOOK[entry.kind] ?? KIND_LOOK.adjustment;
  const Icon = look.icon;
  const time = formatCreditHistoryTime(entry.occurredAt);
  const direction = creditChangeDirection(entry.amount);

  return (
    <View
      accessible
      accessibilityLabel={describeCreditHistoryEntry(entry)}
      style={{
        backgroundColor: theme.colors.panel,
        borderColor: theme.colors.borderSubtle,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderTopWidth: first ? 1 : 0,
        borderBottomWidth: last ? 1 : 0,
        borderTopLeftRadius: first ? GROUP_RADIUS : 0,
        borderTopRightRadius: first ? GROUP_RADIUS : 0,
        borderBottomLeftRadius: last ? GROUP_RADIUS : 0,
        borderBottomRightRadius: last ? GROUP_RADIUS : 0,
        borderCurve: 'continuous',
        paddingHorizontal: appTheme.spacing.card,
      }}
    >
      <View
        style={{
          minHeight: 64,
          flexDirection: 'row',
          alignItems: 'center',
          gap: appTheme.spacing.gap,
          paddingVertical: appTheme.spacing.gap,
          borderTopWidth: first ? 0 : 1,
          borderTopColor: theme.colors.borderSubtle,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.panelSoft,
          }}
        >
          <Icon size={appTheme.icon.sm} color={theme.colors[look.color]} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <AppText variant="label">{entry.title}</AppText>
          {entry.detail ? <AppText variant="caption" color="muted">{entry.detail}</AppText> : null}
          {time ? <AppText variant="caption" color="faint">{time}</AppText> : null}
        </View>
        <AppText
          variant="label"
          color={direction === 'in' ? 'success' : direction === 'out' ? 'text' : 'muted'}
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {formatCreditChange(entry.amount)}
        </AppText>
      </View>
    </View>
  );
}
