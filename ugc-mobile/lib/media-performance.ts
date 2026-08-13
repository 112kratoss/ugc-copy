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
 */
export const FEED_PREVIEW_FORWARD_BUFFER_SECONDS = 8;
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
