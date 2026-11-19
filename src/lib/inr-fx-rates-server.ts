import 'server-only';

import { logBackendError } from '@/lib/backend-logger';
import { hasPlausibleUsdInrRate } from '@/lib/currency';
import { EXTERNAL_API_REQUEST_TIMEOUT_MS, fetchWithProviderTimeout } from '@/lib/provider-fetch';

/**
 * The INR exchange rates that price a recipe or a resource in rupees for a buyer
 * in India (`buildPriceQuote` in `post-resource-bundles-server.ts` and
 * `marketplace-server.ts`), read once per instance and shared.
 *
 * Each price quote used to read them itself, through React's `cache()`, which
 * de-duplicates only inside a server render: in a route handler every call ran.
 * A For You page with ten priced recipes asked for the rates ten times, and as
 * `fetchWithProviderTimeout` counts every attempt it also wrote ten
 * `record_provider_fetch_attempt` rows (seen on a production feed request on
 * 2026-11-19), although Next's data cache answered all but one. Now an instance
 * reads them once, shares the read while it is in flight, keeps the answer for
 * `INR_FX_RATES_INSTANCE_TTL_MS`, and reads again sooner only after a failure,
 * which is not kept, or a read that has not answered within twice the request
 * timeout.
 *
 * Instances can now disagree for up to the TTL after Next's data cache picks up
 * the upstream's daily change: a buyer may see one rupee amount on a card and be
 * quoted another at checkout, a day's USD/INR move apart. Nobody is charged a
 * figure they were not shown at checkout (the order records its own amount),
 * and a retried checkout that lands on the other rate gets
 * `CHECKOUT_PAYLOAD_MISMATCH`, which the panel recovers from.
 */

type ExchangeRateApiResponse = {
  result?: string;
  base_code?: string;
  rates?: Record<string, unknown>;
};

const FX_UPSTREAM_URL = 'https://open.er-api.com/v6/latest/INR';

/**
 * How long an instance keeps rates it read. The upstream updates once a day and
 * the fetch below is held in Next's data cache for an hour, so a quote here is at
 * most this much older than one read fresh.
 */
export const INR_FX_RATES_INSTANCE_TTL_MS = 5 * 60 * 1000;
/** A read still unanswered after this is not shared any more: the next quote reads again. */
const INR_FX_RATES_IN_FLIGHT_REUSE_MS = 2 * EXTERNAL_API_REQUEST_TIMEOUT_MS;

let held: { readAt: number; settled: boolean; rates: Promise<Record<string, number> | null> } | null = null;

async function readInrFxRates(failureEvent: string): Promise<Record<string, number> | null> {
  try {
    const response = await fetchWithProviderTimeout(FX_UPSTREAM_URL, {
      headers: {
        Accept: 'application/json',
      },
      next: {
        revalidate: 3600,
      },
    }, EXTERNAL_API_REQUEST_TIMEOUT_MS, fetch, 'FX rates');

    if (!response.ok) {
      throw new Error(`FX upstream error: ${response.status}`);
    }

    const payload = (await response.json()) as ExchangeRateApiResponse;
    if (
      payload?.result !== 'success' ||
      payload?.base_code !== 'INR' ||
      !payload?.rates ||
      typeof payload.rates !== 'object'
    ) {
      throw new Error('FX upstream returned unexpected payload');
    }

    const rates: Record<string, number> = {};
    for (const [currency, value] of Object.entries(payload.rates)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        rates[currency] = value;
      }
    }
    if (!hasPlausibleUsdInrRate(rates)) {
      throw new Error('FX upstream USD/INR rate is outside the accepted safety band');
    }

    return rates;
  } catch (error) {
    logBackendError(failureEvent, { error });
    return null;
  }
}

/**
 * INR-based rates (`rates.USD` is dollars per rupee), or null when they could not
 * be read; the caller then quotes in USD. `failureEvent` names the backend log
 * line of a failed read: callers sharing one read share its one line, under the
 * event of the caller that started it.
 */
export function getInrFxRates(
  failureEvent: string,
  now: () => number = Date.now,
): Promise<Record<string, number> | null> {
  const at = now();
  if (held) {
    const age = at - held.readAt;
    const reusable = held.settled ? age < INR_FX_RATES_INSTANCE_TTL_MS : age < INR_FX_RATES_IN_FLIGHT_REUSE_MS;
    if (reusable) return held.rates;
  }
  const rates = readInrFxRates(failureEvent);
  const entry = { readAt: at, settled: false, rates };
  held = entry;
  // A failed read is not kept, nor one that rejected: the next quote asks again.
  // The guard leaves a newer read that replaced this one alone.
  void rates.then(
    (value) => {
      entry.settled = true;
      if (value === null && held === entry) held = null;
    },
    () => {
      entry.settled = true;
      if (held === entry) held = null;
    },
  );
  return rates;
}

/** Tests only: forget what this instance read. */
export function resetInrFxRatesForTests(): void {
  held = null;
}
