import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { BarChart3, DollarSign, PackageCheck } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Card, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { formatUsdCents, getOwnerPostSalesSummary } from '@/lib/home-view-model';
import { appTheme } from '@/lib/theme';

export default function SellerDashboardScreen() {
  const { user, api } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['seller-dashboard-posts', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.listOwnerPosts({ includeArchived: true, visibility: 'all' }),
  });

  if (!user) {
    return (
      <Screen>
        <SectionTitle eyebrow="Seller Dashboard" title="Sign in to view sales." body="Your paid unlock earnings and seller listings appear here once you sign in." />
        <PrimaryButton label="Sign in" onPress={() => router.push('/auth')} accent="image" />
      </Screen>
    );
  }

  const posts = data?.posts ?? [];
  const summary = getOwnerPostSalesSummary(posts);
  const listings = posts.filter((post) => post.bundle);

  return (
    <Screen>
      <SectionTitle
        eyebrow="Seller Dashboard"
        title="Sales and unlocks."
        body="Track total sales from your reusable resources. Earnings are shown as lifetime tracked sales."
      />

      {error ? <StatusBlock tone="danger" title="Could not load seller dashboard" body={error instanceof Error ? error.message : 'Try again.'} /> : null}

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <MetricCard icon={<DollarSign size={22} color="#22d3ee" />} label="Total sales" value={formatUsdCents(summary.earningsUsdCents)} />
        <MetricCard icon={<BarChart3 size={22} color="#d946ef" />} label="Unlocks sold" value={String(summary.salesCount)} />
      </View>

      <SecondaryButton label={isLoading ? 'Refreshing...' : 'Refresh dashboard'} onPress={() => void refetch()} disabled={isLoading} />

      <View style={{ gap: 14 }}>
        {listings.map((item) => (
          <Card key={item.id} accent={item.bundle?.accessMode === 'free' ? 'workflow' : 'amber'}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <PackageCheck size={22} color={item.bundle?.accessMode === 'free' ? appTheme.colors.success : '#fbbf24'} />
              <Text numberOfLines={1} style={{ flex: 1, color: appTheme.colors.text, fontSize: 18, fontWeight: '900' }}>
                {item.title || 'Untitled listing'}
              </Text>
            </View>
            <Text style={{ color: appTheme.colors.muted, lineHeight: 21 }}>
              {item.bundle?.salesCount ?? 0} sales · {formatUsdCents(item.bundle?.earningsUsdCents)} tracked earnings
            </Text>
            <Text style={{ color: appTheme.colors.faint, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' }}>
              {item.bundle?.status ?? 'draft'} · {item.visibility}
            </Text>
          </Card>
        ))}
      </View>

      {!isLoading && listings.length === 0 ? (
        <StatusBlock title="No seller listings yet" body="Publish a post with reusable resources and paid access to start tracking sales here." />
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
          <Text style={{ color: appTheme.colors.faint, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>{label}</Text>
          <Text style={{ color: appTheme.colors.text, fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'] }}>{value}</Text>
        </View>
      </Card>
    </View>
  );
}
