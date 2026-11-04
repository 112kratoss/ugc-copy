import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FEED_EVENT_FLUSH_BEFORE_REFRESH_MS,
  flushShowcaseFeedEvents,
  flushShowcaseFeedEventsBeforeRefresh,
  resetShowcaseFeedEventQueueForTests,
  sendShowcaseFeedEvent,
} from '@/app/showcase/ShowcaseFeedInteraction';
import { FEED_EVENT_OUTBOX_ADOPT_AFTER_MS, FEED_EVENT_OUTBOX_STORAGE_KEY } from '@/app/showcase/feed-event-outbox';
import type { ShowcaseFeedItem } from '@/lib/showcase';

function signedInToken(sub: string) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'ES256' })}.${encode({ sub })}.signature`;
}

function outboxIds() {
  const raw = window.localStorage.getItem(FEED_EVENT_OUTBOX_STORAGE_KEY);
  return raw ? (JSON.parse(raw).entries as Array<{ id: string }>).map(({ id }) => id) : [];
}

function rankedItem(): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://example.com/clip.mp4',
    mediaKind: 'video',
    model: 'manual',
    title: 'Campaign clip',
    prompt: '',
    body: '',
    category: 'video',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
    isSaved: false,
    sourceKind: 'manual',
    sourceTool: null,
    generationId: null,
    asset: null,
    canRemix: false,
    // Most feed events are dropped without delivery context.
    recommendation: { deliveryId: 'delivery-1', position: 3, algorithmVersion: 'feed-v1' },
  } as unknown as ShowcaseFeedItem;
}

function eventRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === '/api/showcase/feed/events')
    .map(([, init]) => JSON.parse(String((init as RequestInit)?.body)) as Record<string, unknown>);
}

describe('showcase feed event batching', () => {
  beforeEach(() => {
    resetShowcaseFeedEventQueueForTests();
  });

  afterEach(() => {
    resetShowcaseFeedEventQueueForTests();
    vi.unstubAllGlobals();
  });

  it('sends a watch session as one request instead of one per event', async () => {
    // open, impression, dwell and four progress milestones is the ~7 requests a
    // fully-watched reel used to cost, each re-running auth and a rate-limit
    // write transaction.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    for (const eventType of ['open', 'impression', 'dwell', 'media_progress'] as const) {
      await sendShowcaseFeedEvent({
        item: rankedItem(),
        eventType,
        sourceSurface: 'showcase',
        accessToken: 'token-1',
        feedSessionId: 'session-1',
      });
    }

    // Still queued: nothing has gone out.
    expect(fetchMock).not.toHaveBeenCalled();

    await flushShowcaseFeedEvents();

    const requests = eventRequests(fetchMock);
    expect(requests).toHaveLength(1);
    expect((requests[0].events as unknown[])).toHaveLength(4);
    expect((requests[0].events as Array<{ eventType: string }>).map((event) => event.eventType))
      .toEqual(['open', 'impression', 'dwell', 'media_progress']);
  });

  it('sends state-changing events immediately and still reports failure', async () => {
    // The not-interested flow hides a post optimistically and restores it when
    // this request fails, so it cannot be deferred behind a queue.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendShowcaseFeedEvent({
      item: rankedItem(),
      eventType: 'not_interested',
      sourceSurface: 'showcase',
      accessToken: 'token-1',
      feedSessionId: 'session-1',
    })).rejects.toThrow(/failed with 500/);

    const requests = eventRequests(fetchMock);
    expect(requests).toHaveLength(1);
    // A bare event, not a one-item batch: the batch response reports a rejected
    // event inside a 200, which would hide the failure from the caller.
    expect(requests[0].events).toBeUndefined();
    expect(requests[0].eventType).toBe('not_interested');
  });

  // Every request costs a function, the proxy's admission and two rate-limit
  // writes, so a batch waits for company: until 15 s pass without a new event,
  // a minute at most, or until it is full.
  it('sends a batch once 15 s pass without a new event, a minute after its first at the latest, or at once when 25 have queued', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const send = () => sendShowcaseFeedEvent({
        item: rankedItem(),
        eventType: 'impression',
        sourceSurface: 'feed',
        accessToken: 'token-1',
        feedSessionId: 'session-1',
      });

      await send();
      await vi.advanceTimersByTimeAsync(10_000);
      await send();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(eventRequests(fetchMock)).toHaveLength(1);
      expect(eventRequests(fetchMock)[0].events).toHaveLength(2);

      // A reader who keeps going: one request a minute.
      for (let second = 0; second < 60; second += 10) {
        await send();
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(eventRequests(fetchMock)).toHaveLength(2);
      expect(eventRequests(fetchMock)[1].events).toHaveLength(6);

      for (let index = 0; index < 25; index += 1) await send();
      expect(eventRequests(fetchMock)).toHaveLength(3);
      expect(eventRequests(fetchMock)[2].events).toHaveLength(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a viewer's events on the device, never the token, until the server answers", async () => {
    let answer!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const token = signedInToken('user-1');

    await sendShowcaseFeedEvent({ item: rankedItem(), eventType: 'impression', sourceSurface: 'feed', accessToken: token, feedSessionId: 'session-1' });
    const stored = window.localStorage.getItem(FEED_EVENT_OUTBOX_STORAGE_KEY) ?? '';
    expect(outboxIds()).toHaveLength(1);
    expect(stored).toContain('user:user-1');
    expect(stored).not.toContain(token);

    const flushing = flushShowcaseFeedEvents();
    expect(outboxIds()).toHaveLength(1);
    answer(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await flushing;
    expect(outboxIds()).toEqual([]);
  });

  it("sends what a failed send or a killed page left with the same viewer's next batch, at the time it happened", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
      fetchMock.mockRejectedValueOnce(new TypeError('offline'));
      vi.stubGlobal('fetch', fetchMock);
      const token = signedInToken('user-1');
      const send = () => sendShowcaseFeedEvent({ item: rankedItem(), eventType: 'impression', sourceSurface: 'feed', accessToken: token, feedSessionId: 'session-1' });

      await send();
      await flushShowcaseFeedEvents();
      const [lost] = outboxIds();
      expect(lost).toBeTruthy();

      // A page that died with a batch waiting left its own.
      window.localStorage.setItem(FEED_EVENT_OUTBOX_STORAGE_KEY, JSON.stringify({
        version: 1,
        entries: [
          ...JSON.parse(window.localStorage.getItem(FEED_EVENT_OUTBOX_STORAGE_KEY) ?? '{}').entries,
          { id: 'from-a-dead-page', identity: 'user:user-1', owner: 'dead-page', queuedAt: start, body: { clientEventId: 'from-a-dead-page', eventType: 'dwell' } },
          { id: 'another-viewer', identity: 'user:user-2', owner: 'dead-page', queuedAt: start, body: { clientEventId: 'another-viewer', eventType: 'dwell' } },
        ],
      }));

      now.mockReturnValue(start + FEED_EVENT_OUTBOX_ADOPT_AFTER_MS);
      await send();
      await flushShowcaseFeedEvents();

      const [, retried] = eventRequests(fetchMock);
      const events = retried.events as Array<{ clientEventId: string; occurredAt?: string }>;
      expect(events.map(({ clientEventId }) => clientEventId)).toEqual(expect.arrayContaining([lost, 'from-a-dead-page']));
      expect(events).toHaveLength(3);
      expect(events.find(({ clientEventId }) => clientEventId === lost)?.occurredAt).toBe(new Date(start).toISOString());
      expect((fetchMock.mock.calls[1] as unknown[] as [string, RequestInit])[1].headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${token}` }));
      // Another viewer's event waits for a page of theirs.
      expect(outboxIds()).toEqual(['another-viewer']);
    } finally {
      now.mockRestore();
    }
  });

  it('lets a leaving page take its batch out of the outbox as the request goes, as a hidden one sent', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const token = signedInToken('user-1');
    const send = () => sendShowcaseFeedEvent({ item: rankedItem(), eventType: 'impression', sourceSurface: 'feed', accessToken: token, feedSessionId: 'session-1' });

    await send();
    void flushShowcaseFeedEvents();
    await send();
    expect(outboxIds()).toHaveLength(2);

    void flushShowcaseFeedEvents({ unloading: true });

    expect(eventRequests(fetchMock)).toHaveLength(2);
    expect(outboxIds()).toEqual([]);
  });

  // A first page can start a new ranked session, whose seen check reads the
  // impressions recorded by then: a refresh waits until the queued ones are.
  it('lets a feed refresh wait for every queued and unanswered event, 1.5 s at most', async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answers.push(resolve); }));
    vi.stubGlobal('fetch', fetchMock);
    const send = () => sendShowcaseFeedEvent({ item: rankedItem(), eventType: 'impression', sourceSurface: 'feed', accessToken: 'token-1', feedSessionId: 'session-1' });

    // One batch already on its way, one still queued.
    await send();
    void flushShowcaseFeedEvents();
    await send();
    let ready = false;
    const waiting = flushShowcaseFeedEventsBeforeRefresh().then(() => { ready = true; });
    expect(eventRequests(fetchMock)).toHaveLength(2);
    await Promise.resolve();
    expect(ready).toBe(false);

    answers[1](new Response(JSON.stringify({ success: true }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).toBe(false);
    answers[0](new Response(JSON.stringify({ success: true }), { status: 200 }));
    await waiting;
    expect(ready).toBe(true);

    // A send that never answers holds a refresh 1.5 s, no more.
    vi.useFakeTimers();
    try {
      await send();
      let released = false;
      const held = flushShowcaseFeedEventsBeforeRefresh().then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(FEED_EVENT_FLUSH_BEFORE_REFRESH_MS - 1);
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await held;
      expect(released).toBe(true);
      expect(FEED_EVENT_FLUSH_BEFORE_REFRESH_MS).toBe(1_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a queued batch separate from an immediate event', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendShowcaseFeedEvent({
      item: rankedItem(),
      eventType: 'impression',
      sourceSurface: 'showcase',
      accessToken: 'token-1',
      feedSessionId: 'session-1',
    });
    await sendShowcaseFeedEvent({
      item: rankedItem(),
      eventType: 'save',
      sourceSurface: 'showcase',
      accessToken: 'token-1',
      feedSessionId: 'session-1',
    });

    // The save went straight out; the impression is still queued behind it.
    expect(eventRequests(fetchMock)).toHaveLength(1);
    expect(eventRequests(fetchMock)[0].eventType).toBe('save');

    await flushShowcaseFeedEvents();
    expect(eventRequests(fetchMock)).toHaveLength(2);
    expect((eventRequests(fetchMock)[1].events as Array<{ eventType: string }>)[0].eventType)
      .toBe('impression');
  });
});
