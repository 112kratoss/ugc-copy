import { requireOptionalNativeModule } from 'expo';
import { createVideoPlayer, type BufferOptions, type VideoPlayer, type VideoThumbnail } from 'expo-video';
import { Platform } from 'react-native';

type FrameSize = { maxWidth: number; maxHeight: number };

/**
 * expo-video's read of a still with no player, which only an Android binary
 * built with `experiments/android-remote-video-still/` carries (its README).
 * Stock expo-video 55 opens the clip's link for a still with a
 * MediaMetadataRetriever on the one thread every Expo module's async calls
 * share (`expo.modules.AsyncFunctionQueue`), so a slow or stalled link held
 * up session reads, haptics, the clipboard and the viewer's own clip for as
 * long as the open took, and a deadline here cannot free that thread. This
 * one opens it on the IO dispatcher.
 */
type PlayerlessStillReader = {
  generateThumbnailFromUrlAsync(url: string, timeSeconds: number, options: FrameSize): Promise<VideoThumbnail>;
};

/**
 * Looked for once, on Android, by the function rather than by a build number:
 * a dev client built with the patch has it as a store build will, and an
 * update reaching a binary without it finds nothing.
 */
function findPlayerlessStillReader(): PlayerlessStillReader | null {
  if (Platform.OS !== 'android') return null;
  const expoVideo = requireOptionalNativeModule<Partial<PlayerlessStillReader>>('ExpoVideo');
  return typeof expoVideo?.generateThumbnailFromUrlAsync === 'function' ? (expoVideo as PlayerlessStillReader) : null;
}

const playerlessReader = findPlayerlessStillReader();

/**
 * Whether this binary reads stills at all. iOS reads them from a player that
 * is never shown, in Swift's own concurrency; Android only where the binary
 * reads them without one, off the shared thread (above). Elsewhere a clip
 * keeps its plain play mark.
 */
export const VIDEO_STILLS_READ = Platform.OS === 'ios' || playerlessReader !== null;

/**
 * Where in the clip the still is taken. The web's reference gallery asks the
 * browser for the same moment (`#t=0.1`), just past a first frame that is
 * often black.
 */
export const VIDEO_FRAME_TIME_SECONDS = 0.1;

/**
 * The still's longest side, in pixels. A reference card is 142×166pt: at 3×
 * this covers a portrait clip outright and a 16:9 one within about 1.2×, for
 * about 1.3 MB of bitmap a still.
 */
export const VIDEO_FRAME_MAX_SIDE = 720;

const FRAME_SIZE: FrameSize = { maxWidth: VIDEO_FRAME_MAX_SIDE, maxHeight: VIDEO_FRAME_MAX_SIDE };

/** How long one still may take before the next read starts anyway. */
export const VIDEO_FRAME_DEADLINE_MS = 15_000;

/**
 * The player is never shown or played, and the still does not come from what
 * it buffers, so its item is asked to buffer no more than a second ahead.
 */
const FRAME_PLAYER_BUFFER: BufferOptions = { preferredForwardBufferDuration: 1 };

let queue: Promise<void> = Promise.resolve();

/**
 * One still from the clip at `url`, for a card that shows what a video is
 * without playing it, or null when there is none to be had: the clip gave
 * none, failed to load, took longer than the deadline, or the read was called
 * off.
 *
 * On iOS expo-video reads it with no view on screen, with
 * AVAssetImageGenerator on the item of a player that is never played; on
 * Android with a MediaMetadataRetriever and no player at all. Reads run one at
 * a time across the app, since each opens a clip beside whatever the reel is
 * playing; a read called off before its turn makes none.
 */
export function grabVideoFrame(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<VideoThumbnail | null> {
  if (!VIDEO_STILLS_READ) return Promise.resolve(null);
  const turn = queue
    .then(() => (signal?.aborted ? null : readStill(url, signal)))
    .catch(() => null);
  // The queue keeps the turn, not the still it read.
  queue = turn.then(() => undefined);
  return turn;
}

function readStill(url: string, outer: AbortSignal | undefined) {
  if (!playerlessReader) return readFromPlayer(url, outer);
  // Nothing native to let go: a read called off finishes on its own thread, and its still is dropped.
  return untilCalledOff(outer, () => playerlessReader.generateThumbnailFromUrlAsync(url, VIDEO_FRAME_TIME_SECONDS, FRAME_SIZE));
}

async function readFromPlayer(url: string, outer: AbortSignal | undefined) {
  const player = createVideoPlayer({ uri: url });
  try {
    return await untilCalledOff(outer, (signal) => readFrame(player, signal));
  } finally {
    player.release();
  }
}

/** The read's still, or null once it is called off or its deadline passes, whichever comes first. */
async function untilCalledOff(outer: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<VideoThumbnail | null>) {
  const controller = new AbortController();
  const callOff = () => controller.abort();
  outer?.addEventListener('abort', callOff);
  const deadline = setTimeout(callOff, VIDEO_FRAME_DEADLINE_MS);
  try {
    // A still request already sent cannot be taken back, so the queue moves
    // on when the read is called off rather than when it returns.
    return await Promise.race([read(controller.signal), calledOff(controller.signal)]);
  } finally {
    clearTimeout(deadline);
    outer?.removeEventListener('abort', callOff);
  }
}

async function readFrame(player: VideoPlayer, signal: AbortSignal) {
  player.muted = true;
  // Never played, so it never needs the audio session; declared as every player's is (hig-full-screen.test.ts).
  player.audioMixingMode = 'auto';
  player.bufferOptions = FRAME_PLAYER_BUFFER;
  // iOS gives the player its item only once the asset has loaded, and until
  // then answers a request for stills with none at all.
  await itemAttached(player, signal);
  const [frame] = await player.generateThumbnailsAsync(VIDEO_FRAME_TIME_SECONDS, FRAME_SIZE);
  return frame ?? null;
}

function calledOff(signal: AbortSignal) {
  return new Promise<null>((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', () => resolve(null));
  });
}

/**
 * Resolves once the player has its item. That is all a still needs, so it
 * does not wait for anything to buffer: `sourceChange` arrives as the item is
 * attached, before `sourceLoad` (which needs some buffered) or `readyToPlay`
 * (which a player never played may not reach on a slow link).
 */
function itemAttached(player: VideoPlayer, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const subscriptions = [
      player.addListener('sourceChange', ({ source }) => {
        if (source) settle();
      }),
      player.addListener('sourceLoad', () => settle()),
      player.addListener('statusChange', ({ status, error }) => {
        if (status === 'readyToPlay') settle();
        else if (status === 'error') settle(new Error(error?.message ?? 'The clip did not load.'));
      }),
    ];
    const onAbort = () => settle(new Error('The still was called off.'));
    signal.addEventListener('abort', onAbort);
    function settle(error?: Error) {
      if (settled) return;
      settled = true;
      subscriptions.forEach((subscription) => subscription.remove());
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    if (signal.aborted) onAbort();
  });
}
