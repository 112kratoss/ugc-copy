import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import {
  FEED_EVENT_QUEUE_MAX_AGE_MS,
  FEED_EVENT_QUEUE_MAX_ENTRIES,
  FEED_EVENT_QUEUE_STORAGE_KEY,
  FEED_EVENT_QUEUE_TRANSITION_DRAIN_MS,
  createFeedEventQueue,
  type FeedEventQueueStorage,
} from '../lib/feed-event-queue';
import { ApiError } from '../lib/api-client';
import type { ShowcaseFeedEventRequest } from '../lib/types';

function event(index: number): ShowcaseFeedEventRequest {
  return {
    clientEventId: `event-${index}`,
    deliveryId: `delivery-${index}`,
    postId: `post-${index}`,
    eventType: 'impression',
    sourceSurface: 'showcase',
  };
}

function createMemoryStorage(initial: string | null = null): FeedEventQueueStorage & { value: string | null } {
  return {
    value: initial,
    async getItem() {
      return this.value;
    },
    async setItem(_key, value) {
      this.value = value;
    },
  };
}

function persistedEntries(entries: Array<Record<string, unknown>>) {
  return JSON.stringify({ version: 1, entries });
}

function persistedEntry(index: number, identityKey: string, enqueuedAt: number) {
  return {
    identityKey,
    event: {
      ...event(index),
      occurredAt: new Date(enqueuedAt).toISOString(),
    },
    enqueuedAt,
    attempts: 0,
    nextAttemptAt: enqueuedAt,
  };
}

function createHarness({
  initial = null,
  identityKey = 'user:user-1',
  now = 1_700_000_000_000,
  random = 0.5,
}: {
  initial?: string | null;
  identityKey?: string;
  now?: number;
  random?: number;
} = {}) {
  const storage = createMemoryStorage(initial);
  let currentIdentityKey = identityKey;
  let currentTime = now;
  const getAccessToken = vi.fn(async () => currentIdentityKey.startsWith('user:') ? `token:${currentIdentityKey}` : null);
  const sendBatch = vi.fn(async (
    _events: ShowcaseFeedEventRequest[],
    _options: { accessToken: string | null },
  ) => ({ success: true, recorded: 1, rejected: 0 }));
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const queue = createFeedEventQueue({
    storage,
    sendBatch,
    getAccessToken,
    getCurrentIdentityKey: async () => currentIdentityKey,
    now: () => currentTime,
    random: () => random,
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return {
    storage,
    queue,
    sendBatch,
    getAccessToken,
    timers,
    setIdentityKey: (value: string) => { currentIdentityKey = value; },
    setNow: (value: number) => { currentTime = value; },
  };
}

describe('feed event queue', () => {
  it('stamps occurrence time, persists a non-secret identity key, and never stores a token', async () => {
    const harness = createHarness();
    await harness.queue.enqueue(event(1));

    const raw = harness.storage.value ?? '';
    expect(raw).toContain('user:user-1');
    expect(raw).toContain('2023-11-14T22:13:20.000Z');
    expect(raw).not.toContain('token:user:user-1');
    expect(harness.queue.getEntriesForTests()[0]?.event.occurredAt)
      .toBe('2023-11-14T22:13:20.000Z');
  });

  it('flushes at ten entries with a fresh token', async () => {
    const harness = createHarness();
    for (let index = 0; index < 10; index += 1) await harness.queue.enqueue(event(index));
    await harness.queue.flush();

    expect(harness.sendBatch).toHaveBeenCalledTimes(1);
    expect(harness.sendBatch.mock.calls[0]?.[0]).toHaveLength(10);
    expect(harness.sendBatch.mock.calls[0]?.[1]).toEqual({ accessToken: 'token:user:user-1' });
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('chunks thirty restored events as 25 plus 5', async () => {
    const currentTime = 1_700_000_000_000;
    const initial = persistedEntries(Array.from({ length: 30 }, (_, index) => (
      persistedEntry(index, 'user:user-1', currentTime)
    )));
    const harness = createHarness({ initial, now: currentTime });
    await harness.queue.restore();
    await harness.queue.flush();

    expect(harness.sendBatch).toHaveBeenCalledTimes(2);
    expect(harness.sendBatch.mock.calls.map(([events]) => events.length)).toEqual([25, 5]);
  });

  it('never sends one user bucket with another identity token', async () => {
    const harness = createHarness({ identityKey: 'user:user-1' });
    await harness.queue.enqueue(event(1));
    harness.setIdentityKey('user:user-2');
    await harness.queue.enqueue(event(2));
    await harness.queue.flush();

    expect(harness.sendBatch).toHaveBeenCalledTimes(1);
    expect(harness.sendBatch.mock.calls[0]?.[0].map(({ clientEventId }) => clientEventId)).toEqual(['event-2']);
    expect(harness.sendBatch.mock.calls[0]?.[1]).toEqual({ accessToken: 'token:user:user-2' });
    expect(harness.queue.getEntriesForTests().map(({ identityKey }) => identityKey)).toEqual(['user:user-1']);

    harness.setIdentityKey('user:user-1');
    await harness.queue.flush();
    expect(harness.sendBatch.mock.calls[1]?.[1]).toEqual({ accessToken: 'token:user:user-1' });
  });

  it.each([500, 429, 408])('requeues retryable %s failures with backoff', async (status) => {
    const harness = createHarness();
    harness.sendBatch.mockRejectedValueOnce(Object.assign(new Error('retry'), { status }));
    await harness.queue.enqueue(event(1));
    await harness.queue.flush();

    const [retried] = harness.queue.getEntriesForTests();
    expect(retried?.attempts).toBe(1);
    expect(retried?.nextAttemptAt).toBe(1_700_000_002_000);
    expect(harness.sendBatch).toHaveBeenCalledTimes(1);

    harness.setNow(1_700_000_002_000);
    await harness.queue.flush();
    expect(harness.sendBatch).toHaveBeenCalledTimes(2);
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('persists real API network failures for retry', async () => {
    const harness = createHarness();
    harness.sendBatch.mockRejectedValueOnce(new ApiError('offline', 0));
    await harness.queue.enqueue(event(1));
    await harness.queue.flush();

    expect(harness.queue.getEntriesForTests()).toEqual([
      expect.objectContaining({ attempts: 1 }),
    ]);
  });

  it('persists exponential backoff when access-token acquisition fails', async () => {
    const harness = createHarness();
    harness.getAccessToken.mockRejectedValueOnce(new Error('refresh unavailable'));
    await harness.queue.enqueue(event(1));
    await harness.queue.flush();

    expect(harness.sendBatch).not.toHaveBeenCalled();
    expect(harness.queue.getEntriesForTests()).toEqual([
      expect.objectContaining({
        attempts: 1,
        nextAttemptAt: 1_700_000_002_000,
      }),
    ]);
    expect(JSON.parse(harness.storage.value ?? '{}').entries[0]).toEqual(
      expect.objectContaining({ attempts: 1, nextAttemptAt: 1_700_000_002_000 }),
    );

    harness.setNow(1_700_000_002_000);
    await harness.queue.flush();
    expect(harness.sendBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ clientEventId: 'event-1' })],
      { accessToken: 'token:user:user-1' },
    );
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('backs off when the current user has no usable access token yet', async () => {
    const harness = createHarness();
    harness.getAccessToken.mockResolvedValueOnce(null);
    await harness.queue.enqueue(event(1));
    await harness.queue.flush();

    expect(harness.sendBatch).not.toHaveBeenCalled();
    expect(harness.queue.getEntriesForTests()[0]).toEqual(expect.objectContaining({
      attempts: 1,
      nextAttemptAt: 1_700_000_002_000,
    }));
  });

  it('keeps a chunk durable until the server acknowledges it', async () => {
    const harness = createHarness();
    let acknowledge!: () => void;
    harness.sendBatch.mockImplementationOnce(() => new Promise((resolve) => {
      acknowledge = () => resolve({ success: true, recorded: 1, rejected: 0 });
    }));
    await harness.queue.enqueue(event(1));

    const flushing = harness.queue.flush();
    await vi.waitFor(() => expect(harness.sendBatch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(harness.storage.value ?? '{}').entries).toHaveLength(1);

    acknowledge();
    await flushing;
    expect(JSON.parse(harness.storage.value ?? '{}').entries).toHaveLength(0);
  });

  it('automatically retries at the actual backoff deadline', async () => {
    const harness = createHarness({ random: 1 });
    harness.sendBatch.mockRejectedValueOnce(Object.assign(new Error('retry'), { status: 500 }));
    await harness.queue.enqueue(event(1));
    await harness.queue.flush();

    const retryTimer = harness.timers.at(-1);
    expect(retryTimer?.delayMs).toBe(3_000);
    harness.setNow(1_700_000_003_000);
    retryTimer?.callback();
    await harness.queue.flush();

    expect(harness.sendBatch).toHaveBeenCalledTimes(2);
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('serializes the first enqueue behind an in-flight restore', async () => {
    let releaseRead!: (value: string | null) => void;
    const storage = createMemoryStorage();
    storage.getItem = () => new Promise((resolve) => { releaseRead = resolve; });
    const queue = createFeedEventQueue({
      storage,
      sendBatch: async () => ({ success: true }),
      getAccessToken: async () => 'token:user:user-1',
      getCurrentIdentityKey: async () => 'user:user-1',
      now: () => 1_700_000_000_000,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });

    const restoring = queue.restore();
    const enqueueing = queue.enqueue(event(2));
    await Promise.resolve();
    expect(queue.getEntriesForTests()).toHaveLength(0);

    releaseRead(persistedEntries([persistedEntry(1, 'user:user-1', 1_700_000_000_000)]));
    await Promise.all([restoring, enqueueing]);
    expect(queue.getEntriesForTests().map(({ event: queued }) => queued.clientEventId))
      .toEqual(['event-1', 'event-2']);
  });

  it('drains an installation bucket after a guest session appears', async () => {
    const harness = createHarness({ identityKey: 'installation:device-1' });
    await harness.queue.enqueue(event(1));
    harness.setIdentityKey('user:guest-1');
    await harness.queue.flush();

    expect(harness.sendBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ clientEventId: 'event-1' })],
      { accessToken: null },
    );
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('drains a guest bucket after registration with the captured guest token and backoff', async () => {
    const harness = createHarness({ identityKey: 'user:guest-1' });
    harness.sendBatch.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 500 }));
    await harness.queue.enqueue(event(1));

    const transition = harness.queue.beginIdentityTransition({
      identityKey: 'user:guest-1',
      accessToken: 'captured-guest-token',
    });
    harness.setIdentityKey('user:registered-1');
    transition.commit();
    await transition.drain;

    expect(harness.sendBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ clientEventId: 'event-1' })],
      { accessToken: 'captured-guest-token' },
    );
    expect(harness.queue.getEntriesForTests()[0]).toEqual(expect.objectContaining({ attempts: 1 }));
    expect(harness.storage.value).not.toContain('captured-guest-token');

    harness.setNow(1_700_000_002_000);
    await harness.queue.flush();
    expect(harness.sendBatch).toHaveBeenCalledTimes(2);
    expect(harness.sendBatch.mock.calls[1]?.[1]).toEqual({ accessToken: 'captured-guest-token' });
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('keeps the outgoing credential until auth commits so late transition events can drain', async () => {
    const harness = createHarness({ identityKey: 'user:guest-1' });
    await harness.queue.enqueue(event(1));
    const transition = harness.queue.beginIdentityTransition({
      identityKey: 'user:guest-1',
      accessToken: 'captured-guest-token',
    });
    await transition.drain;
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);

    // A final dwell/open can arrive while the actual OAuth operation is still
    // running, after the first drain has already completed.
    await harness.queue.enqueue(event(2));
    harness.setIdentityKey('user:registered-1');
    transition.commit();
    await harness.queue.flush();

    expect(harness.sendBatch).toHaveBeenCalledTimes(2);
    expect(harness.sendBatch.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ clientEventId: 'event-2' }),
    ]);
    expect(harness.sendBatch.mock.calls[1]?.[1]).toEqual({ accessToken: 'captured-guest-token' });
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('does not await an in-flight registered-to-guest transition drain', async () => {
    const harness = createHarness({ identityKey: 'user:registered-1' });
    let acknowledge!: () => void;
    harness.sendBatch.mockImplementationOnce(() => new Promise((resolve) => {
      acknowledge = () => resolve({ success: true, recorded: 1, rejected: 0 });
    }));
    await harness.queue.enqueue(event(1));

    const transition = harness.queue.beginIdentityTransition({
      identityKey: 'user:registered-1',
      accessToken: 'captured-registered-token',
    });
    harness.setIdentityKey('user:guest-2');
    transition.commit();
    await vi.waitFor(() => expect(harness.sendBatch).toHaveBeenCalledTimes(1));

    let drainFinished = false;
    void transition.drain.then(() => { drainFinished = true; });
    await Promise.resolve();
    expect(drainFinished).toBe(false);
    expect(harness.sendBatch.mock.calls[0]?.[1]).toEqual({
      accessToken: 'captured-registered-token',
    });

    acknowledge();
    await transition.drain;
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('retires an unreachable outgoing user bucket after the bounded drain window', async () => {
    const harness = createHarness({ identityKey: 'user:registered-1' });
    harness.sendBatch.mockRejectedValue(Object.assign(new Error('offline'), { status: 500 }));
    await harness.queue.enqueue(event(1));

    const transition = harness.queue.beginIdentityTransition({
      identityKey: 'user:registered-1',
      accessToken: 'captured-registered-token',
    });
    harness.setIdentityKey('user:guest-2');
    transition.commit();
    await transition.drain;
    expect(harness.queue.getEntriesForTests()).toHaveLength(1);

    harness.setNow(1_700_000_000_000 + FEED_EVENT_QUEUE_TRANSITION_DRAIN_MS);
    await harness.queue.flush();
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
    expect(JSON.parse(harness.storage.value ?? '{}').retiringIdentities).toEqual([]);
  });

  it('restores the non-secret retirement marker after a transition-time restart', async () => {
    const first = createHarness({ identityKey: 'user:registered-1' });
    first.sendBatch.mockRejectedValue(Object.assign(new Error('offline'), { status: 500 }));
    await first.queue.enqueue(event(1));
    const transition = first.queue.beginIdentityTransition({
      identityKey: 'user:registered-1',
      accessToken: 'memory-only-token',
    });
    first.setIdentityKey('user:guest-2');
    transition.commit();
    await transition.drain;

    const restarted = createHarness({
      initial: first.storage.value,
      identityKey: 'user:guest-2',
      now: 1_700_000_000_000 + FEED_EVENT_QUEUE_TRANSITION_DRAIN_MS,
    });
    await restarted.queue.restore();
    await restarted.queue.flush();

    expect(restarted.sendBatch).not.toHaveBeenCalled();
    expect(restarted.queue.getEntriesForTests()).toHaveLength(0);
    expect(restarted.storage.value).not.toContain('memory-only-token');
  });

  it('cancels retirement when the authentication attempt fails', async () => {
    const harness = createHarness({ identityKey: 'user:guest-1' });
    harness.sendBatch.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 500 }));
    await harness.queue.enqueue(event(1));

    const transition = harness.queue.beginIdentityTransition({
      identityKey: 'user:guest-1',
      accessToken: 'captured-guest-token',
    });
    await transition.drain;
    transition.cancel();

    harness.setNow(1_700_000_002_000);
    await harness.queue.flush();
    expect(harness.sendBatch.mock.calls[1]?.[1]).toEqual({ accessToken: 'token:user:guest-1' });
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('drops terminal 400 failures instead of poisoning later flushes', async () => {
    const harness = createHarness();
    harness.sendBatch.mockRejectedValueOnce(Object.assign(new Error('terminal'), { status: 400 }));
    await harness.queue.enqueue(event(1));
    await harness.queue.flush();
    expect(harness.queue.getEntriesForTests()).toHaveLength(0);
  });

  it('caps the queue by dropping the oldest entries', async () => {
    const currentTime = 1_700_000_000_000;
    const initial = persistedEntries(Array.from({ length: FEED_EVENT_QUEUE_MAX_ENTRIES + 5 }, (_, index) => (
      persistedEntry(index, 'user:user-1', currentTime + index)
    )));
    const harness = createHarness({ initial, now: currentTime + FEED_EVENT_QUEUE_MAX_ENTRIES + 5 });
    await harness.queue.restore();
    const restored = harness.queue.getEntriesForTests();
    expect(restored).toHaveLength(FEED_EVENT_QUEUE_MAX_ENTRIES);
    expect(restored[0]?.event.clientEventId).toBe('event-5');
  });

  it('drops entries older than 24 hours during restore', async () => {
    const currentTime = 1_700_000_000_000;
    const initial = persistedEntries([
      persistedEntry(1, 'user:user-1', currentTime - FEED_EVENT_QUEUE_MAX_AGE_MS - 1),
      persistedEntry(2, 'user:user-1', currentTime),
    ]);
    const harness = createHarness({ initial, now: currentTime });
    await harness.queue.restore();
    expect(harness.queue.getEntriesForTests().map(({ event: queued }) => queued.clientEventId))
      .toEqual(['event-2']);
  });

  it('continues in memory when storage reads and writes fail', async () => {
    const queue = createFeedEventQueue({
      storage: {
        getItem: async () => { throw new Error('read failed'); },
        setItem: async () => { throw new Error('write failed'); },
      },
      sendBatch: async () => ({ success: true }),
      getAccessToken: async () => null,
      getCurrentIdentityKey: async () => 'installation:device-1',
      setTimer: () => 1,
      clearTimer: () => undefined,
    });

    await expect(queue.enqueue(event(1))).resolves.toBe(true);
    await expect(queue.flush()).resolves.toBeUndefined();
  });
});
