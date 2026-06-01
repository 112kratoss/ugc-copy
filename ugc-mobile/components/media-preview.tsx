import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
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
}: {
  url: string | null | undefined;
  kind?: 'image' | 'video' | null;
  height?: number;
  radius?: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [url]);

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
    <Image
      source={{ uri: url }}
      contentFit="cover"
      onError={() => setImageFailed(true)}
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
    instance.muted = true;
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
