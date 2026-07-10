import { Image, type ImageProps } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ImageOff } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { appTheme } from '@/lib/theme';

export function MediaPreview({
  url,
  kind,
  height,
  radius = appTheme.radii.lg,
  nativeControls = true,
}: {
  url: string | null | undefined;
  kind?: 'image' | 'video' | null;
  height?: number;
  radius?: number;
  nativeControls?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageFailed = failedUrl === url;

  if (!url) {
    return <MediaFallback height={height} radius={radius} label="No media" />;
  }

  if (kind === 'video') {
    return <VideoPreview url={url} height={height} radius={radius} nativeControls={nativeControls} />;
  }

  if (imageFailed) {
    return <MediaFallback height={height} radius={radius} label="Preview unavailable" />;
  }

  return (
    <StableMediaImage
      url={url}
      cacheKey={url}
      contentFit="cover"
      onError={() => setFailedUrl(url)}
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        height,
        borderRadius: radius,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: '#050506',
      }}
    />
  );
}

export function StableMediaImage({
  url,
  cacheKey,
  thumbhash,
  contentFit = 'cover',
  onDisplay,
  onError,
  style,
  transition = 120,
}: {
  url: string;
  cacheKey: string;
  thumbhash?: string | null;
  contentFit?: ImageProps['contentFit'];
  onDisplay?: ImageProps['onDisplay'];
  onError?: ImageProps['onError'];
  style?: ImageProps['style'];
  transition?: number;
}) {
  const [failedCacheKey, setFailedCacheKey] = useState<string | null>(null);

  useEffect(() => {
    void Image.prefetch(url, 'memory-disk');
  }, [cacheKey, url]);

  if (failedCacheKey === cacheKey) {
    return <MediaFallback radius={0} label="Preview unavailable" />;
  }

  return (
    <Image
      key={cacheKey}
      source={{ uri: url, cacheKey }}
      placeholder={thumbhash ? { thumbhash } : undefined}
      placeholderContentFit={contentFit}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      recyclingKey={cacheKey}
      transition={transition}
      onDisplay={onDisplay}
      onError={(event) => {
        setFailedCacheKey(cacheKey);
        onError?.(event);
      }}
      pointerEvents="none"
      style={style}
    />
  );
}

function MediaFallback({ height, radius, label }: { height?: number; radius: number; label: string }) {
  return (
    <View
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        height,
        borderRadius: radius,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.surfaceInset,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <ImageOff size={28} color={appTheme.colors.faint} strokeWidth={2.2} />
      <Text style={{ color: appTheme.colors.textSecondary, fontSize: 12, fontWeight: '800' }}>{label}</Text>
    </View>
  );
}

function VideoPreview({
  url,
  height,
  radius,
  nativeControls,
}: {
  url: string;
  height?: number;
  radius: number;
  nativeControls: boolean;
}) {
  const player = useVideoPlayer(url, (instance) => {
    instance.loop = true;
    instance.muted = false;
  });

  return (
    <VideoView
      player={player}
      nativeControls={nativeControls}
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        height,
        borderRadius: radius,
        backgroundColor: '#050506',
      }}
    />
  );
}
