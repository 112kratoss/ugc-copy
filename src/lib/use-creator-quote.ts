'use client';

import { useCallback, useState } from 'react';

import { catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
import type { CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { useWebGenerationModelQuote } from '@/lib/generation-model-client';

/**
 * A run the start refused as costing more than its price: its quote request (JSON), that
 * price, and whether a price asked since has been read against it.
 */
type RefusedRunPrice = { key: string; costCredits: number; judged: boolean };

/** The key a price goes with its run under (`catalogRunWithShownCost`): the run's own quote request. */
function quoteKeyOf(run: CatalogGenerationRequestPayload): string {
  return JSON.stringify(catalogRunQuoteInput({ ...run, inputs: run.inputs ?? [] }));
}

/**
 * A web creator's price for the run it would send (`useWebGenerationModelQuote`), asked
 * again by Retry quote after a quote that failed, and by `costChanged` after a start
 * refused `cost_changed`: the start priced the run above the price it carried.
 *
 * Asked again, the price usually moves, and the next press sends the new one. When it comes
 * back unmoved, for the very run the start refused, the page and the start price that run
 * apart, and another press could only be refused the same way: the page is older than the
 * code that prices runs. An image or motion remix sends from the page it is on after a
 * deploy, and any page sends from its own build until it hears of a newer one (one served
 * stale never does). Such a page looped, a refusal at every press at an unmoved price,
 * until the creator reloaded on their own (2026-10-20). `pageOutOfDate` says so instead:
 * the creator holds Generate and offers a reload.
 *
 * Only the first price in for that run since the refusal is read against it. Once it has
 * moved, the refusal is forgotten, and so it is once a start of that run goes (`started`):
 * kept, a later quote of the run back at the refused price (a price put back, a refreshed
 * session, Retry) held Generate though the start would take it.
 */
export function useCreatorQuote(request: GenerationModelQuoteInput | null, accessToken?: string | null) {
  // One state, so a refusal and the asking again it brings arrive in one render: the
  // ready quote read against the refusal is always the new answer, never the refused one.
  const [asking, setAsking] = useState<{ attempt: number; refused: RefusedRunPrice | null }>({ attempt: 0, refused: null });
  const quoteState = useWebGenerationModelQuote(request, accessToken, asking.attempt);
  const retry = useCallback(() => {
    setAsking((current) => ({ ...current, attempt: current.attempt + 1 }));
  }, []);
  const costChanged = useCallback((run: CatalogGenerationRequestPayload) => {
    const refused = typeof run.expectedCostCredits === 'number'
      ? { key: quoteKeyOf(run), costCredits: run.expectedCostCredits, judged: false }
      : null;
    setAsking((current) => ({ attempt: current.attempt + 1, refused }));
  }, []);
  const started = useCallback((run: CatalogGenerationRequestPayload) => {
    const key = quoteKeyOf(run);
    setAsking((current) => (current.refused?.key === key ? { ...current, refused: null } : current));
  }, []);
  const { refused } = asking;
  // The refused run's price, once a quote of it is in.
  const answer = refused && quoteState.status === 'ready' && quoteState.key === refused.key
    ? quoteState.quote?.costCredits
    : undefined;
  if (refused && !refused.judged && answer !== undefined) {
    // The first price in since the refusal, read while rendering: the same price stands
    // for as long as it is the price; another, and the refusal is forgotten.
    setAsking({ ...asking, refused: answer === refused.costCredits ? { ...refused, judged: true } : null });
  }
  const pageOutOfDate = refused !== null && answer === refused.costCredits;
  return { ...quoteState, retry, costChanged, started, pageOutOfDate };
}
