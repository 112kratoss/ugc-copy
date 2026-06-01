import { useQuery } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Card, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { appTheme } from '@/lib/theme';

export default function MarketplaceScreen() {
  const { api } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['marketplace-resources'],
    queryFn: () => api.listMarketplaceResources({ limit: 16, sort: 'recent' }),
  });

  return (
    <Screen insideTab>
      <SectionTitle
        eyebrow="Unlocks"
        title="Prompts, files, notes, and remix access."
        body="Free unlocks can open directly. Paid unlocks use native app-store purchases in the mobile app."
      />
      {error ? <StatusBlock tone="danger" title="Could not load unlocks" body={error instanceof Error ? error.message : 'Try again.'} /> : null}
      <SecondaryButton label={isLoading ? 'Refreshing...' : 'Refresh unlocks'} onPress={() => void refetch()} disabled={isLoading} />

      <View style={{ gap: 14 }}>
        {(data?.items ?? []).map((item) => (
          <Link
            key={item.id}
            href={{
              pathname: '/marketplace/[assetId]',
              params: {
                assetId: item.id,
                ...(item.postId ? { postId: item.postId } : {}),
              },
            }}
            asChild
          >
            <Pressable>
              <Card accent={item.accessMode === 'free' ? 'workflow' : 'amber'}>
                <Text style={{ color: appTheme.colors.text, fontSize: 19, fontWeight: '800' }}>{item.title}</Text>
                <Text style={{ color: appTheme.colors.muted, lineHeight: 21 }}>{item.summary ?? item.description ?? item.previewText ?? 'Reusable creator resource.'}</Text>
                <Text style={{ color: appTheme.colors.success, fontWeight: '800' }}>
                  {item.accessMode === 'free' ? 'Free unlock' : item.priceQuote?.formatted ?? 'Paid unlock'}
                </Text>
              </Card>
            </Pressable>
          </Link>
        ))}
      </View>
      {!isLoading && (data?.items ?? []).length === 0 ? <StatusBlock title="No unlocks loaded" body="Try again after the marketplace API is available." /> : null}
    </Screen>
  );
}
