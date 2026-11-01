import { createVideoPlayer, type VideoPlayer } from 'expo-video';

/**
 * How long a picked file's length may take to read before its upload goes on without one. A sound
 * file on the phone loads in a fraction of a second, and one the player cannot play fails at once;
 * this bounds only a load that never ends.
 */
export const MEDIA_FILE_LENGTH_DEADLINE_MS = 3_000;

/**
 * How long a player that says it is ready, with no length yet, is given to bring one. iOS sends its
 * load (`sourceLoad`) a moment after its status; a file the player can play but not time (a raw ADTS
 * .aac or an .amr on Android, which ExoPlayer cannot seek) brings none at all, and waiting out the
 * deadline kept its track off the rail for 3 s after the upload had finished.
 */
export const MEDIA_FILE_LENGTH_READY_GRACE_MS = 500;

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
 *
 * The length is the player's estimate, which for an MP3 runs a little long (an iPhone read a 1.500 s
 * file as 1.541 s): it may hold a track for being short, never for being long, and is not sent
 * (`reportedLengthSeconds` in generation-model-draft.ts).
 */
export async function readMediaFileLength(uri: string): Promise<number | null> {
  let player: VideoPlayer | null = null;
  try {
    player = createVideoPlayer({ uri });
    player.muted = true;
    // Never played, so it never needs the audio session; declared as every player's is (hig-full-screen.test.ts).
    player.audioMixingMode = 'auto';
    return await loadedLength(player);
  } catch {
    return null;
  } finally {
    try {
      player?.release();
    } catch {
      // A player that cannot be let go has nothing more to read; the length stands.
    }
  }
}

/**
 * A length a player reported, to the millisecond, or null for none: expo-video gives 0 before an item
 * has loaded, iOS NaN, and Android a large negative for a stream it cannot time. Android keeps a
 * duration in single precision (`player.duration / 1000f`), so a 1.9 s track arrives as 1.8999999761,
 * which a reading rounded down to the tenth would give as 1.8.
 */
function knownLength(seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000) / 1000
    : null;
}

/**
 * The length the player reports for its file once loaded: iOS sends its load (`sourceLoad`) a
 * moment after the item is ready, Android from the file's tracks, before it says it is ready. A
 * ready player with no length is given a short grace for one to arrive; an error ends the wait at
 * once, and the deadline bounds a load that never ends.
 */
function loadedLength(player: VideoPlayer): Promise<number | null> {
  return new Promise((resolve) => {
    const subscriptions: Array<{ remove: () => void }> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (seconds: number | null) => {
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.remove());
      resolve(seconds);
    };
    const giveUpIn = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(null), ms);
    };
    subscriptions.push(
      player.addListener('sourceLoad', ({ duration }) => {
        const length = knownLength(duration) ?? knownLength(player.duration);
        if (length !== null) finish(length);
      }),
      player.addListener('statusChange', ({ status }) => {
        if (status === 'error') {
          finish(null);
          return;
        }
        if (status !== 'readyToPlay') return;
        const length = knownLength(player.duration);
        if (length !== null) finish(length);
        else giveUpIn(MEDIA_FILE_LENGTH_READY_GRACE_MS);
      }),
    );
    giveUpIn(MEDIA_FILE_LENGTH_DEADLINE_MS);
  });
}
