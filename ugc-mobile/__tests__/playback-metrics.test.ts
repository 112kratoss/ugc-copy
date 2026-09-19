import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PLAYBACK_METRICS_FLUSH_INTERVAL_MS,
  PLAYBACK_METRICS_REPORTS_PER_SESSION,
  PLAYBACK_METRICS_SAMPLE_LIMIT,
  PLAYBACK_STALL_LIMIT_MS,
  PLAYBACK_START_LIMIT_MS,
  beginPlaybackStall,
  beginPlaybackStart,
  cancelPlaybackStart,
  clearPlaybackMetricsForTests,
  completePlaybackStart,
  endPlaybackStall,
  flushPlaybackMetrics,
  forgetPlayback,
  readPlaybackMetrics,
  setPlaybackMetricsReporter,
  type PlaybackMetricsReport,
} from '../lib/playback-metrics';

function reporter(overrides: Partial<Parameters<typeof setPlaybackMetricsReporter>[0]> = {}) {
  const background: { fire: () => void } = { fire: () => undefined };
  const send = vi.fn(async (_report: PlaybackMetricsReport) => undefined);
  const unsubscribe = vi.fn();
  setPlaybackMetricsReporter({
    send,
    app: () => ({ version: '0.1.4', build: '72', update: '0558882d' }),
    device: () => ({ platform: 'android', os: '15', model: 'samsung SM-S928B' }),
    network: async () => 'wifi',
    subscribeToBackground: (onBackground) => {
      background.fire = onBackground;
      return unsubscribe;
    },
    random: () => 0,
    ...overrides,
  });
  return { send, background, unsubscribe };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('playback metrics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T10:00:00.000Z'));
    clearPlaybackMetricsForTests();
  });

  afterEach(() => {
    clearPlaybackMetricsForTests();
    vi.useRealTimers();
  });

  it('measures a start from the request to the first sign of motion, per surface and kind', () => {
    beginPlaybackStart('feed:a', { surface: 'feed', kind: 'cold' });
    vi.advanceTimersByTime(240);
    completePlaybackStart('feed:a');
    // A repeated completion (a loop restart re-firing the first-frame event) is not a second start.
    completePlaybackStart('feed:a');
    beginPlaybackStart('viewer:b', { surface: 'viewer', kind: 'warm' });
    vi.advanceTimersByTime(40);
    completePlaybackStart('viewer:b');

    expect(readPlaybackMetrics().buckets).toEqual([
      expect.objectContaining({ surface: 'feed', kind: 'cold', starts: 1, startTotalMs: 240, startMaxMs: 240, samples: [240] }),
      expect.objectContaining({ surface: 'viewer', kind: 'warm', starts: 1, startTotalMs: 40, startMaxMs: 40, samples: [40] }),
    ]);
  });

  it('keeps the first request time when a key is asked again while pending', () => {
    beginPlaybackStart('feed:a', { surface: 'feed', kind: 'cold' });
    vi.advanceTimersByTime(100);
    beginPlaybackStart('feed:a', { surface: 'feed', kind: 'warm' });
    vi.advanceTimersByTime(100);
    completePlaybackStart('feed:a');

    expect(readPlaybackMetrics().buckets).toEqual([
      expect.objectContaining({ kind: 'cold', starts: 1, startTotalMs: 200 }),
    ]);
  });

  it('drops withdrawn requests and abandoned loads', () => {
    beginPlaybackStart('feed:a', { surface: 'feed', kind: 'cold' });
    cancelPlaybackStart('feed:a');
    completePlaybackStart('feed:a');
    beginPlaybackStart('feed:b', { surface: 'feed', kind: 'cold' });
    vi.advanceTimersByTime(PLAYBACK_START_LIMIT_MS + 1);
    completePlaybackStart('feed:b');

    expect(readPlaybackMetrics().buckets).toEqual([]);
  });

  it('records a stall against the playback it interrupted, capped at the limit', () => {
    beginPlaybackStart('viewer:a', { surface: 'viewer', kind: 'warm' });
    completePlaybackStart('viewer:a');
    beginPlaybackStall('viewer:a');
    vi.advanceTimersByTime(800);
    endPlaybackStall('viewer:a');
    beginPlaybackStall('viewer:a');
    vi.advanceTimersByTime(PLAYBACK_STALL_LIMIT_MS * 2);
    endPlaybackStall('viewer:a');
    // A stall on a key that never showed motion is a slow start, not a stall.
    beginPlaybackStall('viewer:unknown');
    endPlaybackStall('viewer:unknown');

    expect(readPlaybackMetrics().buckets).toEqual([
      expect.objectContaining({
        surface: 'viewer', kind: 'warm', starts: 1, stalls: 2, stallTotalMs: 800 + PLAYBACK_STALL_LIMIT_MS, stallMaxMs: PLAYBACK_STALL_LIMIT_MS,
      }),
    ]);
  });

  it('forgets a key without recording what was pending on it', () => {
    beginPlaybackStart('feed:a', { surface: 'feed', kind: 'cold' });
    completePlaybackStart('feed:a');
    beginPlaybackStall('feed:a');
    forgetPlayback('feed:a');
    endPlaybackStall('feed:a');

    expect(readPlaybackMetrics().buckets).toEqual([
      expect.objectContaining({ starts: 1, stalls: 0 }),
    ]);
  });

  it('keeps a bounded reservoir of start samples and exact totals', () => {
    reporter({ random: () => 0.999 });
    for (let index = 0; index < PLAYBACK_METRICS_SAMPLE_LIMIT + 20; index += 1) {
      beginPlaybackStart(`feed:${index}`, { surface: 'feed', kind: 'cold' });
      vi.advanceTimersByTime(10);
      completePlaybackStart(`feed:${index}`);
    }

    const [bucket] = readPlaybackMetrics().buckets;
    expect(bucket.starts).toBe(PLAYBACK_METRICS_SAMPLE_LIMIT + 20);
    expect(bucket.startTotalMs).toBe(10 * (PLAYBACK_METRICS_SAMPLE_LIMIT + 20));
    expect(bucket.samples).toHaveLength(PLAYBACK_METRICS_SAMPLE_LIMIT);
    // With random() near 1 the slot is always past the reservoir, so the first samples stay.
    expect(bucket.samples.every((sample) => sample === 10)).toBe(true);
  });

  it('sends the accumulated span when the app goes to the background, then starts over', async () => {
    const { send, background } = reporter();
    beginPlaybackStart('feed:a', { surface: 'feed', kind: 'cold' });
    vi.advanceTimersByTime(300);
    completePlaybackStart('feed:a');
    vi.advanceTimersByTime(5_000);

    background.fire();
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({
      sessionId: expect.stringMatching(/^[A-Za-z0-9-]{8,13}$/),
      app: { version: '0.1.4', build: '72', update: '0558882d' },
      device: { platform: 'android', os: '15', model: 'samsung SM-S928B', network: 'wifi' },
      spanMs: 5_300,
      buckets: [
        { surface: 'feed', kind: 'cold', starts: 1, startTotalMs: 300, startMaxMs: 300, samples: [300], stalls: 0, stallTotalMs: 0, stallMaxMs: 0 },
      ],
    });
    expect(readPlaybackMetrics().buckets).toEqual([]);

    // Nothing new: the next trip to the background sends nothing.
    background.fire();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flushes on the interval while a long session accumulates', async () => {
    const { send } = reporter();
    beginPlaybackStart('viewer:a', { surface: 'viewer', kind: 'warm' });
    completePlaybackStart('viewer:a');

    vi.advanceTimersByTime(PLAYBACK_METRICS_FLUSH_INTERVAL_MS);
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports the network as unknown when the probe fails, and drops a send that fails', async () => {
    const send = vi.fn(async () => {
      throw new Error('offline');
    });
    reporter({ send, network: async () => { throw new Error('no module'); } });
    beginPlaybackStart('feed:a', { surface: 'feed', kind: 'cold' });
    completePlaybackStart('feed:a');

    flushPlaybackMetrics();
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [PlaybackMetricsReport])[0].device.network).toBe('unknown');
    expect(readPlaybackMetrics().buckets).toEqual([]);
  });

  it('stops after the per-session report cap and unregisters cleanly', async () => {
    const { send, unsubscribe } = reporter();
    for (let index = 0; index < PLAYBACK_METRICS_REPORTS_PER_SESSION + 2; index += 1) {
      beginPlaybackStart(`feed:${index}`, { surface: 'feed', kind: 'cold' });
      completePlaybackStart(`feed:${index}`);
      flushPlaybackMetrics();
    }
    await settle();
    expect(send).toHaveBeenCalledTimes(PLAYBACK_METRICS_REPORTS_PER_SESSION);

    clearPlaybackMetricsForTests();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
