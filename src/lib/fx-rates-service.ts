import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';
import { hasPlausibleUsdInrRate } from '@/lib/currency';

const UPSTREAM_URL = 'https://open.er-api.com/v6/latest/INR';

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'] as const;
type SupportedFxCurrency = (typeof SUPPORTED_CURRENCIES)[number];

type ExchangeRateApiResponse = {
  result?: string;
  base_code?: string;
  /** An RFC 2822 date, "Mon, 16 Nov 2026 00:02:31 +0000". */
  time_last_update_utc?: unknown;
  rates?: Record<string, unknown>;
};

export type FxRatesRouteResult =
  | {
      ok: true;
      body: {
        base: 'INR';
        /**
         * When the rates were updated: an ISO 8601 stamp in UTC, "2026-11-16T00:02:31.000Z". Left
         * out for a provider stamp that cannot be read, and Pricing then says no time.
         */
        updatedAt?: string;
        rates: Record<SupportedFxCurrency, number>;
      };
    }
  | {
      ok: false;
      status: 503;
      body: { error: 'fx_unavailable' };
    };

function pickSupportedRates(rates: Record<string, unknown>) {
  const picked: Record<SupportedFxCurrency, number> = {} as never;

  for (const currency of SUPPORTED_CURRENCIES) {
    const value = rates[currency];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error('FX upstream returned an invalid supported currency rate');
    }
    picked[currency] = value;
  }

  return picked;
}

/**
 * When the provider last updated its rates, as an ISO 8601 stamp in UTC, so every client reads one
 * well-defined format: open.er-api.com sends `time_last_update_utc` as an RFC 2822 date, which the
 * route passed on as it came until 2026-11-17. As then, a stamp not sent as text gives the time
 * the route read the rates. One sent that cannot be read gives none (null): Pricing showed no time
 * for it then, and its read time would claim the rates were updated when they were only read.
 */
function toIsoUpdatedAt(providerStamp: unknown, now: () => Date): string | null {
  if (typeof providerStamp !== 'string') return now().toISOString();
  const timestamp = Date.parse(providerStamp);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeFxPayload(payload: ExchangeRateApiResponse, now: () => Date): FxRatesRouteResult {
  if (
    payload?.result !== 'success' ||
    payload?.base_code !== 'INR' ||
    !payload?.rates ||
    typeof payload.rates !== 'object'
  ) {
    throw new Error('FX upstream returned unexpected payload');
  }

  const rates = pickSupportedRates(payload.rates);
  if (!hasPlausibleUsdInrRate(rates)) {
    throw new Error('FX upstream USD/INR rate is outside the accepted safety band');
  }

  const updatedAt = toIsoUpdatedAt(payload.time_last_update_utc, now);
  return {
    ok: true,
    body: {
      base: 'INR',
      ...(updatedAt ? { updatedAt } : {}),
      rates,
    },
  };
}

export async function loadFxRatesForRoute({
  fetchImpl = fetch,
  now = () => new Date(),
}: {
  fetchImpl?: typeof fetch;
  /** The clock, for the time the rates were read when the provider gives none it can read. */
  now?: () => Date;
} = {}): Promise<FxRatesRouteResult> {
  try {
    const upstreamResponse = await fetchWithProviderTimeout(
      UPSTREAM_URL,
      {
        headers: {
          Accept: 'application/json',
        },
      },
      EXTERNAL_API_REQUEST_TIMEOUT_MS,
      fetchImpl,
      'FX rates',
    );

    if (!upstreamResponse.ok) {
      throw new Error(`FX upstream error: ${upstreamResponse.status}`);
    }

    return normalizeFxPayload((await upstreamResponse.json()) as ExchangeRateApiResponse, now);
  } catch (error) {
    logBackendError('fx_route_error', { error: error });
    return {
      ok: false,
      status: 503,
      body: { error: 'fx_unavailable' },
    };
  }
}
