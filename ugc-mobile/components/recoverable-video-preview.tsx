import { useVideoPlayer, VideoView, type VideoPlayerStatus } from 'expo-video';
import { useIsFocused } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { SecondaryButton } from '@/components/ui';
import { useMediaSource } from '@/lib/use-media-source';
import { appTheme } from '@/lib/theme';

type VideoPreviewProps = {
  url: string;
  style: StyleProp<ViewStyle>;
  nativeControls?: boolean;
  autoPlay?: boolean;
  contentFit?: 'contain' | 'cover' | 'fill';
};

/** Shared by result previews and lightboxes; retry never starts a generation. */
export function RecoverableVideoPreview(props: VideoPreviewProps) {
  const [retry, setRetry] = useState({ url: props.url, attempt: 0 });
  const attempt = retry.url === props.url ? retry.attempt : 0;
  return (
    <VideoPreviewAttempt
      {...props}
      key={`${props.url}:${attempt}`}
      autoPlay={props.autoPlay || attempt > 0}
      onRetry={() => setRetry({ url: props.url, attempt: attempt + 1 })}
    />
  );
}

function VideoPreviewAttempt({
  url, style, nativeControls = true, autoPlay = false, contentFit, onRetry,
}: VideoPreviewProps & { onRetry: () => void }) {
  const isFocused = useIsFocused();
  const { source } = useMediaSource(url);
  const player = useVideoPlayer(source, instance => {
    instance.loop = true;
    instance.muted = false;
    instance.audioMixingMode = 'auto';
    if (autoPlay && isFocused) instance.play();
  });
  // Stack navigation keeps earlier screens mounted. Their players must stop
  // even though useVideoPlayer's unmount cleanup has not run yet.
  useEffect(() => {
    if (!isFocused) player.pause();
  }, [isFocused, player]);
  const [status, setStatus] = useState<VideoPlayerStatus>(player.status);
  useEffect(() => {
    const subscription = player.addListener('statusChange', event => setStatus(event.status));
    setStatus(player.status);
    return () => subscription.remove();
  }, [player]);

  return (
    <View style={[style, { overflow: 'hidden' }]}>
      <VideoView
        player={player}
        nativeControls={nativeControls}
        contentFit={contentFit}
        style={{ width: '100%', height: '100%' }}
      />
      {status === 'loading' || status === 'idle' ? (
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator accessibilityLabel="Loading video" color={appTheme.colors.primary} />
        </View>
      ) : null}
      {status === 'error' ? (
        <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: appTheme.colors.panel, borderRadius: 20, padding: 20, gap: 12 }}>
            <Text accessibilityRole="alert" style={{ color: appTheme.colors.text, fontSize: 16, textAlign: 'center' }}>
              Video couldn’t load
            </Text>
            <SecondaryButton label="Retry video" onPress={onRetry} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
