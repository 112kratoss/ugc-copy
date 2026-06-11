import { useVideoPlayer } from 'expo-video';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { appTheme } from '@/lib/theme';

export function FeedVideoPreview({
  url,
  active,
  height,
  radius,
  accent,
}: {
  url: string;
  active: boolean;
  height: number;
  radius: number;
  accent: string;
}) {
  const [hasFrame, setHasFrame] = useState(false);
  const player = useVideoPlayer(url, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.volume = 0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
  });

  useEffect(() => {
    setHasFrame(false);
  }, [url]);

  useEffect(() => {
    if (active) {
      player.play();
    } else {
      player.pause();
    }
  }, [active, player]);

  return (
    <FeedMediaFrame
      kind="video"
      player={player}
      radius={radius}
      borderWidth={1}
      borderColor={`${accent}4d`}
      backgroundColor="#050506"
      onFirstFrameRender={() => setHasFrame(true)}
      style={{
        height,
      }}
    >
      {!hasFrame ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            inset: 0,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: `${appTheme.colors.background}66`,
          }}
        >
          <ActivityIndicator color={accent} />
        </View>
      ) : null}
    </FeedMediaFrame>
  );
}
