import { createVideoPlayer } from 'expo-video';
import { AppState } from 'react-native';

import { createAudioPlaybackStore, type CreateAudioPlayer } from './audio-creation-playback';

/** How often the player reports its position; the progress bar glides between reports. */
export const AUDIO_PROGRESS_INTERVAL_SECONDS = 0.25;

let watchingAppState = false;

/**
 * Stops the sound when the app leaves the foreground.
 *
 * expo-video does not do it for this player: it pauses a backgrounded player
 * by walking its video views, and this one is attached to none. On Android a
 * voiceover played on behind the launcher, with no control on screen to stop
 * it (Pixel 9a emulator, 2026-10-02). With this listener the sound stops
 * within a second there, and on iOS as the app goes inactive (iPhone
 * simulator, same day); the position holds, and coming back starts nothing.
 */
function stopWhenAppLeavesForeground() {
  if (watchingAppState) return;
  watchingAppState = true;
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') audioCreationPlayback.suspend();
  });
}

/**
 * An audio creation is played by the video player the app already ships.
 *
 * expo-video's player is AVPlayer on iOS and ExoPlayer on Android, and both
 * play a sound file with no view attached, so this needs no audio module and
 * no new binary: expo-audio and expo-av have never been in a store build, and
 * adding either would hold the fix behind a store release.
 */
const createNativeAudioPlayer: CreateAudioPlayer = (url, events) => {
  stopWhenAppLeavesForeground();
  // Read straight from the network, not through the video cache: on iOS that
  // cache answers any response whose type is not a video type with an
  // unsupported-format error, so a cached sound file would never play there.
  // The rule the cache exists for (video-player-cache-coverage.test.ts) is
  // about looping players re-downloading their clip; this one never loops.
  const player = createVideoPlayer({ uri: url });
  player.loop = false;
  player.timeUpdateEventInterval = AUDIO_PROGRESS_INTERVAL_SECONDS;
  player.showNowPlayingNotification = false;
  player.staysActiveInBackground = false;
  // The same choice as the reel's own player: the audio session is held only
  // while this is making sound, and this never plays unless it was tapped.
  player.audioMixingMode = 'auto';

  const knownDuration = () => (player.duration > 0 ? player.duration : null);
  const subscriptions = [
    player.addListener('statusChange', ({ status }) => {
      // `idle` is what a finished file reports; the end arrives as `playToEnd`.
      if (status === 'loading') events.onStatus('loading');
      else if (status === 'readyToPlay') events.onStatus('ready');
      else if (status === 'error') events.onStatus('error');
    }),
    player.addListener('sourceLoad', ({ duration }) => {
      events.onProgress(player.currentTime, duration > 0 ? duration : null);
    }),
    player.addListener('playingChange', ({ isPlaying }) => events.onPlayingChange(isPlaying)),
    player.addListener('timeUpdate', ({ currentTime }) => events.onProgress(currentTime, knownDuration())),
    player.addListener('playToEnd', () => events.onEnded()),
  ];

  return {
    play: () => player.play(),
    pause: () => player.pause(),
    seekTo: (seconds) => {
      player.currentTime = seconds;
    },
    release: () => {
      subscriptions.forEach((subscription) => subscription.remove());
      player.release();
    },
  };
};

/** The app's one audio creation player. */
export const audioCreationPlayback = createAudioPlaybackStore(createNativeAudioPlayer);
