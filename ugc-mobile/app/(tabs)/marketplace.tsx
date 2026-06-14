import { useQuery } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText, Card, Pill, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { appTheme, type ToolAccent } from '@/lib/theme';
import type { MarketplaceResource } from '@/lib/types';

function marketplaceAccent(accessMode?: MarketplaceResource['accessMode']): ToolAccent {
  return accessMode === 'free' ? 'workflow' : 'commerce';
}

function marketplacePriceLabel(item: MarketplaceResource) {
  return item.accessMode === 'free' ? 'Free unlock' : item.priceQuote?.formatted ?? 'Paid unlock';
}

function marketplaceKindLabel(item: MarketplaceResource) {
  if (!item.resourceKinds?.length) return 'Creator resources';
  return item.resourceKinds.map((kind) => {
    if (kind === 'prompt') return 'Prompt';
    if (kind === 'workflow') return 'Workflow';
    if (kind === 'files') return 'Files';
    if (kind === 'notes') return 'Notes';
    return 'Remix';
  }).join(' + ');
}

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
            <Pressable style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}>
              <Card accent={marketplaceAccent(item.accessMode)}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
                  <View style={{ flex: 1, gap: 6 }}>
                    <AppText variant="cardTitle" numberOfLines={2}>{item.title}</AppText>
                    <AppText variant="bodySm" color="muted" numberOfLines={2}>
                      {item.summary ?? item.description ?? item.previewText ?? 'Reusable creator resource.'}
                    </AppText>
                  </View>
                  <Pill label={marketplacePriceLabel(item)} accent={marketplaceAccent(item.accessMode)} />
                </View>
                <AppText variant="caption" color="faint">
                  {marketplaceKindLabel(item)}
                  {item.seller?.name || item.creator?.name ? ` · ${item.seller?.name ?? item.creator?.name}` : ''}
                </AppText>
              </Card>
            </Pressable>
          </Link>
        ))}
      </View>
      {!isLoading && (data?.items ?? []).length === 0 ? <StatusBlock title="No unlocks loaded" body="Try again after the marketplace API is available." /> : null}
    </Screen>
  );
}
