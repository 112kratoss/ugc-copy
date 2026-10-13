import { createFeedDeliveryOnceGate } from './feed-attention-view-model';
import { SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY } from './showcase-feed-events';

/**
 * Below this a reel landing is a pass-through, not a skip: a flick across
 * several posts rests on each for a frame or two. The web reel's floor, so a
 * `quick_skip` means the same thing from both clients (audit 03-3).
 */
export const REEL_QUICK_SKIP_MIN_MS = 250;

/**
 * What the reel files as the reader leaves a post they were on for
 * `durationMs`: a dwell from the qualified impression's second on, a quick
 * skip from 250 ms, and nothing below that.
 */
export function reelLeaveEventType(durationMs: number): 'dwell' | 'quick_skip' | null {
  if (durationMs >= SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime) return 'dwell';
  return durationMs >= REEL_QUICK_SKIP_MIN_MS ? 'quick_skip' : null;
}

/**
 * Lets each delivery's `resource_open` through once for the whole app: Home's
 * recipe chip, its unlock sheet, and the reel's Details card and unlock sheet
 * all pass through it. The chip opens the reel on the post's Details, where the
 * resources card is, so a gate of each screen's own reported that one open twice.
 */
export const resourceOpenGate = createFeedDeliveryOnceGate();
