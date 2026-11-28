import { MIN_HIT_TARGET_PT, verticalHitSlop } from '@/lib/hit-target';

/**
 * The reel's progress bar (`components/reel-progress-bar.tsx`): a thin line
 * under the caption of a playing video that a sideways drag scrubs and a tap
 * seeks, the way Reels and TikTok draw theirs. Everything here is plain
 * arithmetic, so it is tested without a player; the functions the bar's
 * gestures call on the UI thread are marked as worklets.
 */

/** Where the caption block ends above the bottom inset (`components/reel-chrome.tsx`). */
export const REEL_CAPTION_BOTTOM_LIFT = 24;
/** The caption's creator row (`components/reel-chrome.tsx`), and the slop of the Follow pill in it. */
export const REEL_CREATOR_ROW_HEIGHT = 34;
export const REEL_FOLLOW_PILL_HIT_SLOP = 6;
/** How far the caption's touch areas reach below its block: the most any of its rows' slop does. */
export const REEL_CAPTION_SLOP_BELOW = Math.max(REEL_FOLLOW_PILL_HIT_SLOP, verticalHitSlop(REEL_CREATOR_ROW_HEIGHT).bottom);
/** How far above the bottom inset the line is drawn. */
export const REEL_PROGRESS_LINE_LIFT = 6;
/** The line at rest, and its height while a finger is on it. */
export const REEL_PROGRESS_LINE_HEIGHT = 2;
export const REEL_PROGRESS_LINE_HELD_HEIGHT = 6;
/** The line's ends sit in from the screen's edges, in line with the caption. */
export const REEL_PROGRESS_SIDE_INSET = 18;
/** A finger may land this far past either end of the line and still hold it there; further out is the edge swipes'. */
export const REEL_PROGRESS_END_SLOP = 8;

function cleanInset(bottomInset: number) {
  return Number.isFinite(bottomInset) ? Math.max(0, bottomInset) : 0;
}

/**
 * The caption block's bottom edge, above the bottom of the slide. Just above
 * the inset; on a phone with little or none (an iPhone SE or 8), lifted until
 * the progress bar's 44pt touch area fits beneath the caption's own touch
 * areas. A home indicator (34pt) or Android's navigation bar (48pt or more)
 * leaves it where it always was.
 */
export function reelCaptionBottom(bottomInset: number): number {
  return Math.max(cleanInset(bottomInset) + REEL_CAPTION_BOTTOM_LIFT, MIN_HIT_TARGET_PT + REEL_CAPTION_SLOP_BELOW);
}

export type ReelProgressFrame = {
  /** The touch area's distance from the bottom of the slide. */
  bottom: number;
  /** The touch area's height: never under HIG's 44pt. */
  height: number;
  /** The line's centre, measured up from the bottom of the touch area. */
  lineCenter: number;
  /** The touch area's distance from each side of the slide: the line and its end slop, nothing wider. */
  side: number;
};

/**
 * The bar's touch area and line, from the slide's bottom inset. The area ends
 * below the lowest reach of the caption's touch areas, so it takes no touch
 * from them, and runs down into the inset for its 44pt; the line sits just
 * above the inset, inside it.
 */
export function reelProgressFrame(bottomInset: number): ReelProgressFrame {
  const inset = cleanInset(bottomInset);
  const height = MIN_HIT_TARGET_PT;
  const top = reelCaptionBottom(inset) - REEL_CAPTION_SLOP_BELOW;
  const bottom = Math.max(0, top - height);
  const halfLine = REEL_PROGRESS_LINE_HELD_HEIGHT / 2;
  const line = Math.min(bottom + height - halfLine, Math.max(bottom + halfLine, inset + REEL_PROGRESS_LINE_LIFT));
  return { bottom, height, lineCenter: line - bottom, side: REEL_PROGRESS_SIDE_INSET - REEL_PROGRESS_END_SLOP };
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
 * How far a time report may run ahead of the clock since the last one and
 * still be the clip playing on: reports come four a second, some late and
 * some in a burst after a busy moment, so a step is measured against the time
 * that passed between them, with this much to spare. Anything further was a
 * seek.
 */
export const REEL_WATCH_STEP_SLACK_SECONDS = 0.75;
const REEL_WATCH_EPSILON_SECONDS = 0.05;

/**
 * The furthest point of a clip reached by playing it, for the reel's watch
 * progress (`lib/showcase-media-progress.ts`, which ranking reads). A position
 * the reader scrubbed or tapped to is not watched: after a seek, the clip
 * counts again only once playing carries it past what was reached before.
 * Without seeks this is the furthest position, as the reel always reported:
 * the first report stands (a clip taken over from a feed tile starts part-way
 * in), a loop starting over changes nothing, and a gap in the reports (a held
 * close, a busy main thread) costs nothing while the clip moved no faster
 * than the clock.
 */
export function createReelWatchReach() {
  let reach: number | null = null;
  let previous: { seconds: number; at: number } | null = null;
  let jumped = false;

  return {
    /** The next report comes after a seek, and starts a new stretch of playing. */
    noteSeek() {
      jumped = true;
    },

    /**
     * Takes a time report, in seconds, with the clock in ms when it arrived and
     * the playback rate, and returns the furthest point reached by playing.
     */
    sample(seconds: number, now: number, rate = 1): number {
      if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(now)) return reach ?? 0;
      const last = previous;
      previous = { seconds, at: now };
      if (jumped) {
        jumped = false;
        if (reach === null) reach = 0;
        return reach;
      }
      if (reach === null || last === null) {
        reach = seconds;
        return reach;
      }
      const elapsedSeconds = Math.max(0, now - last.at) / 1000;
      const step = seconds - last.seconds;
      const playedOn = step >= 0
        && step <= elapsedSeconds * Math.max(1, Number.isFinite(rate) ? rate : 1) + REEL_WATCH_STEP_SLACK_SECONDS;
      if (playedOn && last.seconds <= reach + REEL_WATCH_EPSILON_SECONDS) reach = Math.max(reach, seconds);
      return reach;
    },
  };
}

export type ReelWatchReach = ReturnType<typeof createReelWatchReach>;

export type ReelWatchReport = {
  /** The share of the clip played, 0 to 1. */
  progress: number;
  durationMs: number;
};

/**
 * The watch progress one reel slide's video reports for one visit (the reel's
 * `media_progress`, `lib/showcase-media-progress.ts`). Kept for the whole
 * visit: an overlay over the slide (comments, the actions sheet, Details,
 * unlock, the app losing focus) stops the reports but is the same visit, and a
 * place scrubbed to before it is still not watched after it. Started over when
 * the slide is left, where the clip is rewound. Seeks are the bar's, counted by
 * the slide's store (`lib/reel-scrubber-store.ts`): a report under a new count
 * follows a seek, and nothing is reported while a finger drags the bar.
 */
export function createReelWatchVisit(seekGeneration: number) {
  let reach = createReelWatchReach();
  let seeks = seekGeneration;

  return {
    /** The slide was left: the next visit starts from nothing, at the store's current seek count. */
    leave(currentSeekGeneration: number) {
      reach = createReelWatchReach();
      seeks = currentSeekGeneration;
    },

    report({
      seconds,
      durationSeconds,
      now,
      rate,
      scrubbing,
      seekGeneration: currentSeekGeneration,
    }: {
      seconds: number;
      durationSeconds: number;
      now: number;
      rate: number;
      scrubbing: boolean;
      seekGeneration: number;
    }): ReelWatchReport | null {
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
      if (scrubbing) return null;
      if (currentSeekGeneration !== seeks) {
        seeks = currentSeekGeneration;
        reach.noteSeek();
      }
      const reached = reach.sample(seconds, now, rate);
      return { progress: Math.min(1, reached / durationSeconds), durationMs: durationSeconds * 1000 };
    },
  };
}

export type ReelWatchVisit = ReturnType<typeof createReelWatchVisit>;
