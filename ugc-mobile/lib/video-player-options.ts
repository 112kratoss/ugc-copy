import type { PlayerBuilderOptions } from 'expo-video';

/** Native-build experiment. Old binaries ignore the iOS constructor option.
 * Keep this off in release exports until the physical-device gates pass.
 * Android keeps its existing ExoPlayer repeat path.
 */
export const MEDIA_PLAYER_OPTIONS: (PlayerBuilderOptions & { useSeamlessLooping: boolean }) | undefined = (
  process.env.EXPO_PUBLIC_SEAMLESS_VIDEO_LOOP === '1'
) ? { useSeamlessLooping: true } : undefined;
