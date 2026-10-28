'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { GENERATION_MODEL_QUOTE_BATCH_MAX } from '../../ugc-mobile/lib/model-catalog/protocol';
import type { CatalogPrimitive, GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { requestWebGenerationQuoteBatch } from '@/lib/generation-model-client';

/** A listed run's price: asked and not yet in, read, refused by the catalog, or not to be had now. */
export type ListedPrice =
  | { status: 'pending' }
  | { status: 'ready'; costCredits: number; normalizedSettings: Record<string, CatalogPrimitive> }
  | { status: 'refused'; code: string; message: string }
  | { status: 'unavailable' };

/** How long a list that could not be priced (offline, the limit reached) waits before it is asked again. */
const RETRY_UNAVAILABLE_MS = 30_000;
/** Prices kept per page: a few settings panels' and model lists' worth. */
const MAX_KEPT = 600;
/** Settings pressed in quick succession are asked for together. */
const GATHER_MS = 150;

const PENDING: ListedPrice = { status: 'pending' };

type Prices = { kept: ReadonlyMap<string, ListedPrice>; asking: ReadonlySet<string> };

function keepAnswers(prices: Prices, answers: ReadonlyArray<readonly [string, ListedPrice]>): Prices {
  const kept = new Map(prices.kept);
  const asking = new Set(prices.asking);
  for (const [key, answer] of answers) {
    asking.delete(key);
    // Kept in the order answered, so the oldest go first past the limit.
    kept.delete(key);
    kept.set(key, answer);
  }
  for (const key of kept.keys()) {
    if (kept.size <= MAX_KEPT) break;
    kept.delete(key);
  }
  return { kept, asking };
}

/**
 * The prices of a creator's lists, the model list and every option of the settings, asked
 * in as few requests as there can be (`POST /api/generation-models/quotes`, up to
 * `GENERATION_MODEL_QUOTE_BATCH_MAX` runs each) and kept for the page's life, keyed by the
 * run's own quote request: a price once read is not asked again, so moving through the
 * settings asks only for what the move made new. The price on Generate is not one of
 * these: it is the run's own quote (`useCreatorQuote`).
 *
 * `requests` is what the page shows now; the answer reads any run's price out of what is
 * kept ('pending' for one not in yet). A list that fails is shown no price, and is asked
 * again half a minute later if it is still on screen.
 */
export function useQuotePrices(requests: readonly GenerationModelQuoteInput[]): (request: GenerationModelQuoteInput | null) => ListedPrice {
  const [prices, setPrices] = useState<Prices>(() => ({ kept: new Map(), asking: new Set() }));
  // Given up only when the page goes away: a page that moved on keeps the answers it asked
  // for. Made in an effect, so a development double mount does not keep the first one's,
  // given up by its cleanup, for every request after it.
  const lifetimeRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime;
    return () => lifetime.abort();
  }, []);

  const missingKey = [...new Set(requests.map((request) => JSON.stringify(request)))]
    .filter((key) => !prices.kept.has(key) && !prices.asking.has(key))
    .join('\n');

  useEffect(() => {
    if (!missingKey) return;
    const timer = window.setTimeout(() => {
      const lifetime = lifetimeRef.current;
      if (!lifetime) return;
      const asked = missingKey.split('\n');
      setPrices((current) => ({ ...current, asking: new Set([...current.asking, ...asked]) }));
      for (let start = 0; start < asked.length; start += GENERATION_MODEL_QUOTE_BATCH_MAX) {
        const chunk = asked.slice(start, start + GENERATION_MODEL_QUOTE_BATCH_MAX);
        void requestWebGenerationQuoteBatch(chunk.map((key) => JSON.parse(key) as GenerationModelQuoteInput), lifetime.signal)
          .then((entries) => setPrices((current) => keepAnswers(current, chunk.map((key, index) => {
            const entry = entries[index];
            const answer: ListedPrice = entry.ok
              ? { status: 'ready', costCredits: entry.quote.costCredits, normalizedSettings: entry.quote.normalizedSettings }
              : { status: 'refused', code: entry.code, message: Object.values(entry.fieldErrors ?? {})[0] ?? entry.error };
            return [key, answer] as const;
          }))))
          .catch(() => {
            if (lifetime.signal.aborted) return;
            setPrices((current) => keepAnswers(current, chunk.map((key) => [key, { status: 'unavailable' }] as const)));
            window.setTimeout(() => setPrices((current) => {
              const kept = new Map(current.kept);
              for (const key of chunk) if (kept.get(key)?.status === 'unavailable') kept.delete(key);
              return { ...current, kept };
            }), RETRY_UNAVAILABLE_MS);
          });
      }
    }, GATHER_MS);
    return () => window.clearTimeout(timer);
  }, [missingKey]);

  const { kept } = prices;
  return useCallback(
    (request: GenerationModelQuoteInput | null) => (request ? kept.get(JSON.stringify(request)) ?? PENDING : PENDING),
    [kept],
  );
}
