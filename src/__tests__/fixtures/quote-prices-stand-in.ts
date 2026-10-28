import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import type { ListedPrice } from '@/lib/use-quote-prices';

/**
 * The stand-in for the creators' price lists (`useQuotePrices`) that the page tests mock the
 * hook with: it answers at once from `price`, which a test sets, and keeps every list the page
 * asked to price. Unless a test says otherwise nothing is priced, so a page draws no listed
 * price, as it does before its lists' answers come in.
 *
 *   vi.mock('@/lib/use-quote-prices', async () => {
 *     const { quotePricesHookStandIn } = await import('./fixtures/quote-prices-stand-in');
 *     return { useQuotePrices: quotePricesHookStandIn };
 *   });
 */
export const priceListStandIn = {
  /** Each list the page asked to price, a render at a time. */
  lists: [] as GenerationModelQuoteInput[][],
  price: (_request: GenerationModelQuoteInput): ListedPrice => {
    void _request;
    return { status: 'pending' };
  },
  /** Every run asked for so far, once each, as JSON. */
  askedRuns(): GenerationModelQuoteInput[] {
    const seen = new Map(priceListStandIn.lists.flat().map((request) => [JSON.stringify(request), request]));
    return [...seen.values()];
  },
  reset(): void {
    priceListStandIn.lists = [];
    priceListStandIn.price = () => ({ status: 'pending' });
  },
};

/** A price list answering `cost(run)` credits, or refusing a run it answers null for. */
export function pricedBy(cost: (request: GenerationModelQuoteInput) => number | null) {
  return (request: GenerationModelQuoteInput): ListedPrice => {
    const credits = cost(request);
    return credits === null
      ? { status: 'refused', code: 'INVALID_MODEL_SETTINGS', message: 'This model needs something else first.' }
      : { status: 'ready', costCredits: credits, normalizedSettings: {} };
  };
}

export function quotePricesHookStandIn(requests: readonly GenerationModelQuoteInput[]) {
  priceListStandIn.lists.push([...requests]);
  return (request: GenerationModelQuoteInput | null): ListedPrice => (
    request ? priceListStandIn.price(request) : { status: 'pending' }
  );
}
