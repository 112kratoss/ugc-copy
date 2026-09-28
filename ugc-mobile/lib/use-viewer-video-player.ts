import { useVideoPlayer, type VideoPlayer, type VideoSource } from 'expo-video';

import { MEDIA_PLAYER_OPTIONS } from './video-player-options';

/** Other platforms keep Expo's existing automatic player lifetime. */
export function useViewerVideoPlayer(source: VideoSource, setup: (player: VideoPlayer) => void) {
  return useVideoPlayer(source, player => {
    player.audioMixingMode = 'auto';
    setup(player);
  }, MEDIA_PLAYER_OPTIONS);
}
