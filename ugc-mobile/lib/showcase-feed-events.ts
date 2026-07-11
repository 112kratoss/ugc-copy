import type { InfiniteData } from '@tanstack/react-query';

import type {
  ShowcaseFeedEventRequest,
  ShowcaseFeedEventType,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcaseRecommendationMetadata,
} from './types';

export const SHOWCASE_PLAYBACK_VIEWABILITY = Object.freeze({
  itemVisiblePercentThreshold: 55,
  minimumViewTime: 180,
});

export const SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY = Object.freeze({
  itemVisiblePercentThreshold: 50,
  minimumViewTime: 1000,
});

export interface ShowcaseFeedEventTarget {
  postId: string;
  recommendation?: ShowcaseRecommendationMetadata | null;
}

export interface ShowcaseFeedEventContext {
  feedSessionId?: string | null;
  algorithmVersion?: string | null;
  sourceSurface: ShowcaseFeedEventRequest['sourceSurface'];
}

export interface ShowcaseFeedEventDetails {
  durationMs?: number;
  progress?: number;
  position?: number;
  metadata?: Record<string, unknown>;
}

export interface ShowcaseFeedRemovalTarget {
  postId?: string | null;
  creatorId?: string | null;
}

const deliveryRequiredEventTypes = new Set<ShowcaseFeedEventType>([
  'impression',
  'open',
  'dwell',
  'media_progress',
  'quick_skip',
  'share',
  'remix_start',
  'resource_open',
]);

const anonymousSessionHiddenPostIds = new Set<string>();
const anonymousSessionHiddenCreatorIds = new Set<string>();

export function rememberAnonymousShowcaseFeedRemoval(target: ShowcaseFeedRemovalTarget) {
  if (target.postId) anonymousSessionHiddenPostIds.add(target.postId);
  if (target.creatorId) anonymousSessionHiddenCreatorIds.add(target.creatorId);
}

export function forgetAnonymousShowcaseFeedRemoval(target: ShowcaseFeedRemovalTarget) {
  if (target.postId) anonymousSessionHiddenPostIds.delete(target.postId);
  if (target.creatorId) anonymousSessionHiddenCreatorIds.delete(target.creatorId);
}

export function filterAnonymousSessionShowcaseFeedItems(items: ShowcaseFeedItem[]) {
  return items.filter((item) => (
    !anonymousSessionHiddenPostIds.has(item.id)
    && (!item.creator.id || !anonymousSessionHiddenCreatorIds.has(item.creator.id))
  ));
}

export function resetAnonymousShowcaseFeedRemovalsForTests() {
  anonymousSessionHiddenPostIds.clear();
  anonymousSessionHiddenCreatorIds.clear();
}

export function createShowcaseFeedClientEventId() {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) {
    return `showcase:${randomUUID()}`;
  }

  return `showcase:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function canRecordShowcaseFeedEvent(
  target: ShowcaseFeedEventTarget,
  eventType: ShowcaseFeedEventType
) {
  return !deliveryRequiredEventTypes.has(eventType)
    || Boolean(target.recommendation?.deliveryId);
}

export function buildShowcaseFeedEventRequest(
  target: ShowcaseFeedEventTarget,
  eventType: ShowcaseFeedEventType,
  context: ShowcaseFeedEventContext,
  details: ShowcaseFeedEventDetails = {}
): ShowcaseFeedEventRequest {
  const recommendation = target.recommendation;
  const metadata = {
    ...(context.algorithmVersion ? { algorithmVersion: context.algorithmVersion } : {}),
    ...(recommendation?.reason ? { recommendationReason: recommendation.reason } : {}),
    ...details.metadata,
  };

  return {
    clientEventId: createShowcaseFeedClientEventId(),
    ...(context.feedSessionId ? { feedSessionId: context.feedSessionId } : {}),
    ...(recommendation?.deliveryId ? { deliveryId: recommendation.deliveryId } : {}),
    postId: target.postId,
    eventType,
    ...(typeof details.position === 'number'
      ? { position: details.position }
      : typeof recommendation?.position === 'number'
        ? { position: recommendation.position }
        : {}),
    ...(typeof details.durationMs === 'number' ? { durationMs: details.durationMs } : {}),
    ...(typeof details.progress === 'number' ? { progress: details.progress } : {}),
    sourceSurface: context.sourceSurface,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

export function getQualifiedImpressionKey(
  target: ShowcaseFeedEventTarget,
  feedSessionId?: string | null
) {
  return target.recommendation?.deliveryId
    ?? `${feedSessionId?.trim() || 'unranked'}:${target.postId}`;
}

export function removeShowcaseFeedItems(
  items: ShowcaseFeedItem[],
  target: ShowcaseFeedRemovalTarget
) {
  return items.filter((item) => !matchesRemovalTarget(item, target));
}

export function removeShowcaseFeedItemsFromResponse(
  response: ShowcaseFeedResponse | undefined,
  target: ShowcaseFeedRemovalTarget
): ShowcaseFeedResponse | undefined {
  if (!response) return response;
  return {
    ...response,
    items: removeShowcaseFeedItems(response.items, target),
  };
}

export function removeShowcaseFeedItemsFromInfiniteData(
  data: InfiniteData<ShowcaseFeedResponse> | undefined,
  target: ShowcaseFeedRemovalTarget
): InfiniteData<ShowcaseFeedResponse> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => removeShowcaseFeedItemsFromResponse(page, target) ?? page),
  };
}

function matchesRemovalTarget(item: ShowcaseFeedItem, target: ShowcaseFeedRemovalTarget) {
  if (target.postId && item.id === target.postId) return true;
  return Boolean(target.creatorId && item.creator.id === target.creatorId);
}
