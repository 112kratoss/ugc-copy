import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';

import { StableMediaImage } from '@/components/media-preview';
import { SkeletonBone } from '@/components/skeleton';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { showcasePostRemixSourceContext } from '@/lib/remix-start';
import { createShowcasePostQueryKey } from '@/lib/showcase-feed-query';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** What a remix's creator is told of its source: its ids, and the row when the link brought it. */
export type RemixSourceSeed = {
  generationId?: string | null;
  postId?: string | null;
  title?: string | null;
  creatorLabel?: string | null;
  thumbnailUrl?: string | null;
};

const ROW_STYLE = { flexDirection: 'row', alignItems: 'center', gap: 10 } as const;
const POSTER_SIZE = 40;
const POSTER_RADIUS = 10;

/**
 * A post id as a link carries one. Any app or page can open the app's link, and
 * the id goes into the read's path, where '..' would still climb a level.
 */
const POST_ID = /^[\w-]+$/;

/** A refusal (gone, blocked, rate-limited) answers the same again; a dropped connection may not. */
function retryUnlessRefused(failureCount: number, error: unknown) {
  return failureCount < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/**
 * The row above a remix's prompt: the source's poster, title and creator.
 *
 * Every link the app builds brings the row (`getNativeRemixCreateHref`), drawn
 * from the first frame with nothing read. A link that names the post alone (a
 * guest's Make this back from sign-in, which carries ids only, a notification,
 * a deep link) reads the post once, under the post page's query, and names it
 * as Home and the reel do. Bones hold the row's place while it is read; a post
 * that cannot be read leaves the plain row, and is not asked for again when the
 * app comes back to the foreground.
 */
export function RemixSourceRow({ source }: { source: RemixSourceSeed }) {
  const theme = useAppTheme();
  const { fontScale } = useWindowDimensions();
  const { api, user } = useAuth();
  // The poster the image gave up on (its retries are StableMediaImage's): its failure plate takes a
  // whole preview's frame, so the row goes on without a picture instead.
  const [failedPoster, setFailedPoster] = useState<string | null>(null);
  const postId = source.postId?.trim() || undefined;
  const brought = Boolean(source.title?.trim() && source.creatorLabel?.trim());
  const reads = Boolean(postId && POST_ID.test(postId)) && !brought;
  const read = useQuery({
    queryKey: createShowcasePostQueryKey(postId, user?.id),
    queryFn: () => api.getShowcasePost(postId!),
    enabled: reads,
    staleTime: Infinity,
    retry: retryUnlessRefused,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });

  // Only this row's own first read: a disabled query still reports the entry another screen is
  // reading, and one that failed and is read again leaves the plain row in place.
  if (reads && read.isLoading && read.errorUpdateCount === 0) {
    return (
      <View accessibilityLabel="Remix source post" style={ROW_STYLE}>
        <SkeletonBone width={POSTER_SIZE} height={POSTER_SIZE} radius={POSTER_RADIUS} strong />
        <View style={{ flex: 1, gap: 2 }}>
          {/* The lines' own heights at the phone's text size, which the row's text scales by. */}
          <View style={{ height: appTheme.type.bodySm.lineHeight * fontScale, justifyContent: 'center' }}>
            <SkeletonBone width="62%" height={13} radius={6} strong />
          </View>
          <View style={{ height: appTheme.type.caption.lineHeight * fontScale, justifyContent: 'center' }}>
            <SkeletonBone width="34%" height={10} radius={5} />
          </View>
        </View>
      </View>
    );
  }

  const row = brought ? source : read.data?.item ? showcasePostRemixSourceContext(read.data.item) : null;
  const title = row?.title?.trim();
  const creatorLabel = row?.creatorLabel?.trim();
  const thumbnailUrl = row?.thumbnailUrl?.trim();
  return (
    <View accessibilityLabel="Remix source post" style={ROW_STYLE}>
      {thumbnailUrl && thumbnailUrl !== failedPoster ? (
        <StableMediaImage
          url={thumbnailUrl}
          cacheKey={`remix-source:${thumbnailUrl}`}
          onError={() => setFailedPoster(thumbnailUrl)}
          style={{ width: POSTER_SIZE, height: POSTER_SIZE, borderRadius: POSTER_RADIUS }}
        />
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '700' }}>{title || 'Source creation'}</Text>
        <Text numberOfLines={1} style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{creatorLabel ? `By ${creatorLabel}` : 'Make your own version'}</Text>
      </View>
    </View>
  );
}
