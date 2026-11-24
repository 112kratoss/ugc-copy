import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { MagicbookletApiClient } from '@/lib/api-client';
import {
  isSearchStarterEmpty,
  parseSearchStarterResponse,
  SEARCH_STARTER_KEPT_MS,
  type SearchStarterResponse,
} from '@/lib/public-search-policy/search-starter';

const SEARCH_STARTER_QUERY_ROOT = 'search-starter';

/** Each account's kept answer apart: its blocks and follows shape its creators. Null is a visitor's or a guest's. */
export function searchStarterQueryKey(viewerKey: string | null) {
  return [SEARCH_STARTER_QUERY_ROOT, viewerKey ?? 'visitor'] as const;
}

/**
 * The kept answers are not drawn at the next opening, which asks again and
 * waits for it as a first opening does: a follow, an unfollow, a block or an
 * unblock changes the creators the starter offers (the API client says so,
 * `onRelationsChanged`). An opening on screen keeps what it drew.
 */
export function forgetKeptSearchStarters(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: [SEARCH_STARTER_QUERY_ROOT], refetchType: 'none' });
}

/** An answer with nothing to draw: never kept, so the next opening asks again. */
class NoSearchStarter extends Error {}

type Opening = {
  viewerKey: string | null;
  /** A kept answer, young enough, was there as it opened: drawn at once, nothing asked. */
  kept: boolean;
  /** The answer and failure count on hand as it opened, so only this opening's request settles it. */
  data: SearchStarterResponse | undefined;
  errorUpdateCount: number;
};

/**
 * What the search screen offers before anything is typed and on a search that
 * finds nothing (`GET /api/search/starter`; search UX audit 2026-11-13,
 * findings 2 and 8): popular models and tools, creators to follow, searches
 * to try. With it, whether this opening's question has settled (answered,
 * failed or answered empty), so the screen can hold its start a moment for
 * the ideas instead of drawing the idle card they would then replace.
 *
 * An answer is kept in the query cache for SEARCH_STARTER_KEPT_MS, per
 * account: an opening within that draws it at once and asks nothing (the
 * route counts each request against its limit, and the lists are remade
 * hourly). An opening with none kept, or with one older than that or
 * forgotten (`forgetKeptSearchStarters`), asks and holds as a first opening
 * does, and never draws the older answer meanwhile, nor keeps it when its own
 * request fails (review of #794): an empty answer, a failure, the kill
 * switch's empty answer and a server from before the route are all drawn as
 * nothing (null) and never kept. A follow made from the starter reads
 * "Following" on the kept answer's row (`use-search-creator-follow`) until the
 * next opening asks again. The app sends its token with every request, so the
 * answer is never kept at the edge.
 */
export function useSearchStarterState(
  api: MagicbookletApiClient,
  active: boolean,
  viewerKey: string | null,
): { answer: SearchStarterResponse | null; settled: boolean } {
  const query = useQuery({
    queryKey: searchStarterQueryKey(viewerKey),
    queryFn: async ({ signal }) => {
      const parsed = parseSearchStarterResponse(await api.searchStarter(signal));
      if (!parsed || isSearchStarterEmpty(parsed)) throw new NoSearchStarter();
      return parsed;
    },
    enabled: active,
    staleTime: SEARCH_STARTER_KEPT_MS,
    gcTime: SEARCH_STARTER_KEPT_MS,
    // A new answer is a new object, so an opening can tell its own from the one it found.
    structuralSharing: false,
    // One request an opening, as before: an extra is not worth a retry, and a
    // screen held open asks nothing more.
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Each opening (the screen shown, or another account while it is) takes
  // stock once, adjusted while rendering as state that follows a prop is.
  const openingOf = (): Opening => ({
    viewerKey,
    kept: query.data !== undefined && !query.isStale,
    data: query.data,
    errorUpdateCount: query.errorUpdateCount,
  });
  const [opening, setOpening] = useState<Opening | null>(() => (active ? openingOf() : null));
  const current = active && opening?.viewerKey === viewerKey ? opening : null;
  if (active && current === null) setOpening(openingOf());
  if (!active && opening !== null) setOpening(null);
  if (!current) return { answer: null, settled: false };

  const answered = current.kept || (query.data !== undefined && query.data !== current.data);
  return {
    answer: answered ? query.data ?? null : null,
    settled: answered || query.errorUpdateCount > current.errorUpdateCount,
  };
}
