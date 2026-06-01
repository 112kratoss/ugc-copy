import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

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
    <View
      style={{
        height,
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: `${accent}4d`,
        backgroundColor: '#050506',
        overflow: 'hidden',
      }}
    >
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="cover"
        fullscreenOptions={{ enable: false }}
        allowsPictureInPicture={false}
        startsPictureInPictureAutomatically={false}
        useExoShutter={false}
        surfaceType="textureView"
        onFirstFrameRender={() => setHasFrame(true)}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#050506',
        }}
      />
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
    </View>
  );
}
