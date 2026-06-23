import 'server-only';

import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';

const UPSTREAM_URL = 'https://open.er-api.com/v6/latest/INR';

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'] as const;
type SupportedFxCurrency = (typeof SUPPORTED_CURRENCIES)[number];

type ExchangeRateApiResponse = {
  result?: string;
  base_code?: string;
  time_last_update_utc?: string;
  rates?: Record<string, unknown>;
};

export type FxRatesRouteResult =
  | {
      ok: true;
      body: {
        base: 'INR';
        updatedAt: string;
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
    if (typeof value === 'number' && Number.isFinite(value)) {
      picked[currency] = value;
    }
  }

  return picked;
}

function normalizeFxPayload(payload: ExchangeRateApiResponse): FxRatesRouteResult {
  if (
    payload?.result !== 'success' ||
    payload?.base_code !== 'INR' ||
    !payload?.rates ||
    typeof payload.rates !== 'object'
  ) {
    throw new Error('FX upstream returned unexpected payload');
  }

  return {
    ok: true,
    body: {
      base: 'INR',
      updatedAt: typeof payload.time_last_update_utc === 'string'
        ? payload.time_last_update_utc
        : new Date().toUTCString(),
      rates: pickSupportedRates(payload.rates),
    },
  };
}

export async function loadFxRatesForRoute({
  fetchImpl = fetch,
}: {
  fetchImpl?: typeof fetch;
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

    return normalizeFxPayload((await upstreamResponse.json()) as ExchangeRateApiResponse);
  } catch (error) {
    console.error('FX route error:', error);
    return {
      ok: false,
      status: 503,
      body: { error: 'fx_unavailable' },
    };
  }
}
