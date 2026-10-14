import type { InfiniteData } from '@tanstack/react-query';

import type { MagicbookletApiClient } from './api-client';
import type {
  ShowcaseFeedEventRequest,
  ShowcaseFeedEventType,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcaseRecommendationMetadata,
  UndoFeedFeedbackRequest,
  UndoFeedFeedbackResponse,
} from './types';

export const SHOWCASE_PLAYBACK_VIEWABILITY = Object.freeze({
  itemVisiblePercentThreshold: 55,
  minimumViewTime: 180,
});

/**
 * "Any pixel of this card is on screen." Deliberately the loosest of the three
 * configs: it answers whether resizing a card would move something the reader
 * can see, and a card scrolled almost out of the top still shifts the whole
 * column beneath it when it changes height.
 *
 * `1` rather than `0` because a zero threshold counts an item with none of
 * itself on screen as viewable, which would hold every rendered card forever.
 */
export const SHOWCASE_ONSCREEN_VIEWABILITY = Object.freeze({
  itemVisiblePercentThreshold: 1,
  minimumViewTime: 0,
});

export const SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY = Object.freeze({
  itemVisiblePercentThreshold: 50,
  minimumViewTime: 1000,
});

/**
 * The qualified impression's visibility (half the card on screen), reported the
 * moment it starts and the moment it ends. A card's dwell is measured between
 * the two (`lib/feed-attention-view-model.ts`), and only a stretch of the
 * impression's own second or more counts. The impression's config cannot time
 * it: its `minimumViewTime` holds every report back, so a card that leaves a
 * moment after a flick begins is reported gone up to a second late, which would
 * lengthen almost every dwell by most of a second.
 */
export const SHOWCASE_DWELL_VIEWABILITY = Object.freeze({
  itemVisiblePercentThreshold: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.itemVisiblePercentThreshold,
  minimumViewTime: 0,
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

/** The two choices that remove posts from a feed, and that an Undo can take back. */
export type ShowcaseFeedFeedbackType = 'not_interested' | 'hide_creator';

/** A Not interested (by `postId`) or a Hide (by `creatorId`): the removal target and which choice made it. */
export interface ShowcaseFeedFeedbackTarget extends ShowcaseFeedRemovalTarget {
  feedbackType: ShowcaseFeedFeedbackType;
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

/** Where a removed post sat in a lane's pages, read before it was removed. */
export interface ShowcaseFeedItemPosition {
  pageIndex: number;
  index: number;
  item: ShowcaseFeedItem;
}

/** The posts a removal takes out of a lane, each with its page and index. Read it before removing. */
export function findShowcaseFeedItemPositions(
  data: InfiniteData<ShowcaseFeedResponse> | undefined,
  target: ShowcaseFeedRemovalTarget
): ShowcaseFeedItemPosition[] {
  if (!data) return [];
  return data.pages.flatMap((page, pageIndex) => page.items.flatMap((item, index) => (
    matchesRemovalTarget(item, target) ? [{ pageIndex, index, item }] : []
  )));
}

/**
 * Puts removed posts back where they were: after an Undo the post returns to
 * the index it left (product decision D7, 2026-10-14). The lane is changed in
 * place rather than replaced by the copy taken before the removal, which would
 * also take back a page loaded or a save made in the seconds since.
 *
 * Within a page the posts go back lowest index first, so each lands at the
 * index it held before any of them left. A post the lane holds again (a
 * refresh brought it back) is not added twice; a page the lane no longer has
 * (a refresh trimmed it) gets nothing back, and the post returns with a later
 * page or refresh.
 */
export function restoreShowcaseFeedItemsToInfiniteData(
  data: InfiniteData<ShowcaseFeedResponse> | undefined,
  positions: readonly ShowcaseFeedItemPosition[]
): InfiniteData<ShowcaseFeedResponse> | undefined {
  if (!data || positions.length === 0) return data;
  const held = new Set(data.pages.flatMap((page) => page.items.map((item) => item.id)));
  const returning = new Map<number, ShowcaseFeedItemPosition[]>();
  for (const position of positions) {
    if (held.has(position.item.id) || !data.pages[position.pageIndex]) continue;
    held.add(position.item.id);
    returning.set(position.pageIndex, [...(returning.get(position.pageIndex) ?? []), position]);
  }
  if (returning.size === 0) return data;
  return {
    ...data,
    pages: data.pages.map((page, pageIndex) => {
      const back = returning.get(pageIndex);
      if (!back) return page;
      const items = [...page.items];
      for (const { index, item } of [...back].sort((left, right) => left.index - right.index)) {
        items.splice(Math.min(index, items.length), 0, item);
      }
      return { ...page, items };
    }),
  };
}

/** The undo notice's words for each choice. */
export function feedFeedbackUndoMessage(feedbackType: ShowcaseFeedFeedbackType) {
  return feedbackType === 'hide_creator' ? 'Creator hidden' : 'Post hidden';
}

function feedbackKey(target: ShowcaseFeedFeedbackTarget) {
  const id = target.feedbackType === 'hide_creator' ? target.creatorId : target.postId;
  return id ? `${target.feedbackType}:${id}` : null;
}

function undoRequestFor(target: ShowcaseFeedFeedbackTarget): UndoFeedFeedbackRequest | null {
  if (target.feedbackType === 'hide_creator') {
    return target.creatorId ? { feedbackType: 'hide_creator', creatorId: target.creatorId } : null;
  }
  return target.postId ? { feedbackType: 'not_interested', postId: target.postId } : null;
}

const ignoreOutcome = () => undefined;

/** Each choice's requests still on the wire, settled either way. */
const feedbackRequestsInFlight = new Map<string, Promise<void>>();

/**
 * Notes the request that sends a Not interested or a Hide, so an Undo of the
 * same choice waits for it, and hands the request back untouched for the
 * caller's own `.then` and `.catch`.
 *
 * The undo deletes the row that request writes. Sent while the request is
 * still on its way, it can reach the server first, find nothing
 * (`removed: false`), and the row is written after it: the post stays hidden
 * for good although the reader took it back.
 */
export function trackFeedFeedbackRequest<T>(target: ShowcaseFeedFeedbackTarget, request: Promise<T>): Promise<T> {
  const key = feedbackKey(target);
  if (!key) return request;
  const earlier = feedbackRequestsInFlight.get(key) ?? Promise.resolve();
  const settled = Promise.all([earlier, request.then(ignoreOutcome, ignoreOutcome)]).then(ignoreOutcome);
  feedbackRequestsInFlight.set(key, settled);
  void settled.then(() => {
    if (feedbackRequestsInFlight.get(key) === settled) feedbackRequestsInFlight.delete(key);
  });
  return request;
}

/**
 * The server's answer, or `local` when the device had no session: the choice
 * lived only in this device's memory, which is cleared, and nothing was sent.
 */
export type FeedFeedbackUndoResult =
  | UndoFeedFeedbackResponse
  | { removed: false; local: true };

/**
 * Takes back a Not interested or a Hide (product decision D7: a preference
 * delete, not a feed event; the original event stays in the facts).
 *
 * With no session there is no stored row (the events route stores the choice
 * only under a user id: an app guest's anonymous session has one, a device
 * with no session has none), so the undo is local: the device's memory of the
 * removal is cleared and nothing is sent.
 *
 * Otherwise it waits for that choice's own request if it is still on the wire
 * (`trackFeedFeedbackRequest`), then asks the server to delete the row and
 * answers what the server said. The device's memory is cleared only once the
 * server has answered, so a failed undo leaves the post hidden on later pages
 * as well as this one.
 *
 * Nothing is ever dropped from the event queue instead: `not_interested` and
 * `hide_creator` are not batched (`feed-event-queue.ts`), so every one is
 * already on its way when its notice appears.
 */
export async function undoFeedFeedback(
  api: Pick<MagicbookletApiClient, 'undoFeedFeedback'>,
  target: ShowcaseFeedFeedbackTarget,
  { hasSession }: { hasSession: boolean },
): Promise<FeedFeedbackUndoResult> {
  if (!hasSession) {
    forgetAnonymousShowcaseFeedRemoval(target);
    return { removed: false, local: true };
  }
  const body = undoRequestFor(target);
  if (!body) {
    throw new Error(target.feedbackType === 'hide_creator'
      ? 'Undoing Hide needs the creator it hid.'
      : 'Undoing Not interested needs the post it removed.');
  }
  const key = feedbackKey(target);
  const pending = key ? feedbackRequestsInFlight.get(key) : undefined;
  if (pending) await pending;
  const answer = await api.undoFeedFeedback(body);
  forgetAnonymousShowcaseFeedRemoval(target);
  return answer;
}

export function resetFeedFeedbackRequestsForTests() {
  feedbackRequestsInFlight.clear();
}
