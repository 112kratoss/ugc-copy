import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { PackageOpen } from 'lucide-react-native';
import { Image, Pressable, View } from 'react-native';

import { AppText, Card, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { appTheme } from '@/lib/theme';
import {
  formatUnlockDate,
  formatUnlockPrice,
  getUnlockDestination,
  getUnlockStateBadge,
  summarizeUnlockCount,
} from '@/lib/unlock-library-view-model';

export default function UnlocksScreen() {
  const { user, api } = useAuth();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery({
    queryKey: ['viewer-unlocks', user?.id],
    enabled: Boolean(user),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listViewerUnlocks({ limit: 24, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.pageInfo?.nextOffset ?? undefined,
  });

  if (!user) {
    return (
      <Screen>
        <SectionTitle
          eyebrow="Your unlocks"
          title="Sign in to see your unlocks."
          body="Prompts, workflows, and files you unlock from other creators live here."
        />
        <PrimaryButton label="Sign in" onPress={() => router.push('/auth')} accent="primary" />
      </Screen>
    );
  }

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.pageInfo?.total ?? items.length;

  return (
    <Screen>
      <SectionTitle
        eyebrow="Your unlocks"
        title="Everything you have unlocked."
        body="These stay yours even if the creator later changes or removes the post."
      />

      {!router.canGoBack() ? (
        <SecondaryButton label="Back to profile" onPress={() => router.replace('/(tabs)/profile' as never)} />
      ) : null}

      {isLoading ? <StatusBlock title="Loading unlocks" body="Fetching everything you have unlocked." /> : null}

      {error ? (
        <StatusBlock
          title="Could not load your unlocks"
          body={error instanceof Error ? error.message : 'Please try again in a moment.'}
        />
      ) : null}

      {!isLoading && !error && items.length === 0 ? (
        <StatusBlock
          title="No unlocks yet"
          body="When you unlock a creator's prompt, workflow, or reference files, it lands here and stays here."
        />
      ) : null}

      {items.length > 0 ? (
        <AppText style={{ color: appTheme.colors.muted, marginBottom: 12 }}>
          {summarizeUnlockCount(total)}
        </AppText>
      ) : null}

      {items.map((item) => {
        const badge = getUnlockStateBadge(item);
        const destination = getUnlockDestination(item);

        return (
          <Pressable
            key={item.unlockId}
            onPress={() => {
              router.push(destination as never);
            }}
          >
            <Card style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
                {item.post?.mediaUrl ? (
                  <Image
                    source={{ uri: item.post.mediaUrl }}
                    style={{ width: 56, height: 56, borderRadius: 14 }}
                  />
                ) : (
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 14,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: appTheme.colors.panelSoft,
                    }}
                  >
                    <PackageOpen size={20} color={appTheme.colors.muted} />
                  </View>
                )}

                <View style={{ flex: 1, gap: 4 }}>
                  <AppText color="text">{item.title}</AppText>
                  <AppText style={{ color: appTheme.colors.muted, fontSize: 12 }}>
                    by {item.creator.displayName}
                  </AppText>

                  {badge ? (
                    <AppText
                      style={{
                        fontSize: 11,
                        color: badge.tone === 'updated'
                          ? appTheme.colors.commerce
                          : appTheme.colors.muted,
                      }}
                    >
                      {badge.label}
                    </AppText>
                  ) : null}

                  <AppText style={{ color: appTheme.colors.muted, fontSize: 11 }}>
                    {formatUnlockPrice(item.purchasePriceUsdCents)} · {formatUnlockDate(item.purchasedAt)}
                  </AppText>
                </View>
              </View>
            </Card>
          </Pressable>
        );
      })}

      {hasNextPage ? (
        <SecondaryButton
          label={isFetchingNextPage ? 'Loading...' : 'Load more'}
          onPress={() => fetchNextPage()}
        />
      ) : null}
    </Screen>
  );
}
