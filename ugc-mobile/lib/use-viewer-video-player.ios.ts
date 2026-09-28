import { createVideoPlayer, type VideoPlayer, type VideoSource } from 'expo-video';
import { useEffect, useRef } from 'react';

import { MEDIA_PLAYER_OPTIONS } from './video-player-options';
import { endVideoReturn, isVideoPlayerHandedBack, ownViewerVideoPlayer, releaseAdoptedVideoPlayer } from './video-player-loans';

/**
 * Like useVideoPlayer, but ownership may pass to a tile on close. The standard
 * hook always releases on unmount, including a player the tile is still drawing.
 */
export function useViewerVideoPlayer(source: VideoSource, setup: (player: VideoPlayer) => void) {
  const key = JSON.stringify(source);
  const create = () => {
    const player = createVideoPlayer(source, MEDIA_PLAYER_OPTIONS);
    player.audioMixingMode = 'auto';
    ownViewerVideoPlayer(player);
    setup(player);
    return { key, player };
  };
  // The native object is created once, including Strict Mode's double render.
  // Mirrors Expo's useReleasingSharedObject without its unconditional release.
  const slot = useRef<ReturnType<typeof create> | null>(null);
  if (!slot.current || slot.current.key !== key) slot.current = create();
  const { player } = slot.current;
  const releases = useRef(new Map<VideoPlayer, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = releases.current;
    const pending = timers.get(player);
    if (pending) clearTimeout(pending);
    timers.delete(player);
    return () => {
      // Decide ownership now. A rapid reopen may lend this same player to a
      // new viewer before a delayed cleanup runs; the old viewer must not
      // release the new viewer's loan.
      const transferred = isVideoPlayerHandedBack(player);
      if (transferred) endVideoReturn(player);
      // Allow native views to detach, and Strict Mode/Fast Refresh to reattach.
      timers.set(player, setTimeout(() => {
        timers.delete(player);
        if (!transferred) releaseAdoptedVideoPlayer(player);
      }, 100));
    };
  }, [player]);
  return player;
}
