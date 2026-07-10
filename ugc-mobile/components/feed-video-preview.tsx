import { useVideoPlayer } from 'expo-video';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Play } from 'lucide-react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { appTheme } from '@/lib/theme';

export function FeedVideoPreview({
  url,
  previewUrl,
  previewCacheKey,
  previewThumbhash,
  active,
  height,
  radius,
  accent,
}: {
  url: string;
  previewUrl?: string | null;
  previewCacheKey?: string;
  previewThumbhash?: string | null;
  active: boolean;
  height: number;
  radius: number;
  accent: string;
}) {
  if (!active) {
    if (previewUrl) {
      return (
      <FeedMediaFrame
        kind="image"
        url={previewUrl}
        backdropUrl={previewUrl}
        cacheKey={previewCacheKey}
        thumbhash={previewThumbhash}
        radius={radius}
        borderWidth={1}
        borderColor={`${accent}4d`}
        backgroundColor="#050506"
        recyclingKey={`${url}:poster`}
        style={{ height }}
      />
      );
    }

    return (
      <View
        style={{
          height,
          borderRadius: radius,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#050506',
        }}
      >
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
    );
  }

  return (
    <ActiveFeedVideoPreview
      url={url}
      previewUrl={previewUrl}
      previewCacheKey={previewCacheKey}
      previewThumbhash={previewThumbhash}
      height={height}
      radius={radius}
      accent={accent}
    />
  );
}

function ActiveFeedVideoPreview({
  url,
  previewUrl,
  previewCacheKey,
  previewThumbhash,
  height,
  radius,
  accent,
}: {
  url: string;
  previewUrl?: string | null;
  previewCacheKey?: string;
  previewThumbhash?: string | null;
  height: number;
  radius: number;
  accent: string;
}) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [errorUrl, setErrorUrl] = useState<string | null>(null);
  const hasFrame = frameUrl === url;
  const hasError = errorUrl === url;
  const player = useVideoPlayer({ uri: url, useCaching: true }, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.volume = 0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
  });

  useEffect(() => {
    player.play();
  }, [player]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', (event) => {
      setErrorUrl(event.status === 'error' ? url : null);
    });
    return () => {
      subscription.remove();
    };
  }, [player, url]);

  return (
    <FeedMediaFrame
      kind="video"
      player={player}
      backdropUrl={previewUrl}
      posterUrl={previewUrl}
      posterVisible={Boolean(previewUrl && (!hasFrame || hasError))}
      cacheKey={previewCacheKey}
      thumbhash={previewThumbhash}
      radius={radius}
      borderWidth={1}
      borderColor={`${accent}4d`}
      backgroundColor="#050506"
      recyclingKey={url}
      onFirstFrameRender={() => {
        setFrameUrl(url);
        setErrorUrl(null);
      }}
      style={{
        height,
      }}
    >
      {!hasFrame && !hasError ? (
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
