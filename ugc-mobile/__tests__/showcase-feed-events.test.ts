import type { InfiniteData } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOWCASE_PLAYBACK_VIEWABILITY,
  SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY,
  buildShowcaseFeedEventRequest,
  canRecordShowcaseFeedEvent,
  feedFeedbackUndoMessage,
  filterAnonymousSessionShowcaseFeedItems,
  findShowcaseFeedItemPositions,
  forgetAnonymousShowcaseFeedRemoval,
  getQualifiedImpressionKey,
  rememberAnonymousShowcaseFeedRemoval,
  removeShowcaseFeedItems,
  removeShowcaseFeedItemsFromInfiniteData,
  resetAnonymousShowcaseFeedRemovalsForTests,
  resetFeedFeedbackRequestsForTests,
  restoreShowcaseFeedItemsToInfiniteData,
  trackFeedFeedbackRequest,
  undoFeedFeedback,
  type ShowcaseFeedFeedbackTarget,
} from '../lib/showcase-feed-events';
import type { ShowcaseFeedItem, ShowcaseFeedResponse, UndoFeedFeedbackRequest, UndoFeedFeedbackResponse } from '../lib/types';

function item(id: string, creatorId: string | null): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: null,
    mediaKind: null,
    model: 'manual',
    title: `Post ${id}`,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-07-11T00:00:00.000Z',
    creator: { id: creatorId, username: creatorId, name: creatorId ?? 'Creator', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

describe('showcase ranked-feed events', () => {
  beforeEach(() => resetAnonymousShowcaseFeedRemovalsForTests());

  it('keeps video playback activation separate from qualified impression timing', () => {
    expect(SHOWCASE_PLAYBACK_VIEWABILITY).toEqual({
      itemVisiblePercentThreshold: 55,
      minimumViewTime: 180,
    });
    expect(SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY).toEqual({
      itemVisiblePercentThreshold: 50,
      minimumViewTime: 1000,
    });
  });

  it('builds event payloads from delivery metadata without losing explicit overrides', () => {
    const request = buildShowcaseFeedEventRequest({
      postId: 'post-1',
      recommendation: {
        deliveryId: 'delivery-1',
        position: 8,
        reason: 'Because you save product videos',
        algorithmVersion: 'hybrid-v1',
      },
    }, 'impression', {
      feedSessionId: 'session-1',
      algorithmVersion: 'hybrid-v1',
      sourceSurface: 'showcase',
    }, {
      durationMs: 1000,
      position: 3,
      metadata: { qualification: 'viewability' },
    });

    expect(request).toMatchObject({
      feedSessionId: 'session-1',
      deliveryId: 'delivery-1',
      postId: 'post-1',
      eventType: 'impression',
      position: 3,
      durationMs: 1000,
      sourceSurface: 'showcase',
      metadata: {
        algorithmVersion: 'hybrid-v1',
        recommendationReason: 'Because you save product videos',
        qualification: 'viewability',
      },
    });
    expect(request.clientEventId).toMatch(/^showcase:/);
    expect(getQualifiedImpressionKey({
      postId: 'post-1',
      recommendation: { deliveryId: 'delivery-1', position: 8 },
    }, 'session-1')).toBe('delivery-1');
  });

  it('skips delivery-bound telemetry for an unranked fallback item', () => {
    const target = { postId: 'post-1' };

    expect(canRecordShowcaseFeedEvent(target, 'impression')).toBe(false);
    expect(canRecordShowcaseFeedEvent(target, 'share')).toBe(false);
    expect(canRecordShowcaseFeedEvent(target, 'not_interested')).toBe(true);
    expect(canRecordShowcaseFeedEvent({
      ...target,
      recommendation: { deliveryId: 'delivery-1', position: 0 },
    }, 'impression')).toBe(true);
  });

  it('removes one dismissed post or every post from a hidden creator across pages', () => {
    const first = item('post-1', 'creator-a');
    const second = item('post-2', 'creator-b');
    const third = item('post-3', 'creator-a');

    expect(removeShowcaseFeedItems([first, second, third], { postId: 'post-1' }).map(({ id }) => id))
      .toEqual(['post-2', 'post-3']);

    const result = removeShowcaseFeedItemsFromInfiniteData({
      pages: [
        { items: [first, second] },
        { items: [third] },
      ],
      pageParams: [{ offset: 0 }, { cursor: 'next' }],
    }, { creatorId: 'creator-a' });

    expect(result?.pages.flatMap((page) => page.items).map(({ id }) => id)).toEqual(['post-2']);
    expect(result?.pageParams).toEqual([{ offset: 0 }, { cursor: 'next' }]);

    expect(removeShowcaseFeedItems([
      item('post-4', null),
      item('post-5', null),
    ], { creatorId: null }).map(({ id }) => id)).toEqual(['post-4', 'post-5']);
  });

  it('keeps anonymous feedback applied to pages fetched later and can roll it back', () => {
    const first = item('post-1', 'creator-a');
    const sameCreatorLater = item('post-2', 'creator-a');
    const otherCreator = item('post-3', 'creator-b');
    const target = { creatorId: 'creator-a' };

    rememberAnonymousShowcaseFeedRemoval(target);
    expect(filterAnonymousSessionShowcaseFeedItems([first, sameCreatorLater, otherCreator]))
      .toEqual([otherCreator]);

    forgetAnonymousShowcaseFeedRemoval(target);
    expect(filterAnonymousSessionShowcaseFeedItems([sameCreatorLater, otherCreator]))
      .toEqual([sameCreatorLater, otherCreator]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
}

function undoApi(answer: () => Promise<UndoFeedFeedbackResponse> = async () => ({ ok: true, removed: true })) {
  return { undoFeedFeedback: vi.fn((_body: UndoFeedFeedbackRequest) => answer()) };
}

// D7 (2026-10-14): Undo deletes the stored choice (C1); the original event stays in the facts.
describe('undoing a Not interested or a Hide', () => {
  const notInterested: ShowcaseFeedFeedbackTarget = { feedbackType: 'not_interested', postId: 'post-1' };
  const hideCreator: ShowcaseFeedFeedbackTarget = { feedbackType: 'hide_creator', creatorId: 'creator-a' };

  beforeEach(() => {
    resetAnonymousShowcaseFeedRemovalsForTests();
    resetFeedFeedbackRequestsForTests();
  });

  it('sends nothing for a device with no session and clears what the device remembered', async () => {
    const api = undoApi();
    rememberAnonymousShowcaseFeedRemoval(hideCreator);
    expect(filterAnonymousSessionShowcaseFeedItems([item('post-2', 'creator-a')])).toEqual([]);

    await expect(undoFeedFeedback(api, hideCreator, { hasSession: false }))
      .resolves.toEqual({ removed: false, local: true });

    expect(api.undoFeedFeedback).not.toHaveBeenCalled();
    expect(filterAnonymousSessionShowcaseFeedItems([item('post-2', 'creator-a')]).map(({ id }) => id)).toEqual(['post-2']);
  });

  it('asks the server to delete the row and answers what it said', async () => {
    const api = undoApi(async () => ({ ok: true, removed: false }));

    await expect(undoFeedFeedback(api, notInterested, { hasSession: true }))
      .resolves.toEqual({ ok: true, removed: false });
    await expect(undoFeedFeedback(api, hideCreator, { hasSession: true }))
      .resolves.toEqual({ ok: true, removed: false });

    expect(api.undoFeedFeedback.mock.calls.map(([body]) => body)).toEqual([
      { feedbackType: 'not_interested', postId: 'post-1' },
      { feedbackType: 'hide_creator', creatorId: 'creator-a' },
    ]);
  });

  // Sent first, the undo could find no row and the late hide would then write it.
  it('waits for the hide still on the wire before sending the undo', async () => {
    const api = undoApi();
    const hide = deferred<{ success: boolean }>();
    const sent = trackFeedFeedbackRequest(notInterested, hide.promise);
    expect(sent).toBe(hide.promise);

    const undo = undoFeedFeedback(api, notInterested, { hasSession: true });
    await flushPromises();
    expect(api.undoFeedFeedback).not.toHaveBeenCalled();

    hide.resolve({ success: true });
    await expect(undo).resolves.toEqual({ ok: true, removed: true });
    expect(api.undoFeedFeedback).toHaveBeenCalledTimes(1);
  });

  it('still sends the undo once a failed hide has settled, which may have written the row', async () => {
    const api = undoApi();
    const hide = deferred<never>();
    // The screen's own catch sees the failure as before.
    const screenSaw = trackFeedFeedbackRequest(hideCreator, hide.promise).catch((error: unknown) => error);

    const undo = undoFeedFeedback(api, hideCreator, { hasSession: true });
    await flushPromises();
    expect(api.undoFeedFeedback).not.toHaveBeenCalled();

    const failure = Object.assign(new Error('Request timed out'), { status: 0 });
    hide.reject(failure);
    await expect(screenSaw).resolves.toBe(failure);
    await expect(undo).resolves.toEqual({ ok: true, removed: true });
    expect(api.undoFeedFeedback).toHaveBeenCalledTimes(1);
  });

  it('waits only for its own choice', async () => {
    const api = undoApi();
    const otherPost = deferred<{ success: boolean }>();
    trackFeedFeedbackRequest({ feedbackType: 'not_interested', postId: 'post-9' }, otherPost.promise);
    // The choice is part of what is waited on, not only the id.
    trackFeedFeedbackRequest({ feedbackType: 'not_interested', postId: 'creator-a' }, otherPost.promise);

    await expect(undoFeedFeedback(api, hideCreator, { hasSession: true })).resolves.toEqual({ ok: true, removed: true });
    expect(api.undoFeedFeedback).toHaveBeenCalledTimes(1);
    otherPost.resolve({ success: true });
  });

  it('waits for every request of the same choice still on the wire', async () => {
    const api = undoApi();
    const first = deferred<{ success: boolean }>();
    const second = deferred<{ success: boolean }>();
    trackFeedFeedbackRequest(notInterested, first.promise);
    trackFeedFeedbackRequest(notInterested, second.promise);

    const undo = undoFeedFeedback(api, notInterested, { hasSession: true });
    second.resolve({ success: true });
    await flushPromises();
    expect(api.undoFeedFeedback).not.toHaveBeenCalled();

    first.resolve({ success: true });
    await undo;
    expect(api.undoFeedFeedback).toHaveBeenCalledTimes(1);
  });

  it('sends at once when the hide has already been answered', async () => {
    const api = undoApi();
    trackFeedFeedbackRequest(notInterested, Promise.resolve({ success: true }));
    await flushPromises();

    const undo = undoFeedFeedback(api, notInterested, { hasSession: true });
    expect(api.undoFeedFeedback).toHaveBeenCalledTimes(1);
    await expect(undo).resolves.toEqual({ ok: true, removed: true });
  });

  it("clears a guest session's device memory once the server has answered", async () => {
    const api = undoApi();
    rememberAnonymousShowcaseFeedRemoval(notInterested);

    await undoFeedFeedback(api, notInterested, { hasSession: true });

    expect(filterAnonymousSessionShowcaseFeedItems([item('post-1', 'creator-b')]).map(({ id }) => id)).toEqual(['post-1']);
  });

  it('keeps the post hidden on later pages when the server refuses the undo', async () => {
    const refusal = Object.assign(new Error('Too many requests'), { status: 429 });
    const api = undoApi(async () => {
      throw refusal;
    });
    rememberAnonymousShowcaseFeedRemoval(notInterested);

    await expect(undoFeedFeedback(api, notInterested, { hasSession: true })).rejects.toBe(refusal);

    expect(filterAnonymousSessionShowcaseFeedItems([item('post-1', 'creator-b')])).toEqual([]);
  });

  it('refuses a target without the id its choice needs, and sends nothing', async () => {
    const api = undoApi();

    await expect(undoFeedFeedback(api, { feedbackType: 'hide_creator', postId: 'post-1' }, { hasSession: true }))
      .rejects.toThrow('Undoing Hide needs the creator it hid.');
    await expect(undoFeedFeedback(api, { feedbackType: 'not_interested', creatorId: 'creator-a' }, { hasSession: true }))
      .rejects.toThrow('Undoing Not interested needs the post it removed.');
    expect(api.undoFeedFeedback).not.toHaveBeenCalled();
  });

  it('words the notice for each choice', () => {
    expect(feedFeedbackUndoMessage('not_interested')).toBe('Post hidden');
    expect(feedFeedbackUndoMessage('hide_creator')).toBe('Creator hidden');
  });
});

describe('putting removed posts back where they were', () => {
  function lane(...pages: ShowcaseFeedItem[][]): InfiniteData<ShowcaseFeedResponse> {
    return { pages: pages.map((items) => ({ items })), pageParams: pages.map((_, index) => index) };
  }
  const ids = (data: InfiniteData<ShowcaseFeedResponse> | undefined) => data?.pages.map((page) => page.items.map(({ id }) => id));

  it("returns a hidden creator's posts to the indices they left, on every page", () => {
    const before = lane(
      [item('a1', 'creator-a'), item('b1', 'creator-b'), item('a2', 'creator-a'), item('c1', 'creator-c')],
      [item('b2', 'creator-b'), item('a3', 'creator-a')],
    );
    const target = { creatorId: 'creator-a' };
    const positions = findShowcaseFeedItemPositions(before, target);
    expect(positions.map(({ pageIndex, index, item: { id } }) => [pageIndex, index, id]))
      .toEqual([[0, 0, 'a1'], [0, 2, 'a2'], [1, 1, 'a3']]);

    const removed = removeShowcaseFeedItemsFromInfiniteData(before, target);
    expect(ids(removed)).toEqual([['b1', 'c1'], ['b2']]);

    const restored = restoreShowcaseFeedItemsToInfiniteData(removed, positions);
    expect(ids(restored)).toEqual(ids(before));
    expect(restored?.pageParams).toEqual(before.pageParams);
  });

  it('keeps a page loaded since the removal, rather than going back to the copy from before it', () => {
    const before = lane([item('p1', 'creator-a'), item('p2', 'creator-b')]);
    const positions = findShowcaseFeedItemPositions(before, { postId: 'p1' });
    const removed = removeShowcaseFeedItemsFromInfiniteData(before, { postId: 'p1' })!;
    const scrolledOn: InfiniteData<ShowcaseFeedResponse> = {
      pages: [...removed.pages, { items: [item('p3', 'creator-c')] }],
      pageParams: [...removed.pageParams, 1],
    };

    expect(ids(restoreShowcaseFeedItemsToInfiniteData(scrolledOn, positions))).toEqual([['p1', 'p2'], ['p3']]);
  });

  it('adds nothing the lane holds again, and nothing to a page it no longer has', () => {
    const before = lane([item('p1', 'creator-a'), item('p2', 'creator-b')], [item('p3', 'creator-a')]);
    const positions = findShowcaseFeedItemPositions(before, { creatorId: 'creator-a' });
    // A refresh in the meantime: page 1 only, and it brought p1 back already.
    const refreshed = lane([item('p1', 'creator-a'), item('p4', 'creator-d')]);

    expect(ids(restoreShowcaseFeedItemsToInfiniteData(refreshed, positions))).toEqual([['p1', 'p4']]);
    expect(restoreShowcaseFeedItemsToInfiniteData(undefined, positions)).toBeUndefined();
    expect(restoreShowcaseFeedItemsToInfiniteData(refreshed, [])).toBe(refreshed);
  });
});
