import type { VideoPlayer } from 'expo-video';

/** A new URL for the same media must preserve the viewer's playback decision. */
export function restoreVideoPlayback(
  player: VideoPlayer,
  previous: VideoPlayer | null,
  autoPlay: boolean,
  allowed: boolean,
) {
  if (previous) {
    player.currentTime = previous.currentTime;
    player.muted = previous.muted;
    player.volume = previous.volume;
    player.playbackRate = previous.playbackRate;
  }
  // Set this last: changing playbackRate can start AVPlayer on iOS.
  if (allowed && (previous ? previous.playing : autoPlay)) player.play();
  else player.pause();
}
