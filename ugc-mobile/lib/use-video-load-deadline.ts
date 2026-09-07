import { useEffect, useState } from 'react';
import type { VideoPlayer, VideoPlayerStatus } from 'expo-video';

/** Stop a stalled native transport without issuing automatic retry requests. */
export function useVideoLoadDeadline(player: VideoPlayer, status: VideoPlayerStatus) {
  const [timedOutPlayer, setTimedOutPlayer] = useState<VideoPlayer | null>(null);
  const timedOut = timedOutPlayer === player;
  useEffect(() => {
    if (timedOut || (status !== 'loading' && status !== 'idle')) return;
    const timer = setTimeout(() => {
      setTimedOutPlayer(player);
      player.pause();
      void player.replaceAsync(null).catch(() => undefined);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [player, status, timedOut]);
  return timedOut;
}
