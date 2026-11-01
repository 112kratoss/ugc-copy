import { useQuery } from '@tanstack/react-query';
import { Text, View } from 'react-native';

import { StableMediaImage } from '@/components/media-preview';
import { SkeletonBone } from '@/components/skeleton';
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
 * The row above a remix's prompt: the source's poster, title and creator.
 *
 * Every link the app builds brings the row (`getNativeRemixCreateHref`), drawn
 * from the first frame with nothing read. A link that names the post alone (a
 * guest's Make this back from sign-in, which carries ids only, a notification,
 * a deep link) reads the post once, under the post page's query, and names it
 * as Home and the reel do. Bones hold the row's place while it is read; a post
 * that cannot be read leaves the plain row.
 */
export function RemixSourceRow({ source }: { source: RemixSourceSeed }) {
  const theme = useAppTheme();
  const { api, user } = useAuth();
  const postId = source.postId?.trim() || null;
  const brought = Boolean(source.title?.trim() && source.creatorLabel?.trim());
  const read = useQuery({
    queryKey: createShowcasePostQueryKey(postId ?? undefined, user?.id),
    queryFn: () => api.getShowcasePost(postId!),
    enabled: Boolean(postId) && !brought,
    staleTime: Infinity,
  });

  if (read.isLoading) {
    return (
      <View accessibilityLabel="Remix source post" style={ROW_STYLE}>
        <SkeletonBone width={POSTER_SIZE} height={POSTER_SIZE} radius={POSTER_RADIUS} strong />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ height: appTheme.type.bodySm.lineHeight, justifyContent: 'center' }}>
            <SkeletonBone width="62%" height={13} radius={6} strong />
          </View>
          <View style={{ height: appTheme.type.caption.lineHeight, justifyContent: 'center' }}>
            <SkeletonBone width="34%" height={10} radius={5} />
          </View>
        </View>
      </View>
    );
  }

  const post = read.data?.item ? showcasePostRemixSourceContext(read.data.item) : null;
  const title = source.title?.trim() || post?.title;
  const creatorLabel = source.creatorLabel?.trim() || post?.creatorLabel;
  const thumbnailUrl = source.thumbnailUrl?.trim() || post?.thumbnailUrl;
  return (
    <View accessibilityLabel="Remix source post" style={ROW_STYLE}>
      {thumbnailUrl ? (
        <StableMediaImage
          url={thumbnailUrl}
          cacheKey={`remix-source:${source.postId ?? source.generationId}`}
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
