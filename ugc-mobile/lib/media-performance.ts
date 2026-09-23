export const IMMERSIVE_DETAILS_PRESENTATION = 'sheet' as const;

export const IMMERSIVE_VERTICAL_LIST_TUNING = {
  initialNumToRender: 1,
  maxToRenderPerBatch: 2,
  windowSize: 3,
} as const;

export const IMMERSIVE_HORIZONTAL_LIST_TUNING = {
  initialNumToRender: 1,
  maxToRenderPerBatch: 2,
  windowSize: 3,
} as const;

/**
 * How far past the viewport FlashList mounts showcase cells, in dp.
 *
 * 500 was roughly two masonry rows, so a normal flick outran it and landed on
 * cells that were still mounting. ~900 keeps three to four rows staged ahead
 * without changing what actually streams: feed cards are poster-only, and
 * autoplay stays capped at SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS by viewability,
 * so the extra staged cells cost small preview images, not video.
 */
export const SHOWCASE_DRAW_DISTANCE = 900;
export const SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS = 1;

/**
 * How far ahead a feed preview may buffer, in seconds.
 *
 * ExoPlayer defaults to 20s of forward buffer on Android, so a single
 * activation downloads 20s of video no matter how briefly it is watched — and
 * for a clip whose rendition failed (long sources time out at 120s of ffmpeg
 * and then fall back to the full-size original) that is the most expensive
 * request the feed can make. A preview is glanced at, not watched, so 8s keeps
 * the loop seamless while cutting the worst case roughly by a third.
 *
 * Feed only. The immersive viewer keeps ExoPlayer's defaults, because there
 * the user has chosen to watch and stalling matters more than bytes.
 *
 * Set once, when a tile's player is created, and never changed while it
 * lives: a prepared player (SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS) buffers as
 * far ahead as a playing one. Prepared players used to hold 3s and widen to
 * this on playing, then narrow again on pausing. On iOS each change is a
 * media-server request on the player's queue, and AVFoundation's main-thread
 * notification handler can end up waiting on that same queue. So a handoff
 * onto a video that was still loading, which is what scrolling onto a new
 * card produces, froze scrolling for 40–80ms on the iPhone 16e, and the same
 * handoff with the target left alone did not (alternated runs, 2026-09-23).
 * The price is at most 5s more of a clip the reader scrolls past before it
 * plays; most feed clips are shorter than 8s anyway.
 */
export const FEED_PREVIEW_FORWARD_BUFFER_SECONDS = 8;

/**
 * How many feed videos beside the playing one keep a paused, loaded player.
 *
 * Creating a player on activation costs a fetch plus a decoder setup, and in a
 * feed that reads as the tile sitting on its poster before it moves. Two cover
 * a scroll in either direction: the nearest video below the playing one and the
 * nearest above it. The video being scrolled away from keeps its player only
 * while nothing else plays, so the feed holds at most three players — plus, for
 * a moment in each handoff, the outgoing one waiting out its release grace.
 * Hardware decoders are a hard per-device limit: the Pixel emulator refuses a
 * fifth, which an earlier selection that briefly held five ran into.
 */
export const SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS = 2;

/**
 * How long an active feed video may take to draw its first frame before the
 * tile shows a spinner, in milliseconds.
 *
 * A prepared video starts at once and a cold one usually draws well inside a
 * second; a spinner that flashes up for those reads as the tile blinking. A
 * second is where a wait stops feeling immediate, so only a genuinely slow
 * start admits it is loading.
 */
export const FEED_PREVIEW_BUFFERING_INDICATOR_DELAY_MS = 1000;

export const HOME_RAIL_DRAW_DISTANCE = 400;

/**
 * Auto-retry policy for a failed image load in StableMediaImage.
 *
 * Given the number of attempts that have already failed for the current
 * source (0 = the first load just failed), return how many milliseconds to
 * wait before retrying, or null to stop. On null the component latches the
 * failure UI (thumbhash tile + tap to retry) and notifies its parent, which
 * may fall back to another URL.
 *
 * Constraints to weigh:
 * - A feed screen can hold many failed tiles at once during an outage; every
 *   retry is a network request against the same CDN.
 * - Most real-world failures are sub-second blips or brief connectivity
 *   drops; retries past ~2 attempts rarely succeed and cost battery/data.
 * - Identical delays synchronize retries across tiles (thundering herd);
 *   jitter desynchronizes them.
 */
const IMAGE_RETRY_MAX_ATTEMPTS = 2;
const IMAGE_RETRY_BASE_DELAY_MS = 900;

export function imageRetryDelayMs(attempt: number): number | null {
  if (attempt >= IMAGE_RETRY_MAX_ATTEMPTS) return null;
  // ~0.9s then ~2.7s: the first retry catches sub-second blips, the second
  // brief connectivity drops. Giving up after two hands recovery to the next
  // layer (URL fallback, then the thumbhash tile with tap-to-retry) instead
  // of hammering a dead network.
  const backoff = IMAGE_RETRY_BASE_DELAY_MS * 3 ** attempt;
  // Up to +50% jitter so tiles that failed together (one outage, many cards)
  // don't stampede the CDN in sync when they come back.
  return backoff + Math.random() * backoff * 0.5;
}
