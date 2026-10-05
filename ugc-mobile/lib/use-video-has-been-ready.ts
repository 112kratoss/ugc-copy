import { useEffect, useState } from 'react';
import type { VideoPlayer, VideoPlayerStatus } from 'expo-video';

/**
 * Whether this player's clip has been able to play. It stays true while the
 * clip buffers again, and is false again for a new player, which loads from
 * nothing. On Android a renewed link is handed to the player already there
 * (see useVideoSourceAfterSurface), so it stays true while that clip loads too.
 */
export function useVideoHasBeenReady(player: VideoPlayer) {
  const [readyPlayer, setReadyPlayer] = useState<VideoPlayer | null>(null);
  useEffect(() => {
    const note = (status: VideoPlayerStatus) => {
      if (status === 'readyToPlay') setReadyPlayer(player);
    };
    const subscription = player.addListener('statusChange', event => note(event.status));
    note(player.status);
    return () => subscription.remove();
  }, [player]);
  return readyPlayer === player;
}
