import { createVideoPlayer, type VideoPlayer } from 'expo-video';

/**
 * How long a picked file's length may take to read before its upload goes on without one. A sound
 * file on the phone loads in a fraction of a second, and one the player cannot play fails at once;
 * this bounds only a load that never ends.
 */
export const MEDIA_FILE_LENGTH_DEADLINE_MS = 3_000;

/**
 * A picked sound file's length in seconds, or null where the phone cannot tell: its player could
 * not load it (a format the phone does not play), reported no length, or took longer than the
 * deadline. A track with no known length is left to the start, which measures the file. Never
 * rejects, so a failed read never fails the upload beside it.
 *
 * DocumentPicker reports no length, and the app has no audio module: expo-audio and expo-av have
 * never been in a store build, so adding either would hold this behind one. So the file is opened in
 * the video player the app already ships, as an audio creation is played
 * (`audio-creation-native-player.ts`): AVPlayer on iOS and ExoPlayer on Android load a sound file
 * with no view attached, and report its length once loaded. The player is muted and never played,
 * so it takes no audio session from music playing on the phone, and it is let go once the length is
 * read. A file picked into the app's cache is read from there, not through the video cache.
 */
export async function readMediaFileLength(uri: string, deadlineMs = MEDIA_FILE_LENGTH_DEADLINE_MS): Promise<number | null> {
  let player: VideoPlayer | null = null;
  try {
    player = createVideoPlayer({ uri });
    player.muted = true;
    // Never played, so it never needs the audio session; declared as every player's is (hig-full-screen.test.ts).
    player.audioMixingMode = 'auto';
    return await loadedLength(player, deadlineMs);
  } catch {
    return null;
  } finally {
    player?.release();
  }
}

/** A length a player reported, or null for none: expo-video gives 0 before an item has loaded, and iOS NaN. */
function knownLength(seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * The length the player reports for its file once loaded. iOS reports it as the item becomes ready
 * (`sourceLoad`, with NaN for an item not yet timed), Android once the file's tracks are read, which
 * can come after the player says it is ready; so a ready player with no length yet is waited past,
 * and only an error or the deadline ends the wait without one.
 */
function loadedLength(player: VideoPlayer, deadlineMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const subscriptions: Array<{ remove: () => void }> = [];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (seconds: number | null) => {
      clearTimeout(deadline);
      subscriptions.forEach((subscription) => subscription.remove());
      resolve(seconds);
    };
    const answer = (seconds: unknown) => {
      const length = knownLength(seconds);
      if (length !== null) finish(length);
    };
    subscriptions.push(
      player.addListener('sourceLoad', ({ duration }) => answer(knownLength(duration) ?? player.duration)),
      player.addListener('statusChange', ({ status }) => {
        if (status === 'readyToPlay') answer(player.duration);
        else if (status === 'error') finish(null);
      }),
    );
    deadline = setTimeout(() => finish(null), deadlineMs);
  });
}
