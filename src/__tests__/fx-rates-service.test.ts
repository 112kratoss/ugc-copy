import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadFxRatesForRoute } from '@/lib/fx-rates-service';

describe('loadFxRatesForRoute', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches INR rates with provider timeout and keeps only supported finite currencies', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: 'success',
        base_code: 'INR',
        time_last_update_utc: 'Sat, 04 Apr 2026 00:02:31 +0000',
        rates: {
          USD: 0.0119,
          EUR: 0.011,
          GBP: 0.0094,
          AUD: 0.0184,
          CAD: 0.0161,
          SGD: 0.016,
          JPY: 1.7,
          AED: 'not-a-number',
        },
      }),
    } as Response));

    const result = await loadFxRatesForRoute({ fetchImpl });

    expect(result).toEqual({
      ok: true,
      body: {
        base: 'INR',
        updatedAt: 'Sat, 04 Apr 2026 00:02:31 +0000',
        rates: {
          USD: 0.0119,
          EUR: 0.011,
          GBP: 0.0094,
          AUD: 0.0184,
          CAD: 0.0161,
          SGD: 0.016,
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://open.er-api.com/v6/latest/INR',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
        signal: timeoutSignal,
      }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  it('returns a stable unavailable result for upstream failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 } as Response));

    const result = await loadFxRatesForRoute({ fetchImpl });

    expect(result).toEqual({
      ok: false,
      status: 503,
      body: { error: 'fx_unavailable' },
    });
  });

  it('returns a stable unavailable result for unexpected upstream payloads', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: 'success',
        base_code: 'USD',
        rates: { INR: 1 },
      }),
    } as Response));

    const result = await loadFxRatesForRoute({ fetchImpl });

    expect(result).toEqual({
      ok: false,
      status: 503,
      body: { error: 'fx_unavailable' },
    });
  });
});
