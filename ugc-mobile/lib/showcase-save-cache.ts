import type { InfiniteData } from '@tanstack/react-query';

import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import type { ShowcaseFeedItem, ShowcaseFeedResponse, ShowcasePostResponse } from '@/lib/types';

export interface ShowcaseSaveStateResult {
  postId: string;
  isSaved: boolean;
  saveCount: number;
}

type SaveRefreshQueryFilters = {
  queryKey: readonly unknown[];
};

type SaveRefreshWork = Promise<unknown> | unknown;

export interface ShowcaseSaveCompletionEffects {
  postId: string;
  userId?: string;
  hapticFeedback?: () => SaveRefreshWork;
  invalidateQueries: (filters: SaveRefreshQueryFilters) => SaveRefreshWork;
}

type ShowcasePostCacheEntry = ShowcasePostResponse | ShowcaseFeedItem;

function isShowcaseFeedItem(value: unknown): value is ShowcaseFeedItem {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { id?: unknown }).id === 'string';
}

function isShowcasePostResponse(value: unknown): value is ShowcasePostResponse {
  return typeof value === 'object'
    && value !== null
    && isShowcaseFeedItem((value as { item?: unknown }).item);
}

function updateShowcaseItem(item: ShowcaseFeedItem, result: ShowcaseSaveStateResult) {
  if (item.id !== result.postId) {
    return item;
  }

  return {
    ...item,
    isSaved: result.isSaved,
    saveCount: Math.max(0, result.saveCount),
  };
}

function filterSavedItems(items: ShowcaseFeedItem[], removeWhenUnsaved: boolean) {
  return removeWhenUnsaved ? items.filter((item) => item.isSaved) : items;
}

function ignoreRejectedBackgroundWork(work: SaveRefreshWork) {
  if (work && typeof (work as { catch?: unknown }).catch === 'function') {
    void (work as Promise<unknown>).catch(() => undefined);
  }
}

export function scheduleShowcaseSaveCompletionEffects({
  postId,
  userId,
  hapticFeedback,
  invalidateQueries,
}: ShowcaseSaveCompletionEffects): void {
  if (hapticFeedback) {
    ignoreRejectedBackgroundWork(hapticFeedback());
  }

  for (const queryKey of [
    ['showcase-feed'],
    ['showcase-post', postId],
    ['profile-saved-media', userId],
  ] as const) {
    ignoreRejectedBackgroundWork(invalidateQueries({ queryKey }));
  }
}

export function applyShowcaseSaveStateToFeedResponse(
  response: ShowcaseFeedResponse | undefined,
  result: ShowcaseSaveStateResult,
  options: { removeWhenUnsaved?: boolean } = {}
): ShowcaseFeedResponse | undefined {
  if (!response) {
    return response;
  }

  const items = response.items.map((item) => updateShowcaseItem(item, result));

  return {
    ...response,
    items: filterSavedItems(items, Boolean(options.removeWhenUnsaved)),
  };
}

export function applyShowcaseSaveStateToInfiniteFeed(
  data: InfiniteData<ShowcaseFeedResponse> | undefined,
  result: ShowcaseSaveStateResult,
  options: { removeWhenUnsaved?: boolean } = {}
): InfiniteData<ShowcaseFeedResponse> | undefined {
  if (!data) {
    return data;
  }

  return {
    ...data,
    pages: data.pages.map((page) => applyShowcaseSaveStateToFeedResponse(page, result, options) ?? page),
  };
}

export function applyShowcaseSaveStateToPostResponse(
  response: ShowcasePostCacheEntry | undefined,
  result: ShowcaseSaveStateResult
): ShowcasePostResponse | undefined {
  if (!response) {
    return response;
  }

  if (isShowcasePostResponse(response)) {
    return {
      ...response,
      item: updateShowcaseItem(response.item, result),
    };
  }

  if (isShowcaseFeedItem(response)) {
    return {
      success: true,
      item: updateShowcaseItem(response, result),
    };
  }

  return response as ShowcasePostResponse;
}

export function applyShowcaseSaveStateToSourceData(
  data: ImmersiveSourceData | undefined,
  result: ShowcaseSaveStateResult,
  options: { removeWhenUnsaved?: boolean } = {}
): ImmersiveSourceData | undefined {
  if (!data?.showcaseItems) {
    return data;
  }

  const showcaseItems = data.showcaseItems.map((item) => updateShowcaseItem(item, result));

  return {
    ...data,
    showcaseItems: filterSavedItems(showcaseItems, Boolean(options.removeWhenUnsaved)),
  };
}
