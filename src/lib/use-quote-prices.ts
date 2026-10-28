'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { optionPriceLabel } from '../../ugc-mobile/lib/creator-run-fit/creator-run-fit';
import { GENERATION_MODEL_QUOTE_BATCH_MAX } from '../../ugc-mobile/lib/model-catalog/protocol';
import type { CatalogPrimitive, GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { requestWebGenerationQuoteBatch, type WebGenerationQuoteBatchEntry } from '@/lib/generation-model-client';

/** A listed run's price: asked and not yet in, read, refused by the catalog, or not to be had now. */
export type ListedPrice =
  | { status: 'pending' }
  | { status: 'ready'; costCredits: number }
  | { status: 'refused'; message: string }
  | { status: 'unavailable' };

/** A listed price's credits once read; null while it is pending, refused or not to be had. */
export function readyCost(price: ListedPrice): number | null {
  return price.status === 'ready' ? price.costCredits : null;
}

/** The price on Generate (the run's own quote) as a listed price: the model in use, in the model list. */
export function listedFromQuote(quote: {
  status: string;
  quote: { costCredits: number } | null;
}): ListedPrice {
  if (quote.status === 'ready' && quote.quote) {
    return { status: 'ready', costCredits: quote.quote.costCredits };
  }
  return quote.status === 'error' ? { status: 'unavailable' } : { status: 'pending' };
}

/** The open settings' options, each as the run with that one setting changed, keyed by setting and value. */
export type SettingsVariants = ReadonlyMap<string, GenerationModelQuoteInput>;

/** Settings that are closed price no options. */
export const NO_SETTINGS_VARIANTS: SettingsVariants = new Map();

const variantKey = (key: string, value: CatalogPrimitive) => `${key}=${String(value)}`;

/**
 * Every option the open settings show, as the run with that option (owner, 2026-10-28):
 * `axes` names each setting shown and its options. Nothing while there is no run to vary.
 */
export function settingsVariants(
  request: GenerationModelQuoteInput | null,
  axes: ReadonlyArray<readonly [key: string, values: readonly CatalogPrimitive[]]>,
  /** The page's clamp, where one setting moves others (an image ratio its resolution): the settings it would leave. */
  fit?: (settings: Record<string, unknown>) => Record<string, unknown>,
): SettingsVariants {
  const variants = new Map<string, GenerationModelQuoteInput>();
  if (!request) return variants;
  for (const [key, values] of axes) {
    for (const value of values) {
      const settings = { ...request.settings, [key]: value };
      variants.set(variantKey(key, value), { ...request, settings: fit ? fit(settings) : settings });
    }
  }
  return variants;
}

/** What an option of the settings costs: "19", or "23 · +1" past the balance, and the words a screen reader says. */
export type OptionPrice = { cost: number; text: string; over: number | null; spoken: string };

/**
 * What the run costs with an option, read against the balance ("19", or "23 · +1" past
 * it, `optionPriceLabel`), named as `balanceName` ("your balance", "the free credits");
 * null until its price is in, and for an option not varied.
 */
export function optionPricesOf(
  variants: SettingsVariants,
  priceOf: (request: GenerationModelQuoteInput | null) => ListedPrice,
  balance: number | null,
  balanceName: string,
) {
  return (key: string, value: CatalogPrimitive): OptionPrice | null => {
    const cost = readyCost(priceOf(variants.get(variantKey(key, value)) ?? null));
    if (cost === null) return null;
    const label = optionPriceLabel(cost, balance);
    const credits = `${cost} ${cost === 1 ? 'credit' : 'credits'}`;
    return { cost, ...label, spoken: label.over === null ? credits : `${credits}, ${label.over} more than ${balanceName}` };
  };
}

/**
 * The least an option shown goes past the balance by, for the line that says what "+N"
 * means; null when none does. Only the options `shown` are read: a slider's other lengths
 * are priced, but not on screen.
 */
export function smallestOverBalance(
  optionPrice: ReturnType<typeof optionPricesOf>,
  shown: ReadonlyArray<readonly [key: string, values: readonly CatalogPrimitive[]]>,
): number | null {
  let least: number | null = null;
  for (const [key, values] of shown) {
    for (const value of values) {
      const over = optionPrice(key, value)?.over ?? null;
      if (over !== null && (least === null || over < least)) least = over;
    }
  }
  return least;
}

/** How long a list that could not be priced (offline, the limit reached) waits before it is asked again. */
const RETRY_UNAVAILABLE_MS = 30_000;
/** Prices kept per page: a few settings panels' and model lists' worth. */
const MAX_KEPT = 600;
/** Settings pressed in quick succession are asked for together. */
const GATHER_MS = 150;

const PENDING: ListedPrice = { status: 'pending' };

/**
 * Refusals that say nothing of the run: the catalog could not be read, or this server's
 * copy is behind a new release. A run refused so is asked again, as a list that failed is.
 */
const REFUSED_FOR_NOW = new Set(['CATALOG_UNAVAILABLE', 'CATALOG_CHANGED']);

function listedFromEntry(entry: WebGenerationQuoteBatchEntry | undefined): ListedPrice {
  if (!entry || (!entry.ok && REFUSED_FOR_NOW.has(entry.code))) return { status: 'unavailable' };
  return entry.ok
    ? { status: 'ready', costCredits: entry.quote.costCredits }
    : { status: 'refused', message: Object.values(entry.fieldErrors ?? {})[0] ?? entry.error };
}

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
 * kept ('pending' for one not in yet). A list that fails, or a run the catalog could not
 * price for now, is shown no price, and is asked again half a minute later if it is still
 * on screen.
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
      // Unavailable prices are let go half a minute later, so a list still on screen asks again.
      const askAgainLater = (keys: readonly string[]) => window.setTimeout(() => setPrices((current) => {
        const kept = new Map(current.kept);
        for (const key of keys) if (kept.get(key)?.status === 'unavailable') kept.delete(key);
        return { ...current, kept };
      }), RETRY_UNAVAILABLE_MS);
      for (let start = 0; start < asked.length; start += GENERATION_MODEL_QUOTE_BATCH_MAX) {
        const chunk = asked.slice(start, start + GENERATION_MODEL_QUOTE_BATCH_MAX);
        void requestWebGenerationQuoteBatch(chunk.map((key) => JSON.parse(key) as GenerationModelQuoteInput), lifetime.signal)
          .then((entries) => {
            const answers = chunk.map((key, index) => [key, listedFromEntry(entries[index])] as const);
            setPrices((current) => keepAnswers(current, answers));
            const unavailable = answers.filter(([, answer]) => answer.status === 'unavailable').map(([key]) => key);
            if (unavailable.length > 0) askAgainLater(unavailable);
          })
          .catch(() => {
            if (lifetime.signal.aborted) return;
            setPrices((current) => keepAnswers(current, chunk.map((key) => [key, { status: 'unavailable' }] as const)));
            askAgainLater(chunk);
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
