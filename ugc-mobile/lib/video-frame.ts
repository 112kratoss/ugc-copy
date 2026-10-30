import { createVideoPlayer, type BufferOptions, type VideoPlayer, type VideoThumbnail } from 'expo-video';
import { Platform } from 'react-native';

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

/** How long one still may take before the next read starts anyway. */
export const VIDEO_FRAME_DEADLINE_MS = 15_000;

/**
 * The player is never shown or played, and the still does not come from its
 * load: Android reads it with a MediaMetadataRetriever of its own. ExoPlayer
 * still starts loading the clip the moment the player is made, 50 seconds
 * ahead by default, so it is asked to stop as soon as anything is buffered.
 * iOS reads only the forward duration.
 */
const FRAME_PLAYER_BUFFER: BufferOptions = {
  preferredForwardBufferDuration: 1,
  maxBufferBytes: 1,
  prioritizeTimeOverSizeThreshold: false,
  minBufferForPlayback: 0,
};

let queue: Promise<unknown> = Promise.resolve();

/**
 * One still from the clip at `url`, for a card that shows what a video is
 * without playing it, or null when the clip gives none.
 *
 * expo-video reads it with no view on screen: Android's MediaMetadataRetriever
 * on the link, iOS's AVAssetImageGenerator on the player's item. Both are in
 * every binary, so this needs no new native module. Reads run one at a time
 * across the app, since each holds a player (and on Android a decoder) beside
 * whatever the reel is playing; a read called off before its turn makes none.
 */
export function grabVideoFrame(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<VideoThumbnail | null> {
  const turn = queue.then(() => (signal?.aborted ? null : readWithDeadline(url, signal)));
  queue = turn.catch(() => undefined);
  return turn.catch(() => null);
}

async function readWithDeadline(url: string, outer: AbortSignal | undefined) {
  const controller = new AbortController();
  const callOff = () => controller.abort();
  outer?.addEventListener('abort', callOff);
  const deadline = setTimeout(callOff, VIDEO_FRAME_DEADLINE_MS);
  try {
    // Android's read cannot be stopped once it has started, so the queue moves
    // on when the read is called off rather than when it returns.
    return await Promise.race([readFrame(url, controller.signal), calledOff(controller.signal)]);
  } finally {
    clearTimeout(deadline);
    outer?.removeEventListener('abort', callOff);
  }
}

async function readFrame(url: string, signal: AbortSignal) {
  const player = createVideoPlayer({ uri: url });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    player.release();
  };
  signal.addEventListener('abort', release);
  try {
    player.muted = true;
    // Never played, so it never needs the audio session; declared as every player's is (hig-full-screen.test.ts).
    player.audioMixingMode = 'auto';
    player.bufferOptions = FRAME_PLAYER_BUFFER;
    // iOS gives the player its item only once the asset has loaded, and until
    // then answers a request for stills with none at all.
    if (Platform.OS === 'ios') await itemLoaded(player, signal);
    const [frame] = await player.generateThumbnailsAsync(VIDEO_FRAME_TIME_SECONDS, {
      maxWidth: VIDEO_FRAME_MAX_SIDE,
      maxHeight: VIDEO_FRAME_MAX_SIDE,
    });
    return signal.aborted ? null : frame ?? null;
  } finally {
    signal.removeEventListener('abort', release);
    release();
  }
}

function calledOff(signal: AbortSignal) {
  return new Promise<null>((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', () => resolve(null));
  });
}

function itemLoaded(player: VideoPlayer, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const subscriptions = [
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
    else if (player.status === 'readyToPlay') settle();
  });
}
