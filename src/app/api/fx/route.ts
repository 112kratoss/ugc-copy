import { NextResponse } from 'next/server';

const UPSTREAM_URL = 'https://open.er-api.com/v6/latest/INR';
const CACHE_CONTROL_SUCCESS = 'public, s-maxage=3600, stale-while-revalidate=86400';

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'] as const;
type SupportedFxCurrency = (typeof SUPPORTED_CURRENCIES)[number];

type ExchangeRateApiResponse = {
  result?: string;
  base_code?: string;
  time_last_update_utc?: string;
  rates?: Record<string, unknown>;
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

export async function GET(_req: Request) {
  try {
    const upstreamResponse = await fetch(UPSTREAM_URL, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!upstreamResponse.ok) {
      throw new Error(`FX upstream error: ${upstreamResponse.status}`);
    }

    const payload = (await upstreamResponse.json()) as ExchangeRateApiResponse;

    if (
      payload?.result !== 'success' ||
      payload?.base_code !== 'INR' ||
      !payload?.rates ||
      typeof payload.rates !== 'object'
    ) {
      throw new Error('FX upstream returned unexpected payload');
    }

    const updatedAt =
      typeof payload.time_last_update_utc === 'string'
        ? payload.time_last_update_utc
        : new Date().toUTCString();

    return NextResponse.json(
      {
        base: 'INR',
        updatedAt,
        rates: pickSupportedRates(payload.rates),
      },
      {
        headers: {
          'Cache-Control': CACHE_CONTROL_SUCCESS,
        },
      }
    );
  } catch (error) {
    console.error('FX route error:', error);
    return NextResponse.json(
      { error: 'fx_unavailable' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  }
}

