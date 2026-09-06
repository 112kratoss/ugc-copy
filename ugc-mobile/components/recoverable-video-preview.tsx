import { useVideoPlayer, VideoView, type VideoPlayer, type VideoPlayerStatus } from 'expo-video';
import { useIsFocused } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { SecondaryButton } from '@/components/ui';
import { useNativePreviewPlayback } from '@/lib/use-native-preview-playback';
import { useMediaSource } from '@/lib/use-media-source';
import { appTheme } from '@/lib/theme';

type VideoPreviewProps = {
  url: string;
  style: StyleProp<ViewStyle>;
  nativeControls?: boolean;
  autoPlay?: boolean;
  contentFit?: 'contain' | 'cover' | 'fill';
  resolveRetryUrl?: () => Promise<string>;
};

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
  const isFocused = useIsFocused();
  const { source } = useMediaSource(url);
  const previousPlayer = useRef<VideoPlayer | null>(null);
  const player = useVideoPlayer(source, instance => {
    const previous = previousPlayer.current;
    instance.loop = true;
    instance.muted = previous?.muted ?? false;
    instance.audioMixingMode = 'auto';
    // The hook recreates its native player when credentials or the effective
    // URL change. The old player is still alive during setup, so preserve the
    // viewer's state before the hook releases it. A new item/explicit Retry
    // remounts this attempt and starts with no previous player.
    if (previous) {
      instance.currentTime = previous.currentTime;
      instance.volume = previous.volume;
      instance.playbackRate = previous.playbackRate;
    }
    if ((previous ? previous.playing : autoPlay) && isFocused) instance.play();
    else if (previous) instance.pause();
  });
  previousPlayer.current = player;
  const playback = useNativePreviewPlayback(player, isFocused);
  // Stack navigation keeps earlier screens mounted. Their players must stop
  // even though useVideoPlayer's unmount cleanup has not run yet.
  useEffect(() => {
    if (!isFocused) player.pause();
  }, [isFocused, player]);
  const [status, setStatus] = useState<VideoPlayerStatus>(player.status);
  const [timedOutPlayer, setTimedOutPlayer] = useState<VideoPlayer | null>(null);
  const timedOut = timedOutPlayer === player;
  useEffect(() => {
    if (timedOut || (status !== 'loading' && status !== 'idle')) return;
    const timer = setTimeout(() => {
      setTimedOutPlayer(player);
      player.pause();
      // Release the stalled transport; Retry creates a fresh native player.
      void player.replaceAsync(null).catch(() => undefined);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [player, status, timedOut]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', event => setStatus(event.status));
    setStatus(player.status);
    return () => subscription.remove();
  }, [player]);

  return (
    <View ref={playback.viewRef} collapsable={false} onLayout={playback.onLayout} style={[style, { overflow: 'hidden' }]}>
      <VideoView
        player={player}
        onFullscreenEnter={playback.onFullscreenEnter}
        onFullscreenExit={playback.onFullscreenExit}
        nativeControls={nativeControls}
        contentFit={contentFit}
        style={{ width: '100%', height: '100%' }}
      />
      {!timedOut && (status === 'loading' || status === 'idle') ? (
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator accessibilityLabel="Loading video" color={appTheme.colors.primary} />
        </View>
      ) : null}
      {timedOut || status === 'error' ? (
        <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: appTheme.colors.panel, borderRadius: 20, padding: 20, gap: 12 }}>
            <Text accessibilityRole="alert" style={{ color: appTheme.colors.text, fontSize: 16, textAlign: 'center' }}>
              {renewalFailed ? 'Couldn’t refresh video. Try again.' : 'Video couldn’t load'}
            </Text>
            <SecondaryButton label={renewing ? 'Refreshing video…' : 'Retry video'} disabled={renewing} onPress={onRetry} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
