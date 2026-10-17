import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { BarChart3, ChevronRight, DollarSign, LockOpen, PackageCheck } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { ResourceKindRow } from '@/components/resource-kind-row';
import { CardListSkeleton } from '@/components/skeleton';
import {
  AppText,
  Card,
  Pill,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionTitle,
  StatusBlock,
  WebLinkButton,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { formatUsdCents } from '@/lib/home-view-model';
import { FREE_RECIPE_LABEL, UNKNOWN_AMOUNT_LABEL, formatUnlockCreditPrice } from '@/lib/pricing';
import { WALLET_UNAVAILABLE_CAPTION } from '@/lib/profile-view-model';
import { appTheme, type ToolAccent } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { OwnerPostBundleSummary, OwnerPostListItem } from '@/lib/types';
import { useCreatorPayoutState } from '@/lib/use-creator-payout-state';

const LISTINGS_PAGE_SIZE = 30;

export default function SellerDashboardScreen() {
  const theme = useAppTheme();
  const { user, api } = useAuth();
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
    isLoading,
    isLoadingError,
    isRefetchError,
    refetch,
  } = useInfiniteQuery({
    queryKey: ['seller-dashboard-posts', user?.id],
    enabled: Boolean(user),
    initialPageParam: 0,
    // Listings only, paged by the server. The dashboard used to walk every post
    // on the account, media and all, to find the ones with a recipe (audit
    // 03-7); now every page is listings, so nothing pages on its own.
    queryFn: ({ pageParam }) => api.listOwnerPosts({
      includeArchived: true,
      includeSummary: pageParam === 0,
      limit: LISTINGS_PAGE_SIZE,
      listingsOnly: true,
      offset: pageParam,
      visibility: 'all',
    }),
    getNextPageParam: (lastPage) => lastPage.pageInfo?.nextOffset ?? undefined,
  });
  // Above the signed-out return below, so the hook count never changes when `user` flips.
  const payout = useCreatorPayoutState();

  if (!user) {
    return (
      <Screen>
        <SectionTitle eyebrow="Recipe Sales" title="Sign in to view sales." body="Your paid unlock earnings and seller listings appear here once you sign in." />
        {/* Signing in comes back to Recipe Sales, not Home (audit 01-12). */}
        <PrimaryButton
          label="Sign in"
          onPress={() => router.push({ pathname: '/auth', params: { returnTo: '/seller-dashboard' } } as never)}
          accent="primary"
        />
      </Screen>
    );
  }

  const listings = data?.pages.flatMap((page) => page.posts) ?? [];
  // The first page's totals count every listing, loaded or not.
  const summary = data?.pages[0]?.summary;
  const refreshDashboard = () => {
    void refetch();
    void payout.refetch();
  };

  return (
    <Screen>
      <SectionTitle
        eyebrow="Recipe Sales"
        title="Sales and unlocks."
        body="Track total sales from your reusable resources. Earnings are shown as lifetime tracked sales."
      />

      {!router.canGoBack() ? <SecondaryButton label="Back to profile" onPress={() => router.replace('/(tabs)/profile' as never)} /> : null}

      <PayoutBalance payout={payout} />

      {isLoading ? <CardListSkeleton label="Loading your listings" /> : null}

      {isLoadingError || isRefetchError ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock tone="danger" title="Could not load seller dashboard" body="Your existing listings are safe. Check your connection, then retry." />
          <SecondaryButton label="Retry dashboard" onPress={refreshDashboard} />
        </View>
      ) : null}

      {data ? (
        <>
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: 'row' }}>
              <MetricCard
                icon={<DollarSign size={appTheme.icon.feature} color={theme.colors.info} />}
                label="Tracked earnings"
                value={summary ? formatUsdCents(summary.earningsUsdCents) : UNKNOWN_AMOUNT_LABEL}
              />
            </View>
            {/* Sales are paid unlocks; free unlocks stopped counting as sales on
                2026-10-17 and sit beside them, as on the web's sell page. Three
                cards in one row leave a figure like "$1,234.56" no room. */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <MetricCard
                icon={<BarChart3 size={appTheme.icon.feature} color={theme.colors.primary} />}
                label="Sales"
                value={summary ? String(summary.salesCount) : UNKNOWN_AMOUNT_LABEL}
              />
              <MetricCard
                icon={<LockOpen size={appTheme.icon.feature} color={theme.colors.success} />}
                label="Free unlocks"
                value={summary ? String(summary.freeUnlockCount ?? 0) : UNKNOWN_AMOUNT_LABEL}
              />
            </View>
          </View>

          {isRefetchError ? null : <SecondaryButton label="Refresh dashboard" onPress={refreshDashboard} />}

          <View style={{ gap: 12 }}>
            {listings.map((item) => <ListingRow key={item.id} item={item} />)}
          </View>

          {isFetchNextPageError ? (
            // Waits to be asked again: the effect that paged on its own asked
            // after every failure, on a loop, under the error it had drawn.
            <View style={{ gap: appTheme.spacing.gap }}>
              <StatusBlock tone="danger" title="Could not load more listings" body="Check your connection, then retry." />
              <SecondaryButton
                label={isFetchingNextPage ? 'Loading more listings…' : 'Retry'}
                disabled={isFetchingNextPage}
                onPress={() => void fetchNextPage()}
              />
            </View>
          ) : hasNextPage ? (
            <SecondaryButton
              label={isFetchingNextPage ? 'Loading more listings…' : 'Load more listings'}
              disabled={isFetchingNextPage}
              onPress={() => void fetchNextPage()}
            />
          ) : null}

          {listings.length === 0 && !hasNextPage ? (
            <View style={{ gap: appTheme.spacing.gap }}>
              <StatusBlock title="No seller listings yet" body="Publish a post with reusable resources to start tracking sales here." />
              <PrimaryButton label="Create a listing" accent="primary" onPress={() => router.push('/post/new' as never)} />
            </View>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/**
 * What can be withdrawn now, and the floor a payout waits for (audit 03-1,
 * 03-2). Payouts are requested on the website, so the link stays whatever the
 * balance: the page there also shows a request in progress and past payouts.
 */
function PayoutBalance({ payout }: { payout: Pick<ReturnType<typeof useCreatorPayoutState>, 'data' | 'isError'> }) {
  // A failed read wins over a balance an earlier read left behind, as on the
  // profile's Wallet card: a stale figure can overstate what is withdrawable.
  const loading = !payout.isError && !payout.data;
  const line = payout.isError
    ? WALLET_UNAVAILABLE_CAPTION
    : payout.data
      ? `Payout balance ${payout.data.availableUsd} · Payouts start at ${payout.data.minimumUsd}`
      : `Payout balance ${UNKNOWN_AMOUNT_LABEL}`;

  return (
    <Card>
      {/* A string in every state: Android never clears a label that goes back
          to undefined, and TalkBack read "loading" under the loaded balance. */}
      <AppText variant="bodySm" color="textSecondary" accessibilityLabel={loading ? 'Payout balance loading' : line}>
        {line}
      </AppText>
      <WebLinkButton href={`${env.siteUrl}/marketplace/sell`} label="Request a payout on the web" />
    </Card>
  );
}

type ListingChip = { label: string; accent?: ToolAccent };

/**
 * Why a listing may not be selling, in the web sell page's words and order:
 * the listing check, an archived post, moderation (audit 03-3). A post its
 * owner deleted while it had buyers is kept for them, and that is all it says
 * (audit 03-4).
 */
function listingChips(item: OwnerPostListItem): ListingChip[] {
  if (item.tombstonedAt) return [{ label: 'Deleted · buyers keep access' }];
  const bundle = item.bundle;
  const chips: ListingChip[] = [];
  if (bundle?.status === 'published' && bundle.quality?.eligible === false) chips.push({ label: 'Needs work', accent: 'danger' });
  if (item.archivedAt) chips.push({ label: 'Archived post' });
  if (bundle?.reviewStatus === 'hidden') chips.push({ label: 'Hidden in review', accent: 'danger' });
  if (bundle?.reviewStatus === 'flagged') chips.push({ label: 'Flagged for review', accent: 'amber' });
  return chips;
}

/** The listing check's first issue, which says what to fix; a draft gets it too, as on the web. */
function listingIssue(item: OwnerPostListItem) {
  const quality = item.bundle?.quality;
  if (item.tombstonedAt || !quality || quality.eligible) return null;
  return quality.message ?? 'Improve this listing before it appears in the marketplace.';
}

/**
 * The price in credits, as the app prices every recipe, then what it has done:
 * its paid sales with its free unlocks beside them, then its earnings. A free
 * unlock stopped counting as a sale on 2026-10-17 (it never read as money here,
 * audit 03-8). A count shows on a listing of its own access mode, or once it is
 * above zero, since a recipe can have been free before it was paid or the other
 * way round; the web's sell page draws the same line.
 */
function listingSalesLine(bundle: OwnerPostBundleSummary) {
  const sales = Math.max(0, bundle.salesCount);
  const freeUnlocks = Math.max(0, bundle.freeUnlockCount ?? 0);
  const isFree = bundle.accessMode === 'free';
  const parts = [isFree ? FREE_RECIPE_LABEL : formatUnlockCreditPrice(bundle.priceUsdCents)];
  if (!isFree || sales > 0) parts.push(sales === 1 ? '1 sale' : `${sales} sales`);
  if (isFree || freeUnlocks > 0) parts.push(freeUnlocks === 1 ? '1 free unlock' : `${freeUnlocks} free unlocks`);
  if (!isFree || bundle.earningsUsdCents > 0) parts.push(`${formatUsdCents(bundle.earningsUsdCents)} tracked earnings`);
  return parts.join(' · ');
}

function ListingRow({ item }: { item: OwnerPostListItem }) {
  const theme = useAppTheme();
  const bundle = item.bundle;
  const title = item.title || 'Untitled listing';
  const isDeleted = Boolean(item.tombstonedAt);
  const isFree = bundle?.accessMode === 'free';
  const chips = listingChips(item);
  const issue = listingIssue(item);
  const salesLine = bundle ? listingSalesLine(bundle) : null;
  // An archived or deleted post says so in its chip; its own settings no longer apply.
  const statusLine = isDeleted || item.archivedAt
    ? null
    : `${sentenceLabel(bundle?.status ?? 'draft')} · ${sentenceLabel(item.visibility)}`;
  // The row's label stands in for everything drawn inside it, so it says all of it.
  const spoken = [title, salesLine, statusLine, ...chips.map((chip) => chip.label), issue].filter(Boolean).join(', ');

  const card = (
    <Card accent={isDeleted ? undefined : isFree ? 'workflow' : 'amber'}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <PackageCheck
          size={appTheme.icon.feature}
          color={isDeleted ? theme.colors.faint : isFree ? theme.colors.success : theme.colors.commerce}
        />
        <AppText numberOfLines={1} variant="cardTitle" style={{ flex: 1 }}>
          {title}
        </AppText>
        {isDeleted ? null : <ChevronRight size={20} color={theme.colors.faint} />}
      </View>
      {salesLine ? <AppText variant="bodySm" color="muted">{salesLine}</AppText> : null}
      {statusLine ? <AppText variant="caption" color="faint">{statusLine}</AppText> : null}
      {chips.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {chips.map((chip) => <Pill key={chip.label} label={chip.label} accent={chip.accent} />)}
        </View>
      ) : null}
      {issue ? <AppText variant="bodySm" color="danger">{issue}</AppText> : null}
      <ResourceKindRow kinds={bundle?.resourceKinds ?? []} on="surface" />
    </Card>
  );

  // Kept for its buyers: there is nothing to edit, and the server refuses an
  // edit of a deleted post (409 POST_DELETED).
  if (isDeleted) {
    return <View accessible accessibilityLabel={spoken}>{card}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Edit listing ${spoken}`}
      // Straight to the recipe, as the viewer's "Manage recipe" opens it; on
      // Details the seller had to find it (audit 03-12).
      onPress={() => router.push({ pathname: '/post/new', params: { postId: item.id, focus: 'resources' } } as never)}
      style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      {card}
    </Pressable>
  );
}

/** Raw enum values ("draft", "public") read as developer vocabulary in a caption. */
function sentenceLabel(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ') : value;
}

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  const theme = useAppTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={{ flex: 1 }}>
      <Card>
        <View style={{ gap: 10 }}>
          <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' }}>
            {icon}
          </View>
          <AppText variant="caption" color="faint">{label}</AppText>
          <AppText variant="sectionTitle" style={{ fontVariant: ['tabular-nums'] }}>{value}</AppText>
        </View>
      </Card>
    </View>
  );
}
