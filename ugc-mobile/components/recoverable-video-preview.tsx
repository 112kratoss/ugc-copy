import { useVideoPlayer, VideoView, type VideoPlayer, type VideoPlayerStatus } from 'expo-video';
import { useIsFocused } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { SecondaryButton } from '@/components/ui';
import { useNativePreviewPlayback } from '@/lib/use-native-preview-playback';
import { cachedVideoSource } from '@/lib/media-source';
import { leaveTouchToNativeView } from '@/lib/native-touch-owner';
import { useMediaSource } from '@/lib/use-media-source';
import { useVideoLoadDeadline } from '@/lib/use-video-load-deadline';
import { useVideoHasBeenReady } from '@/lib/use-video-has-been-ready';
import { useVideoSourceAfterSurface } from '@/lib/use-video-source-after-surface';
import { mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

type VideoPreviewProps = {
  url: string;
  style: StyleProp<ViewStyle>;
  nativeControls?: boolean;
  autoPlay?: boolean;
  contentFit?: 'contain' | 'cover' | 'fill';
  resolveRetryUrl?: () => Promise<string>;
};

// These players hold one clip, so there is no previous or next to go to.
// expo-video documents both buttons as hidden by default, but on Android it
// only applies its defaults once this prop is set; until then Media3's own
// defaults show them.
const SINGLE_CLIP_BUTTONS = { showPrevious: false, showNext: false };

/** Shared by result previews and lightboxes; retry never starts a generation. */
export function RecoverableVideoPreview(props: VideoPreviewProps) {
  return <VideoPreviewSession key={props.url} {...props} />;
}

function VideoPreviewSession(props: VideoPreviewProps) {
  const [retry, setRetry] = useState({ url: props.url, attempt: 0 });
  const [renewing, setRenewing] = useState(false);
  const [renewalFailed, setRenewalFailed] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const retryVideo = async () => {
    if (pending.current) return;
    if (!props.resolveRetryUrl) {
      setRetry(current => ({ ...current, attempt: current.attempt + 1 }));
      return;
    }
    pending.current = true;
    setRenewing(true);
    setRenewalFailed(false);
    try {
      const url = await props.resolveRetryUrl();
      if (!url.trim()) throw new Error('Missing renewed URL');
      if (mounted.current) setRetry(current => ({ url, attempt: current.attempt + 1 }));
    } catch {
      if (mounted.current) setRenewalFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setRenewing(false);
    }
  };
  return (
    <VideoPreviewAttempt
      {...props}
      url={retry.url}
      key={`${retry.url}:${retry.attempt}`}
      autoPlay={props.autoPlay || retry.attempt > 0}
      renewing={renewing}
      renewalFailed={renewalFailed}
      onRetry={() => void retryVideo()}
    />
  );
}

function VideoPreviewAttempt({
  url, style, nativeControls = true, autoPlay = false, contentFit, onRetry, renewing, renewalFailed,
}: VideoPreviewProps & { onRetry: () => void; renewing: boolean; renewalFailed: boolean }) {
  const theme = useAppTheme();
  const isFocused = useIsFocused();
  const { source } = useMediaSource(url);
  const previousPlayer = useRef<VideoPlayer | null>(null);
  // Cached, because this player loops: uncached, every repeat downloads the
  // clip again (see cachedVideoSource). Without the feed's forward-buffer cap,
  // on purpose. A capped player stops partway through the file and holds its
  // cache entry open, so a second player on the same clip (the details sheet
  // over a tile, the lightbox over a result) has to download it again.
  //
  // On Android the player is made empty and given its clip once its view has a
  // surface to draw on (see useVideoSourceAfterSurface).
  const afterSurface = Platform.OS === 'android';
  const player = useVideoPlayer(afterSurface ? null : cachedVideoSource(source), instance => {
    const previous = previousPlayer.current;
    instance.loop = true;
    instance.muted = previous?.muted ?? false;
    instance.audioMixingMode = 'auto';
    // The hook recreates its native player when credentials or the effective
    // URL change. The old player is still alive during setup, so preserve the
    // viewer's state before the hook releases it. A new item/explicit Retry
    // remounts this attempt and starts with no previous player. (On Android
    // the one player is handed the renewed link instead, and keeps its state.)
    if (previous) {
      instance.currentTime = previous.currentTime;
      instance.volume = previous.volume;
      instance.playbackRate = previous.playbackRate;
    }
    // A player replaced before it reached readiness still carries this
    // component's own autoplay request: `playing` only turns true once the
    // native player renders. Only a ready, paused player was actually stopped.
    const requested = previous ? previous.playing || (previous.status !== 'readyToPlay' && autoPlay) : autoPlay;
    if (requested && isFocused) instance.play();
    else if (previous) instance.pause();
  });
  previousPlayer.current = player;
  const surface = useVideoSourceAfterSurface(afterSurface ? cachedVideoSource(source) : null, player);
  const playback = useNativePreviewPlayback(player, isFocused);
  // Stack navigation keeps earlier screens mounted. Their players must stop
  // even though useVideoPlayer's unmount cleanup has not run yet.
  useEffect(() => {
    if (!isFocused) player.pause();
  }, [isFocused, player]);
  const [status, setStatus] = useState<VideoPlayerStatus>(player.status);
  const timedOut = useVideoLoadDeadline(player, status);
  const hasBeenReady = useVideoHasBeenReady(player);
  const failed = timedOut || status === 'error';
  // Android's controller shows itself on any paused player, loaded or not: a
  // play button exactly over the spinner, "00:00 · 00:00" under it, and its bar
  // still up beneath the retry card. iOS draws its controls only once there is
  // something to play. So on Android the player is covered until its clip can
  // play, and again once the attempt has failed.
  //
  // Covered, and otherwise left exactly as it is. Mounting the player late, or
  // mounting it without its controls and turning them on at ready (a different
  // native view on Android), gives the decoder a new surface just as its first
  // frames arrive, and a paused clip that loses its first frame that way never
  // draws another.
  const covered = Platform.OS === 'android' && nativeControls && (failed || !hasBeenReady);

  useEffect(() => {
    const subscription = player.addListener('statusChange', event => setStatus(event.status));
    setStatus(player.status);
    return () => subscription.remove();
  }, [player]);

  return (
    <View
      ref={playback.viewRef}
      collapsable={false}
      onLayout={() => { playback.onLayout(); surface.onLayout(); }}
      style={[style, { overflow: 'hidden' }]}
    >
      {/* A player without controls has nothing of its own to touch, so touches
          pass it by and reach whatever holds it: a reference tile, an upload
          slot. Left to take them, expo-video's Android view keeps each touch
          and forwards it to JS with the finger's place inside the clip standing
          in for its place on the page. The press target around it then sees
          the finger jump out of its bounds on the first movement and drops the
          press, so a finger never opens it, and only a tap with no movement at
          all (`adb shell input tap`) does.

          A player with controls answers for the touches that begin on it,
          natively. On Android its view tells JS of each one as well, so it
          says there that the touch is its own, and a sheet's drag, which would
          take any touch-down, leaves it (see leaveTouchToNativeView). */}
      <View collapsable={false} pointerEvents={nativeControls ? 'auto' : 'none'} style={{ width: '100%', height: '100%' }}>
        <VideoView
          player={player}
          onFullscreenEnter={playback.onFullscreenEnter}
          onFullscreenExit={playback.onFullscreenExit}
          nativeControls={nativeControls}
          buttonOptions={SINGLE_CLIP_BUTTONS}
          contentFit={contentFit}
          style={{ width: '100%', height: '100%' }}
          importantForAccessibility={covered ? 'no-hide-descendants' : undefined}
          onStartShouldSetResponder={Platform.OS === 'android' && nativeControls ? leaveTouchToNativeView : undefined}
        />
      </View>
      {covered ? (
        // The frame's own ground over the player. Being painted is also what
        // makes it take the touches, so the controls under it cannot be pressed.
        <View style={{ position: 'absolute', inset: 0, backgroundColor: StyleSheet.flatten(style)?.backgroundColor ?? mediaColors.mediaGround }} />
      ) : null}
      {!timedOut && (status === 'loading' || status === 'idle') ? (
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator accessibilityLabel="Loading video" color={theme.colors.primary} />
        </View>
      ) : null}
      {failed ? (
        <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: theme.colors.panel, borderRadius: 20, padding: 20, gap: 12 }}>
            <Text accessibilityRole="alert" style={{ color: theme.colors.text, fontSize: 16, textAlign: 'center' }}>
              {renewalFailed ? 'Couldn’t refresh video. Try again.' : 'Video couldn’t load'}
            </Text>
            <SecondaryButton label={renewing ? 'Refreshing video…' : 'Retry video'} disabled={renewing} onPress={onRetry} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
