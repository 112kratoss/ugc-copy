import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  flushShowcaseFeedEvents,
  resetShowcaseFeedEventQueueForTests,
  sendShowcaseFeedEvent,
} from '@/app/showcase/ShowcaseFeedInteraction';
import type { ShowcaseFeedItem } from '@/lib/showcase';

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
