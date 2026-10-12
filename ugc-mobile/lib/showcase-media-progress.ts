export const SHOWCASE_MEDIA_PROGRESS_MILESTONES = [0.25, 0.5, 0.75, 0.95] as const;

export type ShowcaseMediaProgressFlush = {
  progress: number;
  durationMs: number | null;
};

/**
 * Tracks the furthest playback position reached for one video delivery.
 *
 * Feed videos loop, so the raw position resets to zero on wraparound; ranking
 * needs the maximum relative position ever reached, not the current one. The
 * server stores a single per-delivery media_progress row with GREATEST
 * semantics, so flushes are cheap and order-independent — this tracker only
 * limits how often the client sends them: at milestone crossings, on
 * app-background, and on item exit (one exit-only flush would undercount app
 * kills and network failures).
 */
export function createShowcaseMediaProgressTracker() {
  let maxProgress = 0;
  let durationMs: number | null = null;
  let lastFlushedProgress: number | null = null;

  const clampProgress = (value: number) => (
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  );

  return {
    /**
     * Records a playback position sample. Returns true when the sample crossed
     * an unflushed milestone, meaning the caller should flush now.
     */
    record(progress: number, videoDurationMs?: number | null) {
      const next = clampProgress(progress);
      if (typeof videoDurationMs === 'number' && Number.isFinite(videoDurationMs) && videoDurationMs > 0) {
        durationMs = Math.round(videoDurationMs);
      }
      if (next <= maxProgress) return false;

      const previous = maxProgress;
      maxProgress = next;
      const flushedAt = lastFlushedProgress ?? 0;
      return SHOWCASE_MEDIA_PROGRESS_MILESTONES.some((milestone) => (
        previous < milestone && next >= milestone && flushedAt < milestone
      ));
    },

    /**
     * Returns the pending flush payload and marks it sent, or null when
     * nothing new happened since the last flush.
     */
    takeFlush(): ShowcaseMediaProgressFlush | null {
      if (maxProgress <= 0 || maxProgress === lastFlushedProgress) return null;
      lastFlushedProgress = maxProgress;
      return { progress: maxProgress, durationMs };
    },

    get maxProgress() {
      return maxProgress;
    },
  };
}

export type ShowcaseMediaProgressTracker = ReturnType<typeof createShowcaseMediaProgressTracker>;

/**
 * A feed tile's playback sample as a share of the post's own video. A tile may
 * stream the server's teaser, the first eight seconds of a long clip, and a
 * loop of that is not the video watched to its end: it is measured against the
 * source's length, and not at all when that is unknown. Anything else a tile
 * streams is the whole clip. The reels play the whole clip and need none of it.
 */
export function measureSourceVideoProgress({
  currentTimeSeconds,
  streamDurationSeconds,
  teaser,
  sourceDurationSeconds,
}: {
  /** Seconds into what is playing. */
  currentTimeSeconds: number;
  /** Length in seconds of what is playing. */
  streamDurationSeconds: number;
  /** What is playing is the teaser rather than the clip. */
  teaser: boolean;
  /** The post's video length in seconds, as the server recorded it. */
  sourceDurationSeconds: number | null | undefined;
}): ShowcaseMediaProgressFlush | null {
  if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0) return null;
  const durationSeconds = teaser ? sourceDurationSeconds : streamDurationSeconds;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  return {
    progress: Math.min(1, currentTimeSeconds / durationSeconds),
    durationMs: Math.round(durationSeconds * 1000),
  };
}

type ShowcaseMediaProgressSink = (progress: number, durationMs: number | null) => void;

/**
 * Exactly one video plays at a time in the immersive viewer, and the playback
 * component sits several layers below the screen that owns feed telemetry.
 * The screen registers a sink for the item it is tracking; the active video
 * reports samples into it. Same module-level session-state pattern as
 * showcase-feed-events' anonymous removal memory.
 */
let activeSink: ShowcaseMediaProgressSink | null = null;

export function setShowcaseMediaProgressSink(sink: ShowcaseMediaProgressSink | null) {
  activeSink = sink;
}

export function reportShowcaseMediaProgress(progress: number, durationMs: number | null) {
  activeSink?.(progress, durationMs);
}

export function resetShowcaseMediaProgressSinkForTests() {
  activeSink = null;
}
