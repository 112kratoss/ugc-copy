import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react-native';
import { useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';

import { StableMediaImage } from '@/components/media-preview';
import { SkeletonBone } from '@/components/skeleton';
import { AppText, SecondaryButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { ONE_TIME_POST_READ } from '@/lib/one-time-post-read';
import { remixingNotice } from '@/lib/remix-credit/remix-credit';
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

/**
 * The source's own result offered as a reference (`lib/remix-original-reference.ts`), as the web's
 * creators offer it: whether the draft holds it already, and whether it is being added.
 */
export type RemixOriginalAction = {
  using: boolean;
  busy: boolean;
  onUse: () => void;
};

const ROW_STYLE = { flexDirection: 'row', alignItems: 'center', gap: 10 } as const;
const POSTER_SIZE = 40;
const POSTER_RADIUS = appTheme.radii.sm;

/**
 * A post id as a link carries one. Any app or page can open the app's link, and
 * the id goes into the read's path, where '..' would still climb a level.
 */
const POST_ID = /^[\w-]+$/;

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
export function RemixSourceRow({ source, original }: { source: RemixSourceSeed; original?: RemixOriginalAction | null }) {
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
    ...ONE_TIME_POST_READ,
  });
  // The viewer's own profile as the cache holds it, never fetched from here: it says whose post is theirs.
  const viewerProfile = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: () => api.getProfile(),
    enabled: false,
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
            <SkeletonBone width="62%" height={13} radius={appTheme.radii.pill} strong />
          </View>
          <View style={{ height: appTheme.type.caption.lineHeight * fontScale, justifyContent: 'center' }}>
            <SkeletonBone width="34%" height={10} radius={appTheme.radii.pill} />
          </View>
        </View>
      </View>
    );
  }

  const row = brought ? source : read.data?.item ? showcasePostRemixSourceContext(read.data.item) : null;
  const title = row?.title?.trim();
  const creatorLabel = row?.creatorLabel?.trim();
  const thumbnailUrl = row?.thumbnailUrl?.trim();
  // Whose post it is and that they hear of the remix (owner, 2026-11-05), by their handle: never
  // for the viewer's own post, which tells no one. Their own handle is the profile Home keeps
  // warm; nothing is read for it here.
  const handle = creatorLabel?.startsWith('@') ? creatorLabel.slice(1) : null;
  const ownHandle = viewerProfile.data?.username?.trim().toLowerCase();
  const naming = handle && ownHandle !== handle.toLowerCase() ? remixingNotice({ username: handle, title }) : null;
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
        <Text numberOfLines={naming ? 2 : 1} style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '700' }}>
          {naming?.label ?? (title || 'Source creation')}
        </Text>
        <Text numberOfLines={naming ? 2 : 1} style={{ color: theme.colors.muted, ...appTheme.type.caption }}>
          {naming?.line ?? (creatorLabel ? `By ${creatorLabel}` : 'Make your own version')}
        </Text>
      </View>
      {original ? <OriginalAsReference action={original} /> : null}
    </View>
  );
}

/**
 * The row's button: it adds the source's result to the draft, then says the draft is using it.
 * That second state is a plain label, not a button turned off: the reference's own tile removes it.
 */
function OriginalAsReference({ action }: { action: RemixOriginalAction }) {
  const theme = useAppTheme();
  if (action.using) {
    return (
      <View accessible accessibilityLabel="Using the original as a reference" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Check size={appTheme.icon.sm} color={theme.colors.primary} />
        <AppText selectable={false} variant="label" color="muted">Using original</AppText>
      </View>
    );
  }
  return (
    <SecondaryButton
      label="Use as reference"
      accessibilityHint="Adds the original's result to your references"
      disabled={action.busy}
      onPress={action.onUse}
    />
  );
}
