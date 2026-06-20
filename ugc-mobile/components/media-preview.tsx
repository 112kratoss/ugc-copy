import { Image, type ImageProps } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ImageOff } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { appTheme } from '@/lib/theme';

export function MediaPreview({
  url,
  kind,
  height,
  radius = appTheme.radii.lg,
}: {
  url: string | null | undefined;
  kind?: 'image' | 'video' | null;
  height?: number;
  radius?: number;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageFailed = failedUrl === url;

  if (!url) {
    return <MediaFallback height={height} radius={radius} label="No media" />;
  }

  if (kind === 'video') {
    return <VideoPreview url={url} height={height} radius={radius} />;
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
    <LinearGradient
      colors={['#0b1022', '#12071c', '#050506']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        height,
        borderRadius: radius,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <ImageOff size={28} color="#ffffff" strokeWidth={2.2} />
      <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '900' }}>{label}</Text>
    </LinearGradient>
  );
}

function VideoPreview({ url, height, radius }: { url: string; height?: number; radius: number }) {
  const player = useVideoPlayer(url, (instance) => {
    instance.loop = true;
    instance.muted = false;
  });

  return (
    <VideoView
      player={player}
      nativeControls
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
