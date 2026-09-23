import { useIsFocused } from '@react-navigation/native';
import type { ImageProps } from 'expo-image';
import { createVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { Play, RotateCcw } from 'lucide-react-native';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { BackdropImage } from '@/components/backdrop-image';
import { FEED_VIDEO_VIEW_PROPS } from '@/components/feed-media-frame';
import { FeedMediaPlate } from '@/components/feed-media-plate';
import { StableMediaImage } from '@/components/media-preview';
import { useMediaZoomTileKey, useMediaZoomVideoOffer } from '@/lib/media-zoom-video-offer';
import {
  acceptVideoReturn,
  claimReturnedVideoPlayer,
  isVideoLoanHeld,
  isVideoReturnPending,
  lenderUnmounting,
  reportReturnedVideoDrawn,
  subscribeToVideoLoanHolds,
  subscribeToVideoReturns,
} from '@/lib/video-player-loans';
import { useAppForeground } from '@/lib/app-foreground';
import { recordMediaDiagnostic } from '@/lib/media-diagnostics';
import {
  FEED_PREPARED_FORWARD_BUFFER_SECONDS,
  FEED_PREVIEW_BUFFERING_INDICATOR_DELAY_MS,
  FEED_PREVIEW_FORWARD_BUFFER_SECONDS,
} from '@/lib/media-performance';
import { MEDIA_DISPLAY_DEADLINE_MS } from '@/lib/media-recovery';
import { useMediaSource } from '@/lib/use-media-source';
import { appTheme } from '@/lib/theme';
import {
  beginPlaybackStall,
  beginPlaybackStart,
  cancelPlaybackStart,
  completePlaybackStart,
  endPlaybackStall,
  forgetPlayback,
} from '@/lib/playback-metrics';
import { MEDIA_PLAYER_OPTIONS } from '@/lib/video-player-options';

const absoluteFill = {
  position: 'absolute' as const,
  inset: 0,
};

// Fabric can apply a queued VideoView mount after React has already unmounted
// the layer. Releasing the SharedObject in that same commit leaves Android
// trying to attach a dead player. Keep the paused player alive long enough for
// the native view transaction to detach before releasing it.
const PLAYER_RELEASE_GRACE_MS = 100;

/** The blur a poster wash without a thumbhash is drawn with; see BackdropImage. */
const VIDEO_BACKDROP_BLUR_RADIUS = 24;

function forwardBufferSeconds(playing: boolean) {
  return playing ? FEED_PREVIEW_FORWARD_BUFFER_SECONDS : FEED_PREPARED_FORWARD_BUFFER_SECONDS;
}

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
 * A `prepared` tile goes one step further, the way TikTok and Instagram keep
 * the next posts loaded: its player is created paused and draws its first frame
 * before the reader arrives, and a tile that stops playing keeps its player and
 * its frame for as long as it stays prepared. Activation is then a resume of a
 * picture already on screen rather than a load, and scrolling back continues
 * the clip instead of starting it again from the poster.
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
  lendableStreamUrl = null,
  previewUrl,
  previewCacheKey,
  previewThumbhash,
  onPosterLoad,
  active,
  prepared = false,
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
  /**
   * `streamUrl` again, when the reel plays that very file — then a tile inside a
   * zoom source offers its playing player to the reel it opens, which carries
   * on with it instead of starting the clip over. Null for a teaser.
   */
  lendableStreamUrl?: string | null;
  previewUrl?: string | null;
  previewCacheKey?: string;
  previewThumbhash?: string | null;
  onPosterLoad?: ImageProps['onLoad'];
  active: boolean;
  /**
   * Hold a paused player with its first frame drawn while not active. The feed
   * sets it for the videos around the playing one (see
   * selectPreparedShowcaseVideoIds); it changes nothing while `active`.
   */
  prepared?: boolean;
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
  // A reel closing into this tile is handing back the player it carried away
  // (lib/video-player-loans.ts). Until that reel has gone the tile holds a player
  // without its screen's focus, so it can take this one over from under the reel.
  const tileKey = useMediaZoomTileKey();
  const returning = useSyncExternalStore(
    subscribeToVideoReturns,
    () => Boolean(tileKey && lendableStreamUrl && isVideoReturnPending(tileKey, lendableStreamUrl)),
  );
  // And a tile whose player iOS's own zoom is carrying up keeps drawing it
  // until the push has landed: UIKit grows this very view into the reel, and
  // the reel's view of the same player fades in over it (lib/apple-zoom.ts).
  const lending = useSyncExternalStore(
    subscribeToVideoLoanHolds,
    () => Boolean(tileKey && lendableStreamUrl && isVideoLoanHeld(tileKey, lendableStreamUrl)),
  );
  const canStream = (isFocused || returning || lending) && Boolean(streamUrl);
  const canPlay = active && canStream;
  const wantsPlayer = (active || prepared) && canStream;
  const foreground = useAppForeground(canPlay);

  // Every latch is keyed to one player rather than being a boolean. The key
  // carries the stream and its credentials, the generation — each player the
  // tile mounts is a new one, so neither a recycled instance nor a player
  // created after an earlier one was released inherits a frame it has not
  // drawn, which would lift the poster off a bare surface — and the retry
  // count, so a retry never inherits the failed attempt's error or stall.
  const [attempt, setAttempt] = useState(0);
  const [playerSlot, setPlayerSlot] = useState({ mounted: false, generation: 0 });
  const playerKey = `${streamUrl}|${requestKey}|${playerSlot.generation}#${attempt}`;

  const [failedPosterUrl, setFailedPosterUrl] = useState<string | null>(null);
  const [firstFrameKey, setFirstFrameKey] = useState<string | null>(null);
  const [playbackErrorKey, setPlaybackErrorKey] = useState<string | null>(null);
  const [stalledKey, setStalledKey] = useState<string | null>(null);
  const [slowStartKey, setSlowStartKey] = useState<string | null>(null);

  const hasPlaybackError = Boolean(streamUrl) && playbackErrorKey === playerKey;
  const stalled = Boolean(streamUrl) && stalledKey === playerKey;
  const playbackFailed = hasPlaybackError || stalled;
  // A failed attempt releases its player; the poster and Retry take its place.
  const playerMounted = wantsPlayer && !playbackFailed;
  // Whether this tile would take back the player of a reel closing into it: it
  // would hold a player on this stream anyway, were its screen focused.
  const takesReturn = Boolean(tileKey && lendableStreamUrl && streamUrl) && (active || prepared) && !playbackFailed;
  useEffect(() => {
    if (!takesReturn || !tileKey || !lendableStreamUrl) return undefined;
    return acceptVideoReturn(tileKey, lendableStreamUrl);
  }, [lendableStreamUrl, takesReturn, tileKey]);
  if (playerSlot.mounted !== playerMounted) {
    setPlayerSlot({
      mounted: playerMounted,
      generation: playerMounted ? playerSlot.generation + 1 : playerSlot.generation,
    });
  }

  const usablePreviewUrl = previewUrl && previewUrl !== failedPosterUrl ? previewUrl : null;
  const hasFirstFrame = playerMounted && firstFrameKey === playerKey;
  // The poster covers the tile until the tile's own player has drawn, and comes
  // back on a failure or once the player is gone. Posters are the clip's first
  // frame, so handing over to a player's first frame changes nothing visible.
  const posterVisible = !hasFirstFrame || playbackFailed;
  // Nothing to show but the play badge: keep the borderless dark tile this
  // state has always rendered rather than framing an empty box.
  const posterless = !usablePreviewUrl && !canPlay && !hasFirstFrame;
  const loading = canPlay && !hasFirstFrame && !playbackFailed;
  const slowStart = loading && slowStartKey === playerKey;

  useEffect(() => {
    setFailedPosterUrl(null);
  }, [previewUrl, url, posterRequestKey]);

  // A tile that has left the playing and prepared windows has released its
  // player, and a failure it recorded belongs to that player: the next time it
  // is wanted it tries afresh, rather than showing Retry for a player long gone.
  useEffect(() => {
    if (wantsPlayer) return;
    setPlaybackErrorKey(null);
    setStalledKey(null);
  }, [wantsPlayer]);

  // Foreground time only: a tile left behind the app switcher is not stalled.
  // Nor is a prepared tile waiting its turn: only a playing tile has a deadline.
  useEffect(() => {
    if (!playerMounted || !canPlay || hasFirstFrame || playbackFailed || !foreground) return;
    const timer = setTimeout(() => {
      setStalledKey(playerKey);
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
  }, [attempt, canPlay, diagnosticsSurface, foreground, hasFirstFrame, playbackFailed, playerKey, playerMounted, url]);

  // Dimming the tile under a spinner on every activation was the blink the feed
  // showed while scrolling: each handoff flashed dark for as long as a new
  // player took to draw. The poster already shows what is coming, so the
  // spinner waits for a start that is genuinely slow.
  useEffect(() => {
    if (!loading) return undefined;
    const timer = setTimeout(() => setSlowStartKey(playerKey), FEED_PREVIEW_BUFFERING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loading, playerKey]);

  const handleFirstFrame = useCallback(() => {
    setFirstFrameKey(playerKey);
    setPlaybackErrorKey(null);
    if (attempt > 0) {
      recordMediaDiagnostic({ kind: 'video', event: 'recovered', surface: diagnosticsSurface, subject: url, attempt });
    }
  }, [attempt, diagnosticsSurface, playerKey, url]);

  const handlePlaybackError = useCallback((errored: boolean) => {
    setPlaybackErrorKey(errored ? playerKey : null);
    if (errored) {
      recordMediaDiagnostic({ kind: 'video', event: 'error', surface: diagnosticsSurface, subject: url, attempt, stage: 'player' });
    }
  }, [attempt, diagnosticsSurface, playerKey, url]);

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
          {usablePreviewUrl || previewThumbhash ? (
            <BackdropImage
              thumbhash={previewThumbhash}
              source={usablePreviewUrl ? posterSource : null}
              blurRadius={VIDEO_BACKDROP_BLUR_RADIUS}
              recyclingKey={`${url}:video-backdrop`}
              style={[absoluteFill, { backgroundColor: '#050506' }]}
            />
          ) : null}
          <View pointerEvents="none" style={[absoluteFill, { backgroundColor: 'rgba(0,0,0,0.44)' }]} />
        </>
      ) : null}

      {playerMounted && streamUrl ? (
        <FeedVideoPlayerLayer
          key={playerKey}
          source={streamSource}
          lendableUrl={lendableStreamUrl}
          returnKey={tileKey}
          contentFit={videoContentFit}
          playing={canPlay}
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
          contentFit={playerMounted ? videoContentFit : 'cover'}
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

      {slowStart ? (
        <View pointerEvents="none" style={[absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(3,3,6,0.55)',
            }}
          >
            <ActivityIndicator color={appTheme.colors.text} />
          </View>
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

let feedPlaybackSequence = 0;

function FeedVideoPlayerLayer({
  source,
  lendableUrl,
  returnKey,
  contentFit,
  playing,
  onFirstFrame,
  onPlaybackError,
}: {
  source: { uri: string; headers?: Record<string, string> };
  /** Offered to the zoom out of this tile under this stream; null offers nothing. */
  lendableUrl: string | null;
  /** The zoom tile this is (`zoomTileKey`), for taking back a reel's player; null outside one. */
  returnKey: string | null;
  contentFit: 'cover' | 'contain';
  playing: boolean;
  onFirstFrame: () => void;
  onPlaybackError: (errored: boolean) => void;
}) {
  // The player a reel closing into this tile handed back is carried on with in
  // place of a new one. A new one showed the poster — the clip's first frame —
  // until it drew, then started the clip from wherever it was told: a flash of
  // frame zero and a jump, on every return from a playing video.
  const [{ player, returned }] = useState<{ player: VideoPlayer; returned: boolean }>(() => {
    const taken = returnKey && lendableUrl ? claimReturnedVideoPlayer(returnKey, lendableUrl) : null;
    const instance = taken ?? createVideoPlayer({ ...source, useCaching: true }, MEDIA_PLAYER_OPTIONS);
    // The reel listened to its progress; a tile does not.
    if (taken) instance.timeUpdateEventInterval = 0;
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
    instance.bufferOptions = { preferredForwardBufferDuration: forwardBufferSeconds(playing) };
    return { player: instance, returned: taken !== null };
  });
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fleet metrics (lib/playback-metrics): one key per player this layer holds.
  const [metricsKey] = useState(() => `feed:${(feedPlaybackSequence += 1)}`);
  const playingRef = useRef(playing);
  useEffect(() => () => forgetPlayback(metricsKey), [metricsKey]);

  // Offered to the zoom out of the tile, which lends it to the flight and the
  // reel when the tile is tapped (see lib/video-player-loans.ts).
  const offerVideo = useMediaZoomVideoOffer();
  // A player handed back has drawn this clip in this tile before.
  const hasFrameRef = useRef(returned);
  // A new native view, for taking the player back: on Android a player draws in
  // one view at a time, and a view it has left does not reclaim it on its own.
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  useEffect(() => {
    if (!offerVideo || !lendableUrl) return undefined;
    return offerVideo({
      player,
      url: lendableUrl,
      hasFrame: () => hasFrameRef.current,
      reattach: () => setSurfaceGeneration((generation) => generation + 1),
    });
  }, [lendableUrl, offerVideo, player]);

  const handleFirstFrameRender = useCallback(() => {
    hasFrameRef.current = true;
    completePlaybackStart(metricsKey);
    onFirstFrame();
    // What the closing reel waits on before it lets the tile be seen.
    if (returned) reportReturnedVideoDrawn(player);
  }, [metricsKey, onFirstFrame, player, returned]);

  // The clip a player handed back is showing is already under way: its poster,
  // the first frame, must not come back over it while this view takes it on.
  // The closing reel covers the tile until this view has drawn.
  useLayoutEffect(() => {
    if (returned) onFirstFrame();
    // Once, for the player this layer was created with: the layer is keyed to it.
  }, [returned]);

  useEffect(() => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    return () => {
      // Out on loan, the player is the flight's or the reel's now — this tile
      // unmounts exactly because the reel it opened took its screen's focus.
      if (lenderUnmounting(player)) return;
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

  // One player serves both states. Paused, it holds only the head of the clip —
  // enough to have drawn its first frame and to start without a stall — and
  // playing widens to the preview window.
  useEffect(() => {
    player.bufferOptions = { preferredForwardBufferDuration: forwardBufferSeconds(playing) };
    playingRef.current = playing;
    if (playing) {
      // Asked to move: a player that has drawn is a warm start, one that has not is cold.
      beginPlaybackStart(metricsKey, { surface: 'feed', kind: hasFrameRef.current ? 'warm' : 'cold' });
      player.play();
    } else {
      cancelPlaybackStart(metricsKey);
      endPlaybackStall(metricsKey);
      player.pause();
    }
  }, [metricsKey, player, playing]);

  useEffect(() => {
    const subscription = player.addListener('playingChange', (event) => {
      if (event.isPlaying) completePlaybackStart(metricsKey);
    });
    return () => {
      subscription.remove();
    };
  }, [metricsKey, player]);

  useEffect(() => {
    // A source that failed before this effect subscribed never sends a
    // statusChange, so the current status is read first.
    onPlaybackError(player.status === 'error');
    const subscription = player.addListener('statusChange', (event) => {
      onPlaybackError(event.status === 'error');
      // Loading again after motion, while asked to play, is a stall.
      if (event.status === 'loading' && playingRef.current && hasFrameRef.current) beginPlaybackStall(metricsKey);
      else if (event.status !== 'loading') endPlaybackStall(metricsKey);
    });
    return () => {
      subscription.remove();
    };
  }, [metricsKey, player, onPlaybackError]);

  return (
    <VideoView
      {...FEED_VIDEO_VIEW_PROPS}
      key={surfaceGeneration}
      player={player}
      contentFit={contentFit}
      onFirstFrameRender={handleFirstFrameRender}
      pointerEvents="none"
      style={[absoluteFill, { backgroundColor: 'transparent' }]}
    />
  );
}
