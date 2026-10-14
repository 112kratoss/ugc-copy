import { SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY, type ShowcaseFeedEventDetails } from './showcase-feed-events';
import { createShowcaseMediaProgressTracker, type ShowcaseMediaProgressTracker } from './showcase-media-progress';

/**
 * What a feed card reports about the attention it was given beyond its
 * impression: how long it was read (`dwell`) and how far its inline video
 * played (`media_progress`). Pure bookkeeping, keyed by delivery, so its timing
 * is testable without a list: the screen feeds it which cards are at qualified
 * visibility (`SHOWCASE_DWELL_VIEWABILITY`), whether the screen is in front, and
 * the playing tile's samples, and records the events it returns.
 */

/**
 * Below this a stretch on screen is a pass, not a read. It is the qualified
 * impression's own second, so a card that reports a dwell has always qualified
 * for its impression too.
 */
export const FEED_DWELL_MIN_MS = SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime;

/** The longest dwell one card reports: a phone left lying on a card is not two minutes of reading. */
export const FEED_DWELL_MAX_MS = 120_000;

export type FeedAttentionEvent<T> =
  | { eventType: 'dwell'; target: T; durationMs: number }
  | { eventType: 'media_progress'; target: T; progress: number; durationMs: number | null };

export interface FeedAttentionTracker<T> {
  /**
   * Every card now at qualified visibility (half of it on screen), whole set,
   * at `now`. A card missing from it has left view: its stretch ends, and the
   * progress its video made since the last milestone is sent.
   */
  setVisible(targets: readonly T[], now: number): FeedAttentionEvent<T>[];
  /**
   * Whether the screen is in front: focused, and the app in the foreground.
   * False (a blur, the app going away, the screen unmounting) ends every
   * stretch and sends every video's progress; true starts the stretches of the
   * cards still on screen.
   */
  setActive(active: boolean, now: number): FeedAttentionEvent<T>[];
  /** A playback sample from a card's inline video, as a share of the post's video. */
  recordProgress(target: T, progress: number, durationMs: number | null): FeedAttentionEvent<T>[];
  /**
   * The card opened its post in the reel, which reads the same delivery and
   * files that delivery's dwell as the reader leaves the post. The server keeps
   * a delivery's first dwell only, so the card's stretch ends here without one,
   * and the delivery files none from this feed later. What its video played is
   * still sent with the rest (the server keeps the furthest point).
   */
  handOff(target: T): void;
}

type AttentionEntry<T> = {
  target: T;
  /** When the current stretch of qualified visibility began; null while the card is not being looked at. */
  visibleSince: number | null;
  dwellRecorded: boolean;
  progress: ShowcaseMediaProgressTracker | null;
};

/**
 * One feed's attention, keyed by delivery (`keyOf`; a card without one is not
 * tracked, since the server credits these events to a delivery only). A
 * delivery's dwell is its first stretch of qualified visibility that lasts at
 * least a second, measured to the moment it ends and capped at two minutes; a
 * shorter stretch reports nothing, and a later one may still qualify until the
 * card hands its post to the reel (`handOff`). Its progress keeps the furthest
 * point reached and is sent as the reel sends its own: at each milestone, and
 * again as the card leaves view or the screen goes away. The server keeps the
 * maximum per delivery.
 */
export function createFeedAttentionTracker<T>(
  keyOf: (target: T) => string | null | undefined
): FeedAttentionTracker<T> {
  const entries = new Map<string, AttentionEntry<T>>();
  let visibleKeys = new Set<string>();
  let active = false;

  const entryFor = (key: string, target: T) => {
    const existing = entries.get(key);
    if (existing) {
      existing.target = target;
      return existing;
    }
    const created: AttentionEntry<T> = { target, visibleSince: null, dwellRecorded: false, progress: null };
    entries.set(key, created);
    return created;
  };

  const startStretch = (entry: AttentionEntry<T>, now: number) => {
    if (entry.visibleSince === null && !entry.dwellRecorded) entry.visibleSince = now;
  };

  const endStretch = (entry: AttentionEntry<T>, now: number, events: FeedAttentionEvent<T>[]) => {
    if (entry.visibleSince === null) return;
    const elapsed = now - entry.visibleSince;
    entry.visibleSince = null;
    if (entry.dwellRecorded || elapsed < FEED_DWELL_MIN_MS) return;
    entry.dwellRecorded = true;
    events.push({
      eventType: 'dwell',
      target: entry.target,
      durationMs: Math.min(FEED_DWELL_MAX_MS, Math.round(elapsed)),
    });
  };

  const flushProgress = (entry: AttentionEntry<T>, events: FeedAttentionEvent<T>[]) => {
    const flush = entry.progress?.takeFlush();
    if (!flush) return;
    events.push({ eventType: 'media_progress', target: entry.target, progress: flush.progress, durationMs: flush.durationMs });
  };

  return {
    setVisible(targets, now) {
      const events: FeedAttentionEvent<T>[] = [];
      const next = new Set<string>();
      for (const target of targets) {
        const key = keyOf(target);
        if (!key || next.has(key)) continue;
        next.add(key);
        const entry = entryFor(key, target);
        if (active) startStretch(entry, now);
      }
      for (const key of visibleKeys) {
        if (next.has(key)) continue;
        const entry = entries.get(key);
        if (!entry) continue;
        endStretch(entry, now, events);
        flushProgress(entry, events);
      }
      visibleKeys = next;
      return events;
    },

    setActive(nextActive, now) {
      const events: FeedAttentionEvent<T>[] = [];
      if (nextActive === active) return events;
      active = nextActive;
      for (const key of visibleKeys) {
        const entry = entries.get(key);
        if (!entry) continue;
        if (active) startStretch(entry, now);
        else endStretch(entry, now, events);
      }
      if (!active) {
        for (const entry of entries.values()) flushProgress(entry, events);
      }
      return events;
    },

    recordProgress(target, progress, durationMs) {
      const key = keyOf(target);
      // A screen that is not in front reports nothing it plays: a reel opened
      // over it plays (and reports) the clip itself.
      if (!key || !active) return [];
      const entry = entryFor(key, target);
      entry.progress ??= createShowcaseMediaProgressTracker();
      const events: FeedAttentionEvent<T>[] = [];
      if (entry.progress.record(progress, durationMs)) flushProgress(entry, events);
      return events;
    },

    handOff(target) {
      const key = keyOf(target);
      if (!key) return;
      const entry = entryFor(key, target);
      entry.visibleSince = null;
      entry.dwellRecorded = true;
    },
  };
}

/** The fields an attention event carries on the wire (`buildShowcaseFeedEventRequest`'s details). */
export function feedAttentionEventDetails<T>(event: FeedAttentionEvent<T>): ShowcaseFeedEventDetails {
  if (event.eventType === 'dwell') return { durationMs: event.durationMs };
  return {
    progress: event.progress,
    ...(event.durationMs !== null ? { durationMs: event.durationMs } : {}),
  };
}

/**
 * Lets each delivery through once. A card's resources opening (its recipe chip,
 * the unlock sheet its Remix opened) is reported the first time only.
 */
export function createFeedDeliveryOnceGate() {
  const passed = new Set<string>();
  return {
    pass(deliveryId: string | null | undefined) {
      if (!deliveryId || passed.has(deliveryId)) return false;
      passed.add(deliveryId);
      return true;
    },
  };
}
