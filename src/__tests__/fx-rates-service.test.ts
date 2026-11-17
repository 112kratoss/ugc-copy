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
        // The provider's RFC 2822 stamp, in ISO 8601.
        updatedAt: '2026-04-04T00:02:31.000Z',
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

  // The route passed open.er-api.com's `time_last_update_utc` on as it came, an RFC 2822 date
  // ("Mon, 16 Nov 2026 00:02:31 +0000"), until 2026-11-17: clients now read one format, ISO 8601.
  describe('the time the rates were updated', () => {
    const READ_AT = new Date('2026-11-17T09:30:00.000Z');
    const answerWith = (stamp: Record<string, unknown>) => vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: 'success',
        base_code: 'INR',
        ...stamp,
        rates: { USD: 0.0119, EUR: 0.011, GBP: 0.0094, AUD: 0.0184, CAD: 0.0161, SGD: 0.016 },
      }),
    } as Response));
    const updatedAt = async (stamp: Record<string, unknown>) => {
      const result = await loadFxRatesForRoute({ fetchImpl: answerWith(stamp), now: () => READ_AT });
      if (!result.ok) throw new Error('the rates were refused');
      return result.body.updatedAt;
    };

    it("says the provider's stamp in UTC, in ISO 8601, whatever offset it was written with", async () => {
      await expect(updatedAt({ time_last_update_utc: 'Mon, 16 Nov 2026 00:02:31 +0000' })).resolves.toBe('2026-11-16T00:02:31.000Z');
      await expect(updatedAt({ time_last_update_utc: 'Mon, 16 Nov 2026 05:32:31 +0530' })).resolves.toBe('2026-11-16T00:02:31.000Z');
      await expect(updatedAt({ time_last_update_utc: 'Mon, 16 Nov 2026 00:02:31 GMT' })).resolves.toBe('2026-11-16T00:02:31.000Z');
    });

    it('says when the route read the rates, in ISO 8601, for a stamp it does not send or that cannot be read', async () => {
      await expect(updatedAt({})).resolves.toBe('2026-11-17T09:30:00.000Z');
      await expect(updatedAt({ time_last_update_utc: 'sometime yesterday' })).resolves.toBe('2026-11-17T09:30:00.000Z');
      await expect(updatedAt({ time_last_update_utc: '' })).resolves.toBe('2026-11-17T09:30:00.000Z');
      await expect(updatedAt({ time_last_update_utc: 1_763_251_351 })).resolves.toBe('2026-11-17T09:30:00.000Z');
    });
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

  it('fails closed when the upstream USD/INR rate is outside the safety band', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: 'success',
        base_code: 'INR',
        rates: {
          USD: 0.05,
          EUR: 0.04,
          GBP: 0.03,
          AUD: 0.08,
          CAD: 0.07,
          SGD: 0.06,
        },
      }),
    } as Response));

    await expect(loadFxRatesForRoute({ fetchImpl })).resolves.toEqual({
      ok: false,
      status: 503,
      body: { error: 'fx_unavailable' },
    });
  });
});
