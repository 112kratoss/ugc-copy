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
 * which is not kept.
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
export const INR_FX_RATES_INSTANCE_TTL_MS = 10 * 60 * 1000;

let held: { readAt: number; rates: Promise<Record<string, number> | null> } | null = null;

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
 * line of a failed read, so each caller keeps its own.
 */
export function getInrFxRates(
  failureEvent: string,
  now: () => number = Date.now,
): Promise<Record<string, number> | null> {
  const at = now();
  if (held && at - held.readAt < INR_FX_RATES_INSTANCE_TTL_MS) return held.rates;
  const rates = readInrFxRates(failureEvent);
  const entry = { readAt: at, rates };
  held = entry;
  // A failed read is not kept: the next quote asks again.
  void rates.then((value) => {
    if (value === null && held === entry) held = null;
  });
  return rates;
}

/** Tests only: forget what this instance read. */
export function resetInrFxRatesForTests(): void {
  held = null;
}
