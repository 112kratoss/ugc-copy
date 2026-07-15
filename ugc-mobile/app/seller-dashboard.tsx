import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { BarChart3, ChevronRight, DollarSign, PackageCheck } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { AppText, Card, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { formatUsdCents, getOwnerPostSalesSummary } from '@/lib/home-view-model';
import { appTheme } from '@/lib/theme';

export default function SellerDashboardScreen() {
  const { user, api } = useAuth();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useInfiniteQuery({
    queryKey: ['seller-dashboard-posts', user?.id],
    enabled: Boolean(user),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listOwnerPosts({
      includeArchived: true,
      includeSummary: pageParam === 0,
      limit: 30,
      offset: pageParam,
      visibility: 'all',
    }),
    getNextPageParam: (lastPage) => lastPage.pageInfo?.nextOffset ?? undefined,
  });

  if (!user) {
    return (
      <Screen>
        <SectionTitle eyebrow="Seller Dashboard" title="Sign in to view sales." body="Your paid unlock earnings and seller listings appear here once you sign in." />
        <PrimaryButton label="Sign in" onPress={() => router.push('/auth')} accent="primary" />
      </Screen>
    );
  }

  const posts = data?.pages.flatMap((page) => page.posts) ?? [];
  const summary = data?.pages[0]?.summary ?? getOwnerPostSalesSummary(posts);
  const listings = posts.filter((post) => post.bundle);

  return (
    <Screen>
      <SectionTitle
        eyebrow="Seller Dashboard"
        title="Sales and unlocks."
        body="Track total sales from your reusable resources. Earnings are shown as lifetime tracked sales."
      />

      {!router.canGoBack() ? <SecondaryButton label="Back to profile" onPress={() => router.replace('/(tabs)/profile' as never)} /> : null}

      {isLoading ? <StatusBlock title="Loading sales" body="Fetching your current listings and unlock totals." /> : null}

      {error ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock tone="danger" title="Could not load seller dashboard" body="Your existing listings are safe. Check your connection, then retry." />
          <SecondaryButton label="Retry dashboard" onPress={() => void refetch()} />
        </View>
      ) : null}

      {!isLoading && !error ? (
        <>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <MetricCard icon={<DollarSign size={22} color={appTheme.colors.info} />} label="Total sales" value={formatUsdCents(summary.earningsUsdCents)} />
            <MetricCard icon={<BarChart3 size={22} color={appTheme.colors.primary} />} label="Unlocks sold" value={String(summary.salesCount)} />
          </View>

          <SecondaryButton label="Refresh dashboard" onPress={() => void refetch()} />

          <View style={{ gap: 12 }}>
            {listings.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`Edit listing ${item.title || 'Untitled listing'}`}
                onPress={() => router.push({ pathname: '/post/new', params: { postId: item.id } } as never)}
                style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
              >
                <Card accent={item.bundle?.accessMode === 'free' ? 'workflow' : 'amber'}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <PackageCheck size={22} color={item.bundle?.accessMode === 'free' ? appTheme.colors.success : appTheme.colors.commerce} />
                    <AppText numberOfLines={1} variant="cardTitle" style={{ flex: 1 }}>
                      {item.title || 'Untitled listing'}
                    </AppText>
                    <ChevronRight size={20} color={appTheme.colors.faint} />
                  </View>
                  <AppText variant="bodySm" color="muted">
                    {item.bundle?.salesCount ?? 0} sales · {formatUsdCents(item.bundle?.earningsUsdCents)} tracked earnings
                  </AppText>
                  <AppText variant="caption" color="faint">
                    {item.bundle?.status ?? 'draft'} · {item.visibility}
                  </AppText>
                </Card>
              </Pressable>
            ))}
          </View>

          {hasNextPage ? (
            <SecondaryButton
              label={isFetchingNextPage ? 'Loading more listings...' : 'Load more listings'}
              disabled={isFetchingNextPage}
              onPress={() => void fetchNextPage()}
            />
          ) : null}

          {listings.length === 0 ? (
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

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Card>
        <View style={{ gap: 10 }}>
          <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.07)', alignItems: 'center', justifyContent: 'center' }}>
            {icon}
          </View>
          <AppText variant="caption" color="faint">{label}</AppText>
          <AppText variant="sectionTitle" style={{ fontVariant: ['tabular-nums'] }}>{value}</AppText>
        </View>
      </Card>
    </View>
  );
}
