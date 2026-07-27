import { describe, expect, it } from 'vitest';

import {
  applyShowcaseSaveStateToFeedResponse,
  applyShowcaseSaveStateToPostResponse,
  applyShowcaseSaveStateToSourceData,
  scheduleShowcaseSaveCompletionEffects,
} from '../lib/showcase-save-cache';
import type { ShowcaseFeedItem, ShowcaseFeedResponse, ShowcasePostResponse } from '../lib/types';

function item(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'image.png',
    mediaKind: 'image',
    model: 'manual',
    title: 'Saved post',
    prompt: 'Prompt',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 4,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-06-10T00:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    isSaved: false,
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

describe('showcase save cache helpers', () => {
  it('updates feed item saved state and save count without mutating the original response', () => {
    const response: ShowcaseFeedResponse = {
      items: [
        item(),
        item({ id: 'post-2', title: 'Other post', saveCount: 8 }),
      ],
      pageInfo: { hasMore: false, nextOffset: null },
    };

    const updated = applyShowcaseSaveStateToFeedResponse(response, {
      postId: 'post-1',
      isSaved: true,
      saveCount: 5,
    });

    expect(updated?.items[0]).toMatchObject({
      id: 'post-1',
      isSaved: true,
      saveCount: 5,
    });
    expect(updated?.items[1]).toMatchObject({
      id: 'post-2',
      isSaved: false,
      saveCount: 8,
    });
    expect(response.items[0]).toMatchObject({
      isSaved: false,
      saveCount: 4,
    });
  });

  it('removes unsaved items from saved-only source data', () => {
    const sourceData = {
      showcaseItems: [
        item({ isSaved: true, saveCount: 5 }),
        item({ id: 'post-2', isSaved: true, saveCount: 8 }),
      ],
    };

    const updated = applyShowcaseSaveStateToSourceData(sourceData, {
      postId: 'post-1',
      isSaved: false,
      saveCount: 4,
    }, {
      removeWhenUnsaved: true,
    });

    expect(updated?.showcaseItems?.map((candidate) => candidate.id)).toEqual(['post-2']);
  });

  it('normalizes a raw cached detail item before applying saved state', () => {
    const rawCachedDetail = item({ isSaved: false, saveCount: 4 }) as unknown as ShowcasePostResponse;

    const updated = applyShowcaseSaveStateToPostResponse(rawCachedDetail, {
      postId: 'post-1',
      isSaved: true,
      saveCount: 5,
    });

    expect(updated).toMatchObject({
      success: true,
      item: {
        id: 'post-1',
        isSaved: true,
        saveCount: 5,
      },
    });
  });

  it('schedules post-save refresh work without blocking the saved-state indicator', () => {
    const neverSettlingWork = new Promise(() => undefined);
    const invalidatedKeys: Array<readonly unknown[]> = [];
    let hapticCount = 0;

    const result = scheduleShowcaseSaveCompletionEffects({
      postId: 'post-1',
      userId: 'user-1',
      hapticFeedback: () => {
        hapticCount += 1;
        return neverSettlingWork;
      },
      invalidateQueries: (filters) => {
        invalidatedKeys.push(filters.queryKey);
        return neverSettlingWork;
      },
    });

    expect(result).toBeUndefined();
    expect(hapticCount).toBe(1);
    expect(invalidatedKeys).toEqual([
      ['showcase-feed'],
      ['showcase-post', 'post-1'],
      ['profile-saved-media', 'user-1'],
    ]);
  });
});
