import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { router } from 'expo-router';
import { PackageOpen } from 'lucide-react-native';
import { Image, Pressable, View } from 'react-native';

import { CardListSkeleton } from '@/components/skeleton';
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
    refetch,
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

      {isLoading ? <CardListSkeleton label="Loading unlocks" /> : null}

      {error ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock
            tone="danger"
            title="Could not load your unlocks"
            body={error instanceof Error ? error.message : 'Your unlocks are safe. Check your connection, then retry.'}
          />
          <SecondaryButton label="Retry unlocks" onPress={() => void refetch()} />
        </View>
      ) : null}

      {!isLoading && !error && items.length === 0 ? (
        <StatusBlock
          title="No unlocks yet"
          body="When you unlock a creator's prompt, workflow, or reference files, it lands here and stays here."
        />
      ) : null}

      {items.length > 0 ? (
        <AppText color="muted" style={{ marginBottom: 12 }}>
          {summarizeUnlockCount(total)}
        </AppText>
      ) : null}

      {items.map((item) => {
        const badge = getUnlockStateBadge(item);
        const destination = getUnlockDestination(item);

        return (
          <Pressable
            key={item.unlockId}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, by ${item.creator.displayName}. ${formatUnlockPrice(item.purchasePriceUsdCents)}.`}
            onPress={() => {
              router.push(destination as never);
            }}
            style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Card style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
                <UnlockThumbnail uri={item.post?.mediaUrl ?? null} />

                <View style={{ flex: 1, gap: 4 }}>
                  <AppText color="text">{item.title}</AppText>
                  <AppText variant="caption" color="muted">
                    by {item.creator.displayName}
                  </AppText>

                  {badge ? (
                    <AppText
                      variant="caption"
                      color={badge.tone === 'updated' ? 'commerce' : 'muted'}
                    >
                      {badge.label}
                    </AppText>
                  ) : null}

                  <AppText variant="caption" color="muted">
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
const THUMBNAIL_SIZE = 56;

/**
 * Unlock thumbnail that always occupies its slot.
 *
 * A plain `Image` whose source fails renders nothing at all, and the row still
 * reserves the space — so a broken link left a transparent hole beside the
 * title that read as a layout bug. Falling back to the same placeholder used
 * when there is no media keeps the row looking deliberate either way, and the
 * placeholder colour sits behind the image so a slow load is never a hole.
 */
function UnlockThumbnail({ uri }: { uri: string | null }) {
  const [failed, setFailed] = useState(false);
  const showPlaceholder = !uri || failed;

  return (
    <View
      style={{
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
        borderRadius: 14,
        borderCurve: 'continuous',
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: appTheme.colors.panelSoft,
      }}
    >
      {/* The icon is the base layer rather than an either/or branch: an image
          that is still loading — or one that quietly resolves to nothing
          without ever firing onError — would otherwise leave a blank tile. */}
      <PackageOpen size={20} color={appTheme.colors.muted} />
      {showPlaceholder ? null : (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri }}
          onError={() => setFailed(true)}
          style={{ position: 'absolute', inset: 0 }}
        />
      )}
    </View>
  );
}
