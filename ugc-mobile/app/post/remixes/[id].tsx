import { useInfiniteQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { ImageOff } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { CardListSkeleton } from '@/components/skeleton';
import { AppText, Card, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  POST_REMIXES_EMPTY,
  POST_REMIXES_EMPTY_TITLE,
  POST_REMIXES_PAGE_SIZE,
  POST_REMIXES_SUBTITLE,
  POST_REMIXES_TITLE,
  POST_REMIXES_UNPOSTED_NOTE,
  hasUnpostedRemixes,
  nextPostRemixesOffset,
  postRemixRowLabel,
  postRemixThumbnailUrl,
  postRemixesFromPages,
  postRemixesQueryKey,
} from '@/lib/post-remixes-view-model';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { ShowcaseFeedItem } from '@/lib/types';

/**
 * A post's remixes, which its remix count opens (owner, 2026-11-05): the ones
 * posted where anyone may see them, newest first, without anyone the viewer is
 * blocked with (`GET /api/showcase/posts/:id/remixes`). `remixCount`, when the
 * link brings it, says whether some were never posted.
 */
export default function PostRemixesScreen() {
  const { id, remixCount: rawRemixCount } = useLocalSearchParams<{ id: string; remixCount?: string }>();
  const postId = Array.isArray(id) ? id[0] : id;
  const remixCount = Number(Array.isArray(rawRemixCount) ? rawRemixCount[0] : rawRemixCount) || 0;
  const { api, user } = useAuth();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetching,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useInfiniteQuery({
    queryKey: postRemixesQueryKey(postId ?? '', user?.id),
    enabled: Boolean(postId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listPostRemixes(postId!, { offset: pageParam, limit: POST_REMIXES_PAGE_SIZE }),
    getNextPageParam: nextPostRemixesOffset,
  });

  const items = postRemixesFromPages(data?.pages);
  // A later page that fails is not a list that failed: what loaded stays.
  const firstLoadError = data ? null : error;
  const nextPageFailed = isFetchNextPageError && !isFetchingNextPage;

  return (
    <Screen>
      <SectionTitle title={POST_REMIXES_TITLE} body={POST_REMIXES_SUBTITLE} />

      {isLoading ? <CardListSkeleton label="Loading remixes" /> : null}

      {firstLoadError ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock
            tone="danger"
            title="Could not load remixes"
            body={firstLoadError instanceof Error ? firstLoadError.message : 'Check your connection, then try again.'}
          />
          {/* Each tap mid-read would cancel the read and send it again, against the route's limit. */}
          <SecondaryButton label="Try again" loading={isFetching} loadingLabel="Loading…" disabled={isFetching} onPress={() => void refetch()} />
        </View>
      ) : null}

      {!isLoading && !firstLoadError && items.length === 0 ? (
        <StatusBlock title={POST_REMIXES_EMPTY_TITLE} body={POST_REMIXES_EMPTY} />
      ) : null}

      {items.map((item) => <PostRemixRow key={item.id} item={item} />)}

      {data && hasUnpostedRemixes(items.length, remixCount, Boolean(hasNextPage)) && items.length > 0 ? (
        <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>
          {POST_REMIXES_UNPOSTED_NOTE}
        </AppText>
      ) : null}

      {hasNextPage ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          {nextPageFailed ? (
            <StatusBlock
              tone="danger"
              title="Could not load more remixes"
              body={error instanceof Error ? error.message : 'Check your connection, then try again.'}
            />
          ) : null}
          <SecondaryButton
            label={isFetchingNextPage ? 'Loading…' : nextPageFailed ? 'Retry' : 'Load more'}
            disabled={isFetchingNextPage}
            onPress={() => void fetchNextPage()}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const THUMBNAIL_SIZE = 56;

function PostRemixRow({ item }: { item: ShowcaseFeedItem }) {
  const theme = useAppTheme();
  const thumbnailUrl = postRemixThumbnailUrl(item);
  const creator = item.creator.username ? `@${item.creator.username}` : item.creator.name;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={postRemixRowLabel(item)}
      accessibilityHint="Opens the remix"
      onPress={() => router.push(`/post/${encodeURIComponent(item.id)}` as never)}
      style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <View
          style={{
            width: THUMBNAIL_SIZE,
            height: THUMBNAIL_SIZE,
            borderRadius: appTheme.radii.sm,
            borderCurve: 'continuous',
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.panelSoft,
          }}
        >
          <ImageOff size={appTheme.icon.sm} color={theme.colors.faint} />
          {thumbnailUrl ? (
            <Image
              source={{ uri: thumbnailUrl }}
              contentFit="cover"
              style={{ position: 'absolute', width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }}
            />
          ) : null}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="cardTitle" numberOfLines={1}>{item.title}</AppText>
          <AppText variant="bodySm" color="muted" numberOfLines={1}>{creator}</AppText>
        </View>
      </Card>
    </Pressable>
  );
}
