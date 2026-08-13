import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { Play } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { FEED_VIDEO_VIEW_PROPS } from '@/components/feed-media-frame';
import { StableMediaImage } from '@/components/media-preview';
import { FEED_PREVIEW_FORWARD_BUFFER_SECONDS } from '@/lib/media-performance';
import { appTheme } from '@/lib/theme';

const absoluteFill = {
  position: 'absolute' as const,
  inset: 0,
};

/**
 * A feed video tile: poster while idle, muted looping preview while active.
 *
 * Both states share ONE tree whose shape does not change with `active`. The
 * poster stays mounted and only crosses opacity; the player layer mounts and
 * unmounts beneath it. This matters because an earlier version returned two
 * different components for the two states, so every activation handoff
 * remounted the poster (replaying its 120ms transition) and tore down the
 * ExoPlayer plus its hardware decoder — the flicker seen while scrolling the
 * showcase, where the single autoplay slot changes hands as the feed moves.
 */
export function FeedVideoPreview({
  url,
  streamUrl = null,
  previewUrl,
  previewCacheKey,
  previewThumbhash,
  active,
  height,
  radius,
  accent,
  videoBackdrop = 'blurred',
  videoContentFit = 'contain',
}: {
  /** Source of record — identity, cache keys, downloads. Never streamed here. */
  url: string;
  /**
   * What this tile may stream when active — the server-decided feed stream
   * (teaser or rendition; see getShowcaseFeedStreamUrl). Deliberately NOT
   * defaulted to `url`: the old `renditionUrl || url` fallback is how a long
   * video whose transcode failed streamed its raw source into the feed. Null
   * renders the poster with a play glyph instead.
   */
  streamUrl?: string | null;
  previewUrl?: string | null;
  previewCacheKey?: string;
  previewThumbhash?: string | null;
  active: boolean;
  height: number;
  radius: number;
  accent: string;
  videoBackdrop?: 'blurred' | 'none';
  videoContentFit?: 'cover' | 'contain';
}) {
  const canPlay = active && Boolean(streamUrl);

  const [failedPosterUrl, setFailedPosterUrl] = useState<string | null>(null);
  // Both latches are keyed to the stream url rather than being booleans, so a
  // recycled instance never inherits the previous item's first frame or error.
  const [firstFrameUrl, setFirstFrameUrl] = useState<string | null>(null);
  const [playbackErrorUrl, setPlaybackErrorUrl] = useState<string | null>(null);
  const [playerMounted, setPlayerMounted] = useState(canPlay);
  const playerRef = useRef<VideoPlayer | null>(null);

  const usablePreviewUrl = previewUrl && previewUrl !== failedPosterUrl ? previewUrl : null;
  const hasFirstFrame = Boolean(streamUrl) && firstFrameUrl === streamUrl;
  const hasPlaybackError = Boolean(streamUrl) && playbackErrorUrl === streamUrl;
  const posterVisible = !canPlay || !hasFirstFrame || hasPlaybackError;
  // Nothing to show but the play badge: keep the borderless dark tile this
  // state has always rendered rather than framing an empty box.
  const posterless = !usablePreviewUrl && !canPlay;

  useEffect(() => {
    setFailedPosterUrl(null);
  }, [previewUrl, url]);

  useEffect(() => {
    if (canPlay) {
      setPlayerMounted(true);
      return;
    }

    // Pause while the layer is still mounted, then drop it on the next commit.
    // `useVideoPlayer` releases its shared object as the layer unmounts, so a
    // pause from an unmount cleanup would touch a dead player; deferring the
    // unmount by one commit keeps this call legal. A whole-tree unmount skips
    // this path entirely, which is why it never pauses.
    try {
      playerRef.current?.pause();
    } catch {
      // Already released by a source swap — nothing left to pause.
    }
    playerRef.current = null;
    setPlayerMounted(false);
    setFirstFrameUrl(null);
    setPlaybackErrorUrl(null);
  }, [canPlay]);

  const handleFirstFrame = useCallback(() => {
    setFirstFrameUrl(streamUrl);
    setPlaybackErrorUrl(null);
  }, [streamUrl]);

  const handlePlaybackError = useCallback((errored: boolean) => {
    setPlaybackErrorUrl(errored ? streamUrl : null);
  }, [streamUrl]);

  return (
    <View
      pointerEvents={playerMounted ? 'none' : undefined}
      style={{
        height,
        overflow: 'hidden',
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: posterless ? 0 : 1,
        borderColor: `${accent}4d`,
        backgroundColor: '#050506',
      }}
    >
      {playerMounted && videoBackdrop === 'blurred' ? (
        <>
          {usablePreviewUrl ? (
            <Image
              source={{ uri: usablePreviewUrl }}
              contentFit="cover"
              blurRadius={24}
              cachePolicy="memory-disk"
              priority="low"
              recyclingKey={`${url}:video-backdrop`}
              pointerEvents="none"
              style={[absoluteFill, { backgroundColor: '#050506' }]}
            />
          ) : null}
          <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.44)' }]} />
        </>
      ) : null}

      {playerMounted && streamUrl ? (
        <FeedVideoPlayerLayer
          url={streamUrl}
          contentFit={videoContentFit}
          playerRef={playerRef}
          onFirstFrame={handleFirstFrame}
          onPlaybackError={handlePlaybackError}
        />
      ) : null}

      {usablePreviewUrl ? (
        <StableMediaImage
          url={usablePreviewUrl}
          // One identity across activation flips. Anything that varies with
          // `active` here would remount the image and replay its transition,
          // which is the flicker this component exists to avoid.
          cacheKey={previewCacheKey ?? `${url}:poster`}
          thumbhash={previewThumbhash}
          contentFit={canPlay ? videoContentFit : 'cover'}
          onError={() => setFailedPosterUrl(usablePreviewUrl)}
          style={[absoluteFill, { backgroundColor: 'transparent', opacity: posterVisible ? 1 : 0 }]}
        />
      ) : null}

      {posterless ? (
        <View pointerEvents="none" style={[absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <View
            style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: `${accent}66`,
              backgroundColor: `${accent}22`,
            }}
          >
            <Play size={19} color="#ffffff" fill="#ffffff" />
          </View>
        </View>
      ) : null}

      {canPlay && !hasFirstFrame && !hasPlaybackError ? (
        <View
          pointerEvents="none"
          style={[absoluteFill, {
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: `${appTheme.colors.background}66`,
          }]}
        >
          <ActivityIndicator color={accent} />
        </View>
      ) : null}
    </View>
  );
}

function FeedVideoPlayerLayer({
  url,
  contentFit,
  playerRef,
  onFirstFrame,
  onPlaybackError,
}: {
  url: string;
  contentFit: 'cover' | 'contain';
  playerRef: { current: VideoPlayer | null };
  onFirstFrame: () => void;
  onPlaybackError: (errored: boolean) => void;
}) {
  const player = useVideoPlayer({ uri: url, useCaching: true }, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.volume = 0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
    // Assigned as a whole object: the individual fields are readonly.
    instance.bufferOptions = {
      preferredForwardBufferDuration: FEED_PREVIEW_FORWARD_BUFFER_SECONDS,
    };
  });

  useEffect(() => {
    playerRef.current = player;
    player.play();
  }, [player, playerRef]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', (event) => {
      onPlaybackError(event.status === 'error');
    });
    return () => {
      subscription.remove();
    };
  }, [player, onPlaybackError]);

  return (
    <VideoView
      {...FEED_VIDEO_VIEW_PROPS}
      player={player}
      contentFit={contentFit}
      onFirstFrameRender={onFirstFrame}
      pointerEvents="none"
      style={[absoluteFill, { backgroundColor: 'transparent' }]}
    />
  );
}
