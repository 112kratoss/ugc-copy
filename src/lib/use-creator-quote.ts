'use client';

import { useCallback, useState } from 'react';

import { catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
import type { CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { useWebGenerationModelQuote } from '@/lib/generation-model-client';

/** A run the start refused as costing more than its price, by its quote request (JSON) and that price. */
type RefusedRunPrice = { key: string; costCredits: number };

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
    // The key a price goes with its run under (`catalogRunWithShownCost`): the run's own quote request.
    const refused = typeof run.expectedCostCredits === 'number'
      ? { key: JSON.stringify(catalogRunQuoteInput({ ...run, inputs: run.inputs ?? [] })), costCredits: run.expectedCostCredits }
      : null;
    setAsking((current) => ({ attempt: current.attempt + 1, refused }));
  }, []);
  const { refused } = asking;
  const pageOutOfDate = refused !== null
    && quoteState.status === 'ready'
    && quoteState.key === refused.key
    && quoteState.quote?.costCredits === refused.costCredits;
  return { ...quoteState, retry, costChanged, pageOutOfDate };
}
