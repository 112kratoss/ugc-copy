import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { PackageOpen } from 'lucide-react-native';
import { Platform, Pressable, View } from 'react-native';

import { MatureCover } from '@/components/mature-cover';
import { CardListSkeleton } from '@/components/skeleton';
import { AppText, Card, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import type { MatureReveal } from '@/lib/nsfw-reveal-policy';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { ViewerUnlockItem } from '@/lib/types';
import {
  formatUnlockDate,
  formatUnlockPaid,
  getUnlockDestination,
  getUnlockStateBadge,
  getUnlockThumbnailUrl,
  summarizeUnlockCount,
} from '@/lib/unlock-library-view-model';
import { useMatureReveal } from '@/lib/use-mature-reveal';
import { useMediaSource } from '@/lib/use-media-source';

export default function UnlocksScreen() {
  const { user, api } = useAuth();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
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
        {/* Back to this list afterwards; a bare /auth ended on Home. */}
        <PrimaryButton
          label="Sign in"
          onPress={() => router.push({ pathname: '/auth', params: { returnTo: '/unlocks' } } as never)}
          accent="primary"
        />
      </Screen>
    );
  }

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.pageInfo?.total ?? items.length;
  // A later page that fails is not a library that failed: what loaded stays,
  // and the failure is told by the button that asked for the page.
  const firstLoadError = data ? null : error;
  const nextPageFailed = isFetchNextPageError && !isFetchingNextPage;

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

      {firstLoadError ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock
            tone="danger"
            title="Could not load your unlocks"
            body={firstLoadError instanceof Error ? firstLoadError.message : 'Your unlocks are safe. Check your connection, then retry.'}
          />
          <SecondaryButton label="Retry unlocks" onPress={() => void refetch()} />
        </View>
      ) : null}

      {!isLoading && !firstLoadError && items.length === 0 ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock
            title="No unlocks yet"
            body="When you unlock a creator's prompt, workflow, or reference files, it lands here and stays here."
          />
          {/* A way on from an empty library, as the web has. Home reads no chip
              from a link, so this lands on its feed, not its Unlocks chip. */}
          <PrimaryButton label="Browse unlocks" accent="primary" onPress={() => router.dismissTo('/(tabs)' as never)} />
        </View>
      ) : null}

      {items.length > 0 ? (
        <AppText color="muted" style={{ marginBottom: 12 }}>
          {summarizeUnlockCount(total)}
        </AppText>
      ) : null}

      {items.map((item) => <UnlockRow key={item.unlockId} item={item} />)}

      {hasNextPage ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          {nextPageFailed ? (
            <StatusBlock
              tone="danger"
              title="Could not load more unlocks"
              body={error instanceof Error ? error.message : 'Check your connection, then retry.'}
            />
          ) : null}
          <SecondaryButton
            label={isFetchingNextPage ? 'Loading…' : nextPageFailed ? 'Retry' : 'Load more'}
            onPress={() => fetchNextPage()}
          />
        </View>
      ) : null}
    </Screen>
  );
}

function UnlockRow({ item }: { item: ViewerUnlockItem }) {
  const [matureShown, setMatureShown] = useState(false);
  const badge = getUnlockStateBadge(item);
  const thumbnailUrl = getUnlockThumbnailUrl(item);
  const paid = formatUnlockPaid(item, Platform.OS);
  // Only a picture there is to draw needs covering; a row without one keeps its icon.
  const matureStill = item.isNsfw && Boolean(thumbnailUrl);
  const reveal = useMatureReveal(matureStill);
  // Shown only while the website preference allows it, so turning it off
  // there covers the still again when the app comes back.
  const matureCovered = matureStill && !(matureShown && reveal === 'show');
  const canShowMature = matureCovered && reveal === 'show';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, by ${item.creator.displayName}.${item.isNsfw ? ' Mature content.' : ''} ${paid}.`}
      // The plate's Show sits inside this row's button, where a screen reader
      // cannot reach it on its own. Once shown the list is empty, not
      // undefined: Android keeps the actions a view had when the prop goes
      // back to undefined, and would go on offering a Show that does nothing.
      accessibilityActions={canShowMature ? [{ name: 'showMature', label: 'Show mature content' }] : []}
      onAccessibilityAction={canShowMature ? (event) => {
        if (event.nativeEvent.actionName === 'showMature') setMatureShown(true);
      } : undefined}
      onPress={() => {
        router.push(getUnlockDestination(item) as never);
      }}
      style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Card style={{ marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <UnlockThumbnail
            url={thumbnailUrl}
            thumbhash={item.post?.previewThumbhash ?? null}
            covered={matureCovered}
            reveal={reveal}
            onShow={() => setMatureShown(true)}
          />

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

            {item.isNsfw ? (
              <AppText variant="caption" color="muted">
                Mature content
              </AppText>
            ) : null}

            <AppText variant="caption" color="muted">
              {paid} · {formatUnlockDate(item.purchasedAt)}
            </AppText>
          </View>
        </View>
      </Card>
    </Pressable>
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
function UnlockThumbnail({
  url,
  thumbhash,
  covered,
  reveal,
  onShow,
}: {
  url: string | null;
  thumbhash: string | null;
  /** A mature post's still, behind its plate until the buyer asks for it. */
  covered: boolean;
  reveal: MatureReveal;
  onShow: () => void;
}) {
  const theme = useAppTheme();
  // Absolute, and with the session's bearer: an uploaded post's preview is a
  // relative, private `/api/media` link, which a bare `{ uri }` never loaded.
  const { source, requestKey } = useMediaSource(url ?? '');
  // A sign-in or a renewed session tries a failed image again.
  const sourceKey = `${url}|${requestKey}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const showImage = Boolean(url) && !covered && failedKey !== sourceKey;

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
        backgroundColor: theme.colors.panelSoft,
      }}
    >
      {/* The icon is the base layer rather than an either/or branch: an image
          that is still loading — or one that quietly resolves to nothing
          without ever firing onError — would otherwise leave a blank tile. */}
      <PackageOpen size={20} color={theme.colors.muted} />
      {covered ? <MatureCover variant="tile" reveal={reveal} onShow={onShow} /> : null}
      {showImage ? (
        <Image
          accessibilityIgnoresInvertColors
          source={source}
          placeholder={thumbhash ? { thumbhash } : undefined}
          placeholderContentFit="cover"
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={url}
          onError={() => setFailedKey(sourceKey)}
          style={{ position: 'absolute', inset: 0 }}
        />
      ) : null}
    </View>
  );
}
