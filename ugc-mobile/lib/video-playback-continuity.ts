import type { VideoPlayer } from 'expo-video';

/**
 * A new URL for the same media must preserve the viewer's playback decision.
 * Returns whether playback was requested on the new player.
 */
export function restoreVideoPlayback(
  player: VideoPlayer,
  previous: VideoPlayer | null,
  autoPlay: boolean,
  allowed: boolean,
): boolean {
  if (previous) {
    player.currentTime = previous.currentTime;
    player.muted = previous.muted;
    player.volume = previous.volume;
    player.playbackRate = previous.playbackRate;
  }
  // Set this last: changing playbackRate can start AVPlayer on iOS.
  const resume = allowed && (previous ? wantsPlayback(previous) : autoPlay);
  if (resume) player.play();
  else player.pause();
  return resume;
}

/**
 * The replaced player's own request. `playing` turns true only once the native
 * player renders, so a player still loading (the viewer re-signs its source
 * about a second after opening) or one that failed reports `false` while its
 * request stands. Only a player that was ready and not playing had actually
 * been stopped; explicit pauses and the background gate arrive as `allowed`.
 */
function wantsPlayback(previous: VideoPlayer): boolean {
  return previous.playing || previous.status !== 'readyToPlay';
}
