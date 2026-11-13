import { useEffect, useState } from 'react';

import type { MagicbookletApiClient } from '@/lib/api-client';
import {
  isSearchStarterEmpty,
  parseSearchStarterResponse,
  type SearchStarterResponse,
} from '@/lib/public-search-policy/search-starter';

/**
 * What the search screen offers before anything is typed and on a search that
 * finds nothing (`GET /api/search/starter`; search UX audit 2026-11-13,
 * findings 2 and 8): popular models and tools, creators to follow, searches
 * to try. Asked once each time the screen opens (`active` turning true), and
 * again when the signed-in account changes, and kept for as long as it stays
 * open: the app sends its token with every
 * request, so the answer is never kept at the edge, and the route's budget is
 * a minute's. A failure, the kill switch's empty answer, or a server from
 * before the route are all drawn as nothing: null.
 */
export function useSearchStarter(
  api: MagicbookletApiClient,
  active: boolean,
  /** Whose starter: the signed-in account's id, null for a visitor. Another one is asked again. */
  viewerKey: string | null,
): SearchStarterResponse | null {
  const [answer, setAnswer] = useState<{ viewerKey: string | null; response: SearchStarterResponse } | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    api.searchStarter(controller.signal)
      .then((body) => {
        if (controller.signal.aborted) return;
        const parsed = parseSearchStarterResponse(body);
        setAnswer(parsed && !isSearchStarterEmpty(parsed) ? { viewerKey, response: parsed } : null);
      })
      .catch(() => {
        // An extra: its failure leaves the screen as it was, never an error.
      });
    return () => controller.abort();
    // The account, not its session: a renewed token is the same viewer and
    // asks nothing; another account's creators to follow are its own.
  }, [active, api, viewerKey]);
  // Never another account's answer, even for the moment before its own lands.
  return answer && answer.viewerKey === viewerKey ? answer.response : null;
}
