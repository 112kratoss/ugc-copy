import type { InfiniteData } from '@tanstack/react-query';

import type {
  GenerationListItem,
  GenerationListResponse,
  OwnerPostListItem,
  OwnerPostsResponse,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
} from './types';

/** The least time between two automatic refreshes of one profile library. */
export const PROFILE_REVALIDATION_COOLDOWN_MS = 30_000;
/** Consecutive failures double the wait up to this ceiling. */
export const PROFILE_REVALIDATION_MAX_DELAY_MS = 10 * 60_000;
/** How long a rate-limited refresh waits when the server gives no hint. */
const RATE_LIMITED_FALLBACK_DELAY_MS = 60_000;

export type ProfileRevalidationGate = {
  lastAttemptAt: number | null;
  failures: number;
  /** Set by a rate-limit answer: no attempt before this time, whatever else holds. */
  notBeforeAt: number | null;
};

export const INITIAL_PROFILE_REVALIDATION_GATE: ProfileRevalidationGate = {
  lastAttemptAt: null,
  failures: 0,
  notBeforeAt: null,
};

/**
 * Whether a qualifying event — the screen gaining focus, the app returning to
 * the foreground, a tab change — may refresh a profile library now.
 *
 * The old trigger was an effect on "focused, stale and not fetching" that listed
 * `isFetching` among its dependencies. A failed refresh leaves the data stale, so
 * the moment each fetch settled the effect fired again, for as long as the error
 * lasted (2026-09-16 Creations reliability audit, C7). Now only events trigger;
 * a cooldown separates attempts, failures back off, and a 429 is honoured.
 */
export function canRevalidateProfileMedia({
  gate,
  now,
  isFetching,
  isStale,
}: {
  gate: ProfileRevalidationGate;
  now: number;
  isFetching: boolean;
  isStale: boolean;
}) {
  if (isFetching || !isStale) return false;
  if (gate.notBeforeAt !== null && now < gate.notBeforeAt) return false;
  if (gate.lastAttemptAt === null) return true;
  return now - gate.lastAttemptAt >= profileRevalidationDelayMs(gate.failures);
}

export function profileRevalidationDelayMs(failures: number) {
  return Math.min(
    PROFILE_REVALIDATION_MAX_DELAY_MS,
    PROFILE_REVALIDATION_COOLDOWN_MS * 2 ** Math.max(0, failures)
  );
}

export function recordProfileRevalidationStart(gate: ProfileRevalidationGate, now: number): ProfileRevalidationGate {
  return { ...gate, lastAttemptAt: now };
}

export function recordProfileRevalidationSuccess(gate: ProfileRevalidationGate): ProfileRevalidationGate {
  return { ...gate, failures: 0, notBeforeAt: null };
}

export function recordProfileRevalidationFailure(
  gate: ProfileRevalidationGate,
  error: unknown,
  now: number
): ProfileRevalidationGate {
  return {
    ...gate,
    failures: gate.failures + 1,
    notBeforeAt: rateLimitedUntil(error, now),
  };
}

/** A 429's retry hint when the server sent one (`retryAfterSeconds` or `retryAfter`, in seconds). */
function rateLimitedUntil(error: unknown, now: number): number | null {
  if (!error || typeof error !== 'object' || (error as { status?: unknown }).status !== 429) return null;
  const details = (error as { details?: unknown }).details;
  const hint = details && typeof details === 'object'
    ? Number((details as Record<string, unknown>).retryAfterSeconds ?? (details as Record<string, unknown>).retryAfter)
    : Number.NaN;
  return now + (Number.isFinite(hint) && hint > 0 ? hint * 1000 : RATE_LIMITED_FALLBACK_DELAY_MS);
}

export type ProfilePageAdapter<TPage, TItem extends { id: string }> = {
  items: (page: TPage) => TItem[];
  withItems: (page: TPage, items: TItem[]) => TPage;
  hasMore: (page: TPage) => boolean;
  /**
   * The library's newest-first order key, when items carry one. It lets a refresh
   * tell an item pushed onto page two by new work from one that was removed.
   */
  orderKey?: (item: TItem) => number;
  /** Offset libraries must resume from the fresh boundary, not an old offset. */
  restartContinuation?: (retainedTail: TPage, freshHead: TPage) => TPage;
};

/**
 * A freshly fetched first page, merged into a library the reader may have
 * scrolled far into.
 *
 * Replacing the whole query would throw away every page they loaded; refetching
 * them all is the cost this avoids. So the first page is replaced and later
 * pages are kept, minus anything the fresh page now holds. An item the old first
 * page had and the new one lacks is kept at the head of page two when it is older
 * than everything fresh — new creations pushed it down, and dropping it would
 * lose it from the grid until a full refresh — and dropped when it falls inside
 * the fresh page's range, where its absence means it was removed or archived.
 * When the fresh page says there is nothing more, it is the whole library.
 */
export function mergeRefreshedFirstPage<TPage, TItem extends { id: string }, TPageParam>(
  current: InfiniteData<TPage, TPageParam> | undefined,
  fresh: TPage,
  initialPageParam: TPageParam,
  adapter: ProfilePageAdapter<TPage, TItem>
): InfiniteData<TPage, TPageParam> {
  if (!current?.pages.length || !adapter.hasMore(fresh)) {
    return { pages: [fresh], pageParams: [current?.pageParams[0] ?? initialPageParam] };
  }

  const freshItems = adapter.items(fresh);
  const freshIds = new Set(freshItems.map((item) => item.id));
  const orderKey = adapter.orderKey;
  const oldestFresh = orderKey && freshItems.length ? Math.min(...freshItems.map(orderKey)) : null;
  const displaced = adapter.items(current.pages[0]).filter((item) => (
    !freshIds.has(item.id)
    && (!orderKey || oldestFresh === null || !Number.isFinite(oldestFresh) || orderKey(item) < oldestFresh)
  ));
  const displacedIds = new Set(displaced.map((item) => item.id));

  const laterPages = current.pages.slice(1).map((page, index) => {
    const kept = adapter.items(page).filter((item) => !freshIds.has(item.id) && !displacedIds.has(item.id));
    return adapter.withItems(page, index === 0 ? [...displaced, ...kept] : kept);
  });

  // Offsets describe positions in the current server collection, so they stay
  // valid only while the rows ahead of the reader's boundary do. When the fresh
  // head no longer holds every row the cached head held, something ahead of it
  // moved: keep the cached cards visible, but resume the next load-more from the
  // freshly verified head boundary, which the flatteners deduplicate against
  // what is already loaded. A head that came back unchanged — what a periodic
  // refresh almost always finds — keeps its own continuation, because reopening
  // it would re-read every page the reader already holds, one per end of list.
  const headShifted = adapter.items(current.pages[0]).some((item) => !freshIds.has(item.id));
  if (headShifted && laterPages.length && adapter.restartContinuation) {
    const last = laterPages.length - 1;
    laterPages[last] = adapter.restartContinuation(laterPages[last], fresh);
  }

  return { pages: [fresh, ...laterPages], pageParams: [...current.pageParams] };
}

function createdAtKey(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export const PROFILE_GENERATION_PAGES: ProfilePageAdapter<GenerationListResponse, GenerationListItem> = {
  items: (page) => page.generations ?? [],
  withItems: (page, generations) => ({ ...page, generations }),
  hasMore: (page) => Boolean(page.pagination?.hasMore),
  orderKey: (item) => createdAtKey(item.created_at),
};

export const PROFILE_OWNER_POST_PAGES: ProfilePageAdapter<OwnerPostsResponse, OwnerPostListItem> = {
  items: (page) => page.posts ?? [],
  withItems: (page, posts) => ({ ...page, posts }),
  hasMore: (page) => Boolean(page.pageInfo?.hasMore),
  orderKey: (item) => createdAtKey(item.createdAt),
  restartContinuation: (tail, head) => ({
    ...tail,
    pageInfo: { ...tail.pageInfo!, hasMore: head.pageInfo!.hasMore, nextOffset: head.pageInfo!.nextOffset },
  }),
};

/**
 * Saved media is ordered by when it was saved, which the items do not carry, so
 * a displaced item is always kept; an unsave already updates the cache itself.
 */
export const PROFILE_SAVED_MEDIA_PAGES: ProfilePageAdapter<ShowcaseFeedResponse, ShowcaseFeedItem> = {
  items: (page) => page.items ?? [],
  withItems: (page, items) => ({ ...page, items }),
  hasMore: (page) => Boolean(page.pageInfo?.hasMore),
  restartContinuation: (tail, head) => ({
    ...tail,
    pageInfo: { ...tail.pageInfo!, hasMore: head.pageInfo!.hasMore, nextOffset: head.pageInfo!.nextOffset },
  }),
};
