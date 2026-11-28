import { MIN_HIT_TARGET_PT } from '@/lib/hit-target';

/**
 * The reel's progress bar (`components/reel-progress-bar.tsx`): a thin line
 * under the caption of a playing video that a sideways drag scrubs and a tap
 * seeks, the way Reels and TikTok draw theirs. Everything here is plain
 * arithmetic, so it is tested without a player; the functions the bar's
 * gestures call on the UI thread are marked as worklets.
 */

/** Where the caption block ends above the bottom inset (`components/reel-chrome.tsx`). The touch area stops there. */
export const REEL_CAPTION_BOTTOM_LIFT = 24;
/** How far above the bottom inset the line is drawn. */
export const REEL_PROGRESS_LINE_LIFT = 6;
/** The line at rest, and its height while a finger is on it. */
export const REEL_PROGRESS_LINE_HEIGHT = 2;
export const REEL_PROGRESS_LINE_HELD_HEIGHT = 6;
/** The line's ends sit in from the screen's edges, in line with the caption, and clear of the edge swipes. */
export const REEL_PROGRESS_SIDE_INSET = 18;

export type ReelProgressFrame = {
  /** The touch area's distance from the bottom of the slide. */
  bottom: number;
  /** The touch area's height: never under HIG's 44pt. */
  height: number;
  /** The line's centre, measured up from the bottom of the touch area. */
  lineCenter: number;
};

/**
 * The bar's touch area and line, from the slide's bottom inset. The area runs
 * up to the caption's bottom edge and down into the inset for its 44pt, so it
 * takes no touch from the caption; with no inset to go into (a phone without a
 * home indicator) it keeps its 44pt and starts at the bottom edge.
 */
export function reelProgressFrame(bottomInset: number): ReelProgressFrame {
  const inset = Number.isFinite(bottomInset) ? Math.max(0, bottomInset) : 0;
  const height = MIN_HIT_TARGET_PT;
  const bottom = Math.max(0, inset + REEL_CAPTION_BOTTOM_LIFT - height);
  return { bottom, height, lineCenter: inset + REEL_PROGRESS_LINE_LIFT - bottom };
}

/** A finger needs this much sideways travel before the bar takes the touch. */
export const REEL_SCRUB_ACTIVATE_DISTANCE = 8;
/** And this much up or down hands it to the reel's own swipe for good. */
export const REEL_SCRUB_PASS_DISTANCE = 10;

export type ReelScrubDecision = 'wait' | 'scrub' | 'pass';

/**
 * Whether a touch on the bar is a scrub, from how far the finger has moved
 * since it came down. A swipe up or down that starts on the bar is still the
 * reel's, so the next post is one swipe away from anywhere on the screen.
 */
export function reelScrubDecision(dx: number, dy: number): ReelScrubDecision {
  'worklet';
  const across = Math.abs(dx);
  const along = Math.abs(dy);
  if (along >= REEL_SCRUB_PASS_DISTANCE && along > across) return 'pass';
  if (across >= REEL_SCRUB_ACTIVATE_DISTANCE && across > along) return 'scrub';
  return 'wait';
}

/** How far along the clip a position is, 0 to 1. */
export function reelProgressFraction(currentSeconds: number, durationSeconds: number): number {
  'worklet';
  if (!(durationSeconds > 0) || !Number.isFinite(currentSeconds)) return 0;
  return Math.min(1, Math.max(0, currentSeconds / durationSeconds));
}

/** Where along the line a finger is, 0 to 1, from its distance from the line's start. */
export function reelScrubFraction(x: number, trackWidth: number): number {
  'worklet';
  if (!(trackWidth > 0) || !Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x / trackWidth));
}

/**
 * The bar never seeks a looping clip to its very end, where it would start
 * over under the finger: a tenth of a second short keeps the last frame.
 */
export const REEL_SEEK_END_GUARD_SECONDS = 0.1;

/** The time a scrub or tap at `fraction` of the line seeks to. */
export function reelSeekSeconds(fraction: number, durationSeconds: number): number {
  if (!(durationSeconds > 0) || !Number.isFinite(fraction)) return 0;
  const latest = Math.max(0, durationSeconds - REEL_SEEK_END_GUARD_SECONDS);
  return Math.min(latest, Math.max(0, fraction * durationSeconds));
}

/**
 * How far the line may drift from the player before it is set back to it.
 * The line runs to the clip's end on the UI thread and is checked against
 * every time report (4 a second); closer than this, the run is left alone so
 * the line never steps back a frame.
 */
export const REEL_PROGRESS_RESYNC_SECONDS = 0.3;

export type ReelProgressRun = {
  /** The fraction the run started from. */
  from: number;
  /** When it started, in ms. */
  startedAt: number;
  /** How long it takes to reach the end, in ms. */
  durationMs: number;
};

/** Where a run is at `now`. */
export function reelProgressRunPosition(run: ReelProgressRun, now: number): number {
  if (!(run.durationMs > 0)) return 1;
  const elapsed = Math.min(1, Math.max(0, (now - run.startedAt) / run.durationMs));
  return run.from + (1 - run.from) * elapsed;
}

/** Whether a time report says the line has drifted far enough to be set back to the player. */
export function reelProgressNeedsResync(
  run: ReelProgressRun | null,
  now: number,
  reportedFraction: number,
  durationSeconds: number,
): boolean {
  if (!run) return true;
  const driftSeconds = Math.abs(reelProgressRunPosition(run, now) - reportedFraction) * durationSeconds;
  return driftSeconds > REEL_PROGRESS_RESYNC_SECONDS;
}

/** A clock reading: minutes and seconds, with hours once there are any. */
export function formatReelClock(seconds: number, rounding: 'floor' | 'round' = 'floor'): string {
  const total = clockSeconds(seconds, rounding);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** What the bar shows while it is scrubbed: where the finger is, of the whole clip. */
export function reelScrubLabel(currentSeconds: number, durationSeconds: number): string {
  return `${formatReelClock(currentSeconds)} / ${formatReelClock(durationSeconds, 'round')}`;
}

/** A length as a screen reader says it: "4 seconds", "1 minute 5 seconds". */
export function spokenReelClock(seconds: number, rounding: 'floor' | 'round' = 'floor'): string {
  const total = clockSeconds(seconds, rounding);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest} ${rest === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

/** The bar's value for a screen reader, which reads it as an adjustable control. */
export function reelProgressAccessibilityText(currentSeconds: number, durationSeconds: number): string {
  return `${spokenReelClock(currentSeconds)} of ${spokenReelClock(durationSeconds, 'round')}`;
}

/** How far one swipe up or down moves a screen reader along the clip: a tenth of it, and never under a second. */
export function reelAccessibilityStepSeconds(durationSeconds: number): number {
  if (!(durationSeconds > 0)) return 0;
  return Math.max(1, Math.round(durationSeconds / 10));
}

function clockSeconds(seconds: number, rounding: 'floor' | 'round'): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return rounding === 'round' ? Math.round(seconds) : Math.floor(seconds);
}

/**
 * The furthest a step between two time reports can go and still be playing:
 * reports come 4 a second, so anything longer was a seek.
 */
export const REEL_WATCH_MAX_STEP_SECONDS = 1.5;
const REEL_WATCH_EPSILON_SECONDS = 0.05;

/**
 * The furthest point of a clip reached by playing it, for the reel's watch
 * progress (`lib/showcase-media-progress.ts`, which ranking reads). A position
 * the reader scrubbed or tapped to is not watched: after a seek, the clip
 * counts again only once playing carries it past what was reached before.
 * Without seeks this is the furthest position, as the reel always reported:
 * the first report stands (a clip taken over from a feed tile starts part-way
 * in), and a loop starting over changes nothing.
 */
export function createReelWatchReach() {
  let reach: number | null = null;
  let previous: number | null = null;
  let jumped = false;

  return {
    /** The next report comes after a seek, and starts a new stretch of playing. */
    noteSeek() {
      jumped = true;
    },

    /** Takes a time report in seconds and returns the furthest point reached by playing. */
    sample(seconds: number): number {
      if (!Number.isFinite(seconds) || seconds < 0) return reach ?? 0;
      if (jumped) {
        jumped = false;
        previous = seconds;
        if (reach === null) reach = 0;
        return reach;
      }
      if (reach === null || previous === null) {
        reach = seconds;
        previous = seconds;
        return reach;
      }
      const from = previous;
      previous = seconds;
      const playedOn = seconds >= from && seconds - from <= REEL_WATCH_MAX_STEP_SECONDS;
      if (playedOn && from <= reach + REEL_WATCH_EPSILON_SECONDS) reach = Math.max(reach, seconds);
      return reach;
    },
  };
}

export type ReelWatchReach = ReturnType<typeof createReelWatchReach>;
