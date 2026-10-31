import { Image } from 'expo-image';
import type { VideoThumbnail } from 'expo-video';
import { Platform } from 'react-native';

/**
 * A clip's still (`lib/use-video-stills.ts`), filling its card's media. The
 * card draws its play mark over it.
 */
export function VideoStill({ still }: { still: VideoThumbnail }) {
  return (
    <Image
      accessible={false}
      contentFit="cover"
      source={still}
      style={{ position: 'absolute', inset: 0 }}
      // The same synchronous swap on Android as StableMediaImage, for the same reason.
      transition={Platform.OS === 'android' ? 0 : 120}
    />
  );
}
