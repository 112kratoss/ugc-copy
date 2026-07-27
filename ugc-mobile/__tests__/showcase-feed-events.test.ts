import { beforeEach, describe, expect, it } from 'vitest';

import {
  SHOWCASE_PLAYBACK_VIEWABILITY,
  SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY,
  buildShowcaseFeedEventRequest,
  canRecordShowcaseFeedEvent,
  filterAnonymousSessionShowcaseFeedItems,
  forgetAnonymousShowcaseFeedRemoval,
  getQualifiedImpressionKey,
  rememberAnonymousShowcaseFeedRemoval,
  removeShowcaseFeedItems,
  removeShowcaseFeedItemsFromInfiniteData,
  resetAnonymousShowcaseFeedRemovalsForTests,
} from '../lib/showcase-feed-events';
import type { ShowcaseFeedItem } from '../lib/types';

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
