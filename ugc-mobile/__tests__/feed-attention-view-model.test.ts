import { describe, expect, it } from 'vitest';

import {
  FEED_DWELL_MAX_MS,
  FEED_DWELL_MIN_MS,
  createFeedAttentionTracker,
  createFeedDeliveryOnceGate,
  feedAttentionEventDetails,
} from '../lib/feed-attention-view-model';
import { SHOWCASE_DWELL_VIEWABILITY, SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY } from '../lib/showcase-feed-events';
import { measureSourceVideoProgress } from '../lib/showcase-media-progress';

// Feed ranking v4, §4 (docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md):
// Home reports how long each card was read and how far its inline video played,
// once per delivery, alongside the impression it already reported.

type Card = { id: string; deliveryId: string | null };

const card = (id: string, deliveryId: string | null = `delivery-${id}`): Card => ({ id, deliveryId });

function tracker() {
  const attention = createFeedAttentionTracker<Card>((target) => target.deliveryId);
  attention.setActive(true, 0);
  return attention;
}

describe('Home feed dwell', () => {
  it('measures the impression’s own visibility, reported as it changes', () => {
    expect(SHOWCASE_DWELL_VIEWABILITY).toEqual({
      itemVisiblePercentThreshold: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.itemVisiblePercentThreshold,
      minimumViewTime: 0,
    });
    expect(FEED_DWELL_MIN_MS).toBe(SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime);
    expect(FEED_DWELL_MAX_MS).toBe(120_000);
  });

  it('sends one dwell when a card leaves view after a second or more, and never again', () => {
    const attention = tracker();
    const a = card('a');

    expect(attention.setVisible([a], 1_000)).toEqual([]);
    expect(attention.setVisible([], 5_200)).toEqual([{ eventType: 'dwell', target: a, durationMs: 4_200 }]);

    // Scrolled back to and away again: the delivery has reported its dwell.
    attention.setVisible([a], 6_000);
    expect(attention.setVisible([], 20_000)).toEqual([]);
  });

  it('reports nothing for a pass under a second, and lets a later look count', () => {
    const attention = tracker();
    const a = card('a');

    attention.setVisible([a], 0);
    expect(attention.setVisible([], 999)).toEqual([]);
    attention.setVisible([a], 3_000);
    expect(attention.setVisible([], 4_000)).toEqual([{ eventType: 'dwell', target: a, durationMs: 1_000 }]);
  });

  it('caps a dwell at two minutes', () => {
    const attention = tracker();
    const a = card('a');

    attention.setVisible([a], 0);
    expect(attention.setVisible([], 15 * 60_000)).toEqual([{ eventType: 'dwell', target: a, durationMs: FEED_DWELL_MAX_MS }]);
  });

  it('times each card on screen on its own', () => {
    const attention = tracker();
    const a = card('a');
    const b = card('b');

    attention.setVisible([a], 0);
    attention.setVisible([a, b], 2_000);
    expect(attention.setVisible([b], 3_000)).toEqual([{ eventType: 'dwell', target: a, durationMs: 3_000 }]);
    expect(attention.setVisible([], 6_500)).toEqual([{ eventType: 'dwell', target: b, durationMs: 4_500 }]);
  });

  it('ends every stretch when Home blurs or the app leaves, and starts afresh on return', () => {
    const attention = tracker();
    const a = card('a');
    const b = card('b');

    attention.setVisible([a, b], 0);
    // The reel opened over Home 2.5 s later; b had been on screen as long.
    expect(attention.setActive(false, 2_500)).toEqual([
      { eventType: 'dwell', target: a, durationMs: 2_500 },
      { eventType: 'dwell', target: b, durationMs: 2_500 },
    ]);
    // Nothing counts while Home is behind something: b leaving now sends nothing.
    expect(attention.setVisible([a], 30_000)).toEqual([]);
    expect(attention.setActive(true, 60_000)).toEqual([]);
    // Both deliveries have their dwell: a back on screen adds nothing.
    expect(attention.setVisible([], 90_000)).toEqual([]);
  });

  it('starts the stretch of a card first seen while Home was behind, once Home is back', () => {
    const attention = createFeedAttentionTracker<Card>((target) => target.deliveryId);
    const a = card('a');

    // The list reports before Home's focus effect has run.
    attention.setVisible([a], 0);
    expect(attention.setActive(true, 500)).toEqual([]);
    expect(attention.setActive(false, 2_000)).toEqual([{ eventType: 'dwell', target: a, durationMs: 1_500 }]);
  });

  it('tracks nothing a delivery cannot be credited with', () => {
    const attention = tracker();
    const unranked = card('a', null);

    attention.setVisible([unranked], 0);
    expect(attention.setVisible([], 10_000)).toEqual([]);
    expect(attention.recordProgress(unranked, 0.9, 10_000)).toEqual([]);
  });

  it('keeps the card it reports up to date while the same delivery stays on screen', () => {
    const attention = tracker();
    const before = card('a');
    const after = { ...before };

    attention.setVisible([before], 0);
    // A save or a refetch gives the card a new object; the stretch goes on.
    attention.setVisible([after], 1_500);
    expect(attention.setVisible([], 3_000)).toEqual([{ eventType: 'dwell', target: after, durationMs: 3_000 }]);
  });
});

// Feed fix run 2026-10-14 (04-5): the server keeps a delivery's first dwell.
// When a Home card opens the reel on its post, the reel's dwell on that same
// delivery has to be the one kept, not the seconds the card was looked at.
describe('a Home card handing its post to the reel', () => {
  it('ends that card’s stretch without a dwell, and the other cards on screen file theirs', () => {
    const attention = tracker();
    const opened = card('a');
    const other = card('b');

    attention.setVisible([opened, other], 0);
    attention.handOff(opened);
    // Home blurs as the reel opens over it, 4 s after both came on screen.
    expect(attention.setActive(false, 4_000)).toEqual([{ eventType: 'dwell', target: other, durationMs: 4_000 }]);
  });

  it('files no dwell for that delivery later, and still sends what its video played', () => {
    const attention = tracker();
    const opened = card('a');

    attention.setVisible([opened], 0);
    attention.recordProgress(opened, 0.2, 9_000);
    attention.handOff(opened);
    expect(attention.setActive(false, 3_000)).toEqual([
      { eventType: 'media_progress', target: opened, progress: 0.2, durationMs: 9_000 },
    ]);
    // Back from the reel with the card still on screen, then scrolled away.
    expect(attention.setActive(true, 60_000)).toEqual([]);
    expect(attention.setVisible([], 90_000)).toEqual([]);
  });

  it('holds for a card opened before it was half on screen, and passes over a card with no delivery', () => {
    const attention = tracker();
    const opened = card('a');
    const unranked = card('b', null);
    const other = card('c');

    // The recipe chip of a card mostly below the fold.
    attention.handOff(opened);
    attention.handOff(unranked);
    attention.setVisible([opened, unranked, other], 0);
    expect(attention.setVisible([], 5_000)).toEqual([{ eventType: 'dwell', target: other, durationMs: 5_000 }]);
  });
});

describe('Home feed inline video progress', () => {
  it('sends progress at each milestone, the furthest point across loops', () => {
    const attention = tracker();
    const a = card('a');

    expect(attention.recordProgress(a, 0.1, 12_000)).toEqual([]);
    expect(attention.recordProgress(a, 0.3, 12_000)).toEqual([
      { eventType: 'media_progress', target: a, progress: 0.3, durationMs: 12_000 },
    ]);
    expect(attention.recordProgress(a, 0.05, 12_000)).toEqual([]);
    expect(attention.recordProgress(a, 0.55, 12_000)).toEqual([
      { eventType: 'media_progress', target: a, progress: 0.55, durationMs: 12_000 },
    ]);
  });

  it('sends what was played since the last milestone when the card leaves view', () => {
    const attention = tracker();
    const a = card('a');

    attention.setVisible([a], 0);
    attention.recordProgress(a, 0.3, 12_000);
    attention.recordProgress(a, 0.4, 12_000);
    expect(attention.setVisible([], 500)).toEqual([
      { eventType: 'media_progress', target: a, progress: 0.4, durationMs: 12_000 },
    ]);
  });

  it('sends every card’s progress when Home blurs or the app leaves, and ignores samples while away', () => {
    const attention = tracker();
    const a = card('a');

    attention.recordProgress(a, 0.2, 9_000);
    expect(attention.setActive(false, 1_000)).toEqual([
      { eventType: 'media_progress', target: a, progress: 0.2, durationMs: 9_000 },
    ]);
    // A reel opened over Home plays the clip and reports it itself.
    expect(attention.recordProgress(a, 0.9, 9_000)).toEqual([]);
    expect(attention.setActive(true, 2_000)).toEqual([]);
    expect(attention.setActive(false, 3_000)).toEqual([]);
  });

  it('puts each attention event on the wire as the reel does', () => {
    const a = card('a');
    expect(feedAttentionEventDetails({ eventType: 'dwell', target: a, durationMs: 4_200 })).toEqual({ durationMs: 4_200 });
    expect(feedAttentionEventDetails({ eventType: 'media_progress', target: a, progress: 0.5, durationMs: 95_500 }))
      .toEqual({ progress: 0.5, durationMs: 95_500 });
    expect(feedAttentionEventDetails({ eventType: 'media_progress', target: a, progress: 0.5, durationMs: null }))
      .toEqual({ progress: 0.5 });
  });

  it("measures a teaser's play against the whole clip, and a clip of unknown length not at all", () => {
    // The whole 8 s head of a 95.5 s clip, looped, is not the clip watched to its end.
    expect(measureSourceVideoProgress({ currentTimeSeconds: 7.9, streamDurationSeconds: 8, teaser: true, sourceDurationSeconds: 95.5 }))
      .toEqual({ progress: 7.9 / 95.5, durationMs: 95_500 });
    expect(measureSourceVideoProgress({ currentTimeSeconds: 4, streamDurationSeconds: 8, teaser: true, sourceDurationSeconds: null }))
      .toBeNull();
    // A short clip streams whole: its own length.
    expect(measureSourceVideoProgress({ currentTimeSeconds: 6, streamDurationSeconds: 12, teaser: false, sourceDurationSeconds: 12 }))
      .toEqual({ progress: 0.5, durationMs: 12_000 });
    expect(measureSourceVideoProgress({ currentTimeSeconds: 6, streamDurationSeconds: 0, teaser: false, sourceDurationSeconds: 12 }))
      .toBeNull();
    expect(measureSourceVideoProgress({ currentTimeSeconds: Number.NaN, streamDurationSeconds: 12, teaser: false, sourceDurationSeconds: 12 }))
      .toBeNull();
  });
});

describe("a card's resources opening", () => {
  it('is reported once per delivery, and never without one', () => {
    const gate = createFeedDeliveryOnceGate();

    expect(gate.pass('delivery-1')).toBe(true);
    expect(gate.pass('delivery-1')).toBe(false);
    expect(gate.pass('delivery-2')).toBe(true);
    expect(gate.pass(null)).toBe(false);
    expect(gate.pass(undefined)).toBe(false);
  });
});
