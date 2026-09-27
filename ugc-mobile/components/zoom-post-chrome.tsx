import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { Volume2, VolumeX } from 'lucide-react-native';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { setZoomPostPreparer } from '@/components/media-zoom';
import { IconShadow, ReelSlideChrome } from '@/components/reel-chrome';
import { TopScrim } from '@/components/top-scrim';
import { useAuth } from '@/lib/auth';
import { hasImmersiveAudibleMedia, type ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { BackGlyph } from '@/lib/platform-glyphs';
import { drawsPreparedFollowPill, getReelFollowTarget } from '@/lib/reel-overlay-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import { creatorFollowStateQueryKey, prefetchCreatorFollowState } from '@/lib/use-creator-follow';
import { useViewerAudioMuted } from '@/lib/viewer-audio';
import { viewerTopControlTop, VIEWER_TOP_CONTROL_SIZE } from '@/lib/viewer-chrome';

const ignore = () => {};

/**
 * Asks, as a finger lands on a post's tile, whom the signed-in reader follows,
 * so the Follow pill can be drawn with the post from the window's first frames
 * and the reel's: asked only once the reel was up, the answer took a round trip
 * after it and the pill appeared a second or more into the post.
 */
export function ZoomPostPreparer() {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const viewerId = user?.id ?? null;
  useEffect(() => {
    if (!viewerId) return undefined;
    return setZoomPostPreparer((post) => {
      const target = getReelFollowTarget(post, viewerId);
      if (target) void prefetchCreatorFollowState(queryClient, api, target.creatorId);
    });
  }, [api, queryClient, viewerId]);
  return null;
}

/**
 * A post as the reel draws it, for the window the post grows in out of its tile
 * (`MediaZoomFlightLayer`): the slide's rail and caption, the reel's top shade,
 * and its Back and mute controls — the reel's own components, placed by the same
 * geometry, so that when the reel is uncovered underneath nothing on screen
 * moves. The window takes no touches, so nothing here answers one.
 */
export function ZoomPostChrome({ post }: { post: ImmersivePreviewItem }) {
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const { user } = useAuth();
  const audioMuted = useViewerAudioMuted();

  // The reel draws no pill until it knows whom the reader follows
  // (`ImmersiveSlide`), and neither does this window: only an answer in the
  // cache is drawn, so the pill never appears here to vanish at the hand-off.
  // It is asked for as the finger lands on the tile (`ZoomPostPreparer`), and
  // drawn here the moment it arrives, while the window is still growing,
  // rather than once the reel under it has asked again.
  const followTarget = getReelFollowTarget(post, user?.id ?? null);
  const followState = useQuery<{ following: boolean }>({
    queryKey: creatorFollowStateQueryKey(followTarget?.creatorId ?? null),
    queryFn: skipToken,
  }).data;
  const follow = drawsPreparedFollowPill({ followTarget, signedIn: Boolean(user), followKnown: followState !== undefined })
    ? { following: Boolean(user) && Boolean(followState?.following), pending: false, onPress: ignore }
    : null;

  return (
    <>
      <ReelSlideChrome
        item={post}
        topInset={topInset}
        bottomInset={bottomInset}
        pageIndex={0}
        follow={follow}
        captionExpanded={false}
        onToggleCaption={ignore}
        saveLoading={false}
        remixLoading={false}
        ownerActionPending={null}
        onSave={ignore}
        onComments={post.canComment ? ignore : undefined}
        onShare={ignore}
        onOpenDetails={ignore}
        onUnlockRemix={ignore}
        onRecreate={ignore}
        onOwnerAction={ignore}
        onActionsOpen={ignore}
        onCreatorOpen={ignore}
      />
      <TopScrim topInset={topInset} over="media" />
      <View style={[topControlStyle(topInset), { left: 16 }]}>
        <IconShadow><BackGlyph size={appTheme.icon.feature} color="#ffffff" /></IconShadow>
      </View>
      {hasImmersiveAudibleMedia(post) ? (
        <View style={[topControlStyle(topInset), { right: 16 }]}>
          <IconShadow>
            {audioMuted
              ? <VolumeX size={appTheme.icon.feature} color="#ffffff" />
              : <Volume2 size={appTheme.icon.feature} color="#ffffff" />}
          </IconShadow>
        </View>
      ) : null}
    </>
  );
}

/** The reel's round top control, as `app/viewer.tsx` places it. */
function topControlStyle(topInset: number) {
  return {
    position: 'absolute' as const,
    top: viewerTopControlTop(topInset),
    width: VIEWER_TOP_CONTROL_SIZE,
    height: VIEWER_TOP_CONTROL_SIZE,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: VIEWER_TOP_CONTROL_SIZE / 2,
    backgroundColor: 'rgba(0,0,0,0.3)',
  };
}
