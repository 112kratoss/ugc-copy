import { useIsFocused } from '@react-navigation/native';
import { Image, type ImageProps } from 'expo-image';
import { createVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { Play, RotateCcw } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { FEED_VIDEO_VIEW_PROPS } from '@/components/feed-media-frame';
import { FeedMediaPlate } from '@/components/feed-media-plate';
import { StableMediaImage } from '@/components/media-preview';
import { useAppForeground } from '@/lib/app-foreground';
import { recordMediaDiagnostic } from '@/lib/media-diagnostics';
import { FEED_PREVIEW_FORWARD_BUFFER_SECONDS } from '@/lib/media-performance';
import { MEDIA_DISPLAY_DEADLINE_MS } from '@/lib/media-recovery';
import { useMediaSource } from '@/lib/use-media-source';
import { appTheme } from '@/lib/theme';

const absoluteFill = {
  position: 'absolute' as const,
  inset: 0,
};

// Fabric can apply a queued VideoView mount after React has already unmounted
// the layer. Releasing the SharedObject in that same commit leaves Android
// trying to attach a dead player. Keep the paused player alive long enough for
// the native view transaction to detach before releasing it.
const PLAYER_RELEASE_GRACE_MS = 100;

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
 *
 * A playback attempt that fails — an error, including one reported before this
 * tile subscribed, or no first frame within the deadline — releases its player
 * and leaves the poster with a Retry control. Before, an early error was missed
 * and a player that never rendered spun forever (2026-09-16 Creations
 * reliability audit, C9). Retry recreates only this tile's player, so the feed
 * still runs at most one active preview.
 */
export function FeedVideoPreview({
  url,
  streamUrl = null,
  previewUrl,
  previewCacheKey,
  previewThumbhash,
  onPosterLoad,
  active,
  height,
  radius,
  accent,
  videoBackdrop = 'blurred',
  videoContentFit = 'contain',
  watchdog = false,
  diagnosticsSurface = 'feed',
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
  onPosterLoad?: ImageProps['onLoad'];
  active: boolean;
  height: number;
  radius: number;
  accent: string;
  videoBackdrop?: 'blurred' | 'none';
  videoContentFit?: 'cover' | 'contain';
  /** Arms the poster image's display deadline; see `StableMediaImage`. */
  watchdog?: boolean;
  /** Where the tile is drawn, for the media diagnostics log. */
  diagnosticsSurface?: string;
}) {
  const { source: streamSource, requestKey } = useMediaSource(streamUrl || '');
  const { source: posterSource, requestKey: posterRequestKey } = useMediaSource(previewUrl || '');
  // Keep navigation focus at the player boundary. Making it list extraData
  // rerendered every mounted feed card on each tab switch just to pause one video.
  const isFocused = useIsFocused();
  const canPlay = active && isFocused && Boolean(streamUrl);
  const foreground = useAppForeground(canPlay);

  const [failedPosterUrl, setFailedPosterUrl] = useState<string | null>(null);
  // Every latch is keyed to one playback attempt — the stream, its credentials
  // and the retry count — rather than being a boolean, so a recycled instance or
  // a retry never inherits the previous attempt's first frame, error or stall.
  const [attempt, setAttempt] = useState(0);
  const attemptIdentity = `${streamUrl}|${requestKey}#${attempt}`;
  const [firstFrameIdentity, setFirstFrameIdentity] = useState<string | null>(null);
  const [errorIdentity, setErrorIdentity] = useState<string | null>(null);
  const [stalledIdentity, setStalledIdentity] = useState<string | null>(null);
  const hasFirstFrame = Boolean(streamUrl) && firstFrameIdentity === attemptIdentity;
  const hasPlaybackError = Boolean(streamUrl) && errorIdentity === attemptIdentity;
  const stalled = Boolean(streamUrl) && stalledIdentity === attemptIdentity;
  const playbackFailed = hasPlaybackError || stalled;
  const shouldMountPlayer = canPlay && !playbackFailed;
  const [playerMounted, setPlayerMounted] = useState(shouldMountPlayer);

  const usablePreviewUrl = previewUrl && previewUrl !== failedPosterUrl ? previewUrl : null;
  const posterVisible = !canPlay || !hasFirstFrame || playbackFailed;
  // Nothing to show but the play badge: keep the borderless dark tile this
  // state has always rendered rather than framing an empty box.
  const posterless = !usablePreviewUrl && !canPlay;

  useEffect(() => {
    setFailedPosterUrl(null);
  }, [previewUrl, url, posterRequestKey]);

  useEffect(() => {
    // The player layer owns pause/release ordering. Dropping it here works for
    // viewability handoffs, whole-screen navigation and a failed attempt alike.
    setPlayerMounted(shouldMountPlayer);
    if (!canPlay) {
      setFirstFrameIdentity(null);
      setErrorIdentity(null);
      setStalledIdentity(null);
    }
  }, [canPlay, shouldMountPlayer]);

  // Foreground time only: a tile left behind the app switcher is not stalled.
  useEffect(() => {
    if (!playerMounted || !canPlay || hasFirstFrame || playbackFailed || !foreground) return;
    const timer = setTimeout(() => {
      setStalledIdentity(attemptIdentity);
      recordMediaDiagnostic({
        kind: 'video',
        event: 'stall',
        surface: diagnosticsSurface,
        subject: url,
        attempt,
        stage: 'no-first-frame',
      });
    }, MEDIA_DISPLAY_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [attempt, attemptIdentity, canPlay, diagnosticsSurface, foreground, hasFirstFrame, playbackFailed, playerMounted, url]);

  const handleFirstFrame = useCallback(() => {
    setFirstFrameIdentity(attemptIdentity);
    setErrorIdentity(null);
    if (attempt > 0) {
      recordMediaDiagnostic({ kind: 'video', event: 'recovered', surface: diagnosticsSurface, subject: url, attempt });
    }
  }, [attempt, attemptIdentity, diagnosticsSurface, url]);

  const handlePlaybackError = useCallback((errored: boolean) => {
    setErrorIdentity(errored ? attemptIdentity : null);
    if (errored) {
      recordMediaDiagnostic({ kind: 'video', event: 'error', surface: diagnosticsSurface, subject: url, attempt, stage: 'player' });
    }
  }, [attempt, attemptIdentity, diagnosticsSurface, url]);

  const retryPlayback = () => {
    recordMediaDiagnostic({
      kind: 'video',
      event: 'retry',
      surface: diagnosticsSurface,
      subject: url,
      attempt: attempt + 1,
      stage: stalled ? 'stalled' : 'error',
    });
    setAttempt((value) => value + 1);
  };

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
              source={posterSource}
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
          key={attemptIdentity}
          source={streamSource}
          contentFit={videoContentFit}
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
          onLoad={onPosterLoad}
          contentFit={canPlay ? videoContentFit : 'cover'}
          onError={() => setFailedPosterUrl(usablePreviewUrl)}
          watchdog={watchdog && posterVisible}
          diagnosticsSurface={diagnosticsSurface}
          style={[absoluteFill, { backgroundColor: 'transparent', opacity: posterVisible ? 1 : 0 }]}
        />
      ) : null}

      {posterless ? (
        <View pointerEvents="none" style={[absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <FeedMediaPlate accent={accent} glyph={Play} filled />
        </View>
      ) : null}

      {canPlay && !hasFirstFrame && !playbackFailed ? (
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

      {canPlay && playbackFailed ? (
        <View pointerEvents="box-none" style={[absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Video couldn’t load. Retry"
            onPress={retryPlayback}
            style={({ pressed }) => ({
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 16,
              borderRadius: appTheme.radii.pill,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.18)',
              backgroundColor: 'rgba(3,3,6,0.72)',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <RotateCcw size={appTheme.icon.sm} color="#ffffff" />
            <Text style={{ color: '#ffffff', ...appTheme.type.label }}>Retry video</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function FeedVideoPlayerLayer({
  source,
  contentFit,
  onFirstFrame,
  onPlaybackError,
}: {
  source: { uri: string; headers?: Record<string, string> };
  contentFit: 'cover' | 'contain';
  onFirstFrame: () => void;
  onPlaybackError: (errored: boolean) => void;
}) {
  const [player] = useState<VideoPlayer>(() => {
    const instance = createVideoPlayer({ ...source, useCaching: true });
    instance.loop = true;
    instance.muted = true;
    instance.volume = 0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
    // Playing audio: "don't make people stop listening to music from another app
    // if you don't need to." These previews are silent by construction, and
    // `auto` keeps them out of the audio session; expo-video's iOS default
    // (`doNotMix`) would seize it anyway, while its Android default is `auto`.
    instance.audioMixingMode = 'auto';
    // Assigned as a whole object: the individual fields are readonly.
    instance.bufferOptions = {
      preferredForwardBufferDuration: FEED_PREVIEW_FORWARD_BUFFER_SECONDS,
    };
    return instance;
  });
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    player.play();
    return () => {
      try {
        player.pause();
      } catch {
        // The native player may already be gone during a development reload.
      }
      releaseTimerRef.current = setTimeout(() => {
        releaseTimerRef.current = null;
        try {
          player.release();
        } catch {
          // Release is idempotent from the preview's point of view.
        }
      }, PLAYER_RELEASE_GRACE_MS);
    };
  }, [player]);

  useEffect(() => {
    // A source that failed before this effect subscribed never sends a
    // statusChange, so the current status is read first.
    onPlaybackError(player.status === 'error');
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
