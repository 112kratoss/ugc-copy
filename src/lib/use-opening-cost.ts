'use client';

import { useCallback, useState } from 'react';

import { openingCost, type CreatorOpening } from '@/lib/creator-opening';

type OpeningCostPage = Parameters<typeof openingCost>[1];

/**
 * The server's price for the run a creator opened on (`openingCost`), for as long as it may stand in
 * for the page's own: until the page's first quote of its own is in or has failed, or a start of its
 * own was refused (`settle`). After that the page names only its own quotes, for the rest of its life.
 *
 * Kept on, it came back whenever a later quote was on its way for a run that looked like the opening's
 * again: a setting changed and changed back, a refreshed session's token (part of the quote's key),
 * Retry, and the quote asked again after a start refused `cost_changed`, which put back beside that
 * refusal the very price the server had just refused (PR #859's review).
 */
export function useOpeningCost(opening: CreatorOpening | null, page: OpeningCostPage) {
  const [settled, setSettled] = useState(false);
  const quoted = page.quoteStatus === 'ready' || page.quoteStatus === 'error';
  // Read while rendering, as `useCreatorQuote` reads its refusal: the render that has the first quote
  // settles it, and every render after it.
  if (quoted && !settled) setSettled(true);
  const settle = useCallback(() => setSettled(true), []);
  return { cost: settled || quoted ? null : openingCost(opening, page), settle };
}
