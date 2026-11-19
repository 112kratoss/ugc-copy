import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWithProviderTimeout: vi.fn(),
  logBackendError: vi.fn(),
}));
vi.mock('@/lib/provider-fetch', () => ({
  EXTERNAL_API_REQUEST_TIMEOUT_MS: 5_000,
  fetchWithProviderTimeout: mocks.fetchWithProviderTimeout,
}));
vi.mock('@/lib/backend-logger', () => ({ logBackendError: mocks.logBackendError }));

import {
  INR_FX_RATES_INSTANCE_TTL_MS,
  getInrFxRates,
  resetInrFxRatesForTests,
} from '@/lib/inr-fx-rates-server';

// 1 INR = 0.0118 USD, inside the accepted USD/INR band.
const RATES = { INR: 1, USD: 0.0118, EUR: 0.0109 };

function answer(body: unknown, init: { status?: number } = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: init.status ?? 200 }));
}

describe('INR exchange rates, read once per instance', () => {
  beforeEach(() => {
    resetInrFxRatesForTests();
    mocks.fetchWithProviderTimeout.mockReset();
    mocks.logBackendError.mockReset();
  });
  afterEach(() => resetInrFxRatesForTests());

  it('shares one read between the quotes of one page, so the attempt is counted once', async () => {
    mocks.fetchWithProviderTimeout.mockImplementation(() => answer({ result: 'success', base_code: 'INR', rates: RATES }));
    const quotes = await Promise.all(Array.from({ length: 10 }, () => getInrFxRates('caller_failed')));
    expect(quotes.every((rates) => rates?.USD === 0.0118)).toBe(true);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledWith(
      'https://open.er-api.com/v6/latest/INR',
      expect.objectContaining({ next: { revalidate: 3600 } }),
      5_000,
      fetch,
      'FX rates',
    );
  });

  it('keeps the rates for the instance TTL and reads again after it', async () => {
    mocks.fetchWithProviderTimeout.mockImplementation(() => answer({ result: 'success', base_code: 'INR', rates: RATES }));
    let clock = 1_000_000;
    const now = () => clock;
    await getInrFxRates('caller_failed', now);
    clock += INR_FX_RATES_INSTANCE_TTL_MS - 1;
    await getInrFxRates('caller_failed', now);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(1);
    clock += 1;
    await getInrFxRates('caller_failed', now);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read, and logs it under the caller event', async () => {
    mocks.fetchWithProviderTimeout
      .mockImplementationOnce(() => answer({}, { status: 503 }))
      .mockImplementation(() => answer({ result: 'success', base_code: 'INR', rates: RATES }));
    await expect(getInrFxRates('marketplace_fx_rates_load_failed')).resolves.toBeNull();
    expect(mocks.logBackendError).toHaveBeenCalledWith('marketplace_fx_rates_load_failed', { error: expect.any(Error) });
    await expect(getInrFxRates('marketplace_fx_rates_load_failed')).resolves.toEqual(RATES);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(2);
  });

  it('gives every quote sharing a failed read null, then reads again', async () => {
    mocks.fetchWithProviderTimeout
      .mockImplementationOnce(() => answer({}, { status: 502 }))
      .mockImplementation(() => answer({ result: 'success', base_code: 'INR', rates: RATES }));
    const shared = await Promise.all([getInrFxRates('caller_failed'), getInrFxRates('caller_failed'), getInrFxRates('caller_failed')]);
    expect(shared).toEqual([null, null, null]);
    expect(mocks.logBackendError).toHaveBeenCalledTimes(1);
    await expect(getInrFxRates('caller_failed')).resolves.toEqual(RATES);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(2);
  });

  it('leaves a newer read alone when an older one fails after being replaced', async () => {
    let failOld: (response: Response) => void = () => {};
    mocks.fetchWithProviderTimeout
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { failOld = resolve; }))
      .mockImplementation(() => answer({ result: 'success', base_code: 'INR', rates: RATES }));
    let clock = 0;
    const now = () => clock;
    const old = getInrFxRates('caller_failed', now);
    // Unanswered past the in-flight limit: the next quote starts its own read.
    clock += 10_001;
    await expect(getInrFxRates('caller_failed', now)).resolves.toEqual(RATES);
    failOld(new Response('{}', { status: 503 }));
    await expect(old).resolves.toBeNull();
    // The newer read is still the one kept.
    await expect(getInrFxRates('caller_failed', now)).resolves.toEqual(RATES);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(2);
  });

  it('does not share a read that never answers past twice the request timeout', async () => {
    mocks.fetchWithProviderTimeout
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockImplementation(() => answer({ result: 'success', base_code: 'INR', rates: RATES }));
    let clock = 0;
    const now = () => clock;
    void getInrFxRates('caller_failed', now);
    clock += 9_999;
    void getInrFxRates('caller_failed', now);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(1);
    clock += 2;
    await expect(getInrFxRates('caller_failed', now)).resolves.toEqual(RATES);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(2);
  });

  it('does not keep a read that rejected, and reads again', async () => {
    mocks.fetchWithProviderTimeout
      .mockImplementationOnce(() => answer({}, { status: 500 }))
      .mockImplementation(() => answer({ result: 'success', base_code: 'INR', rates: RATES }));
    // A logger that throws turns the failed read into a rejection.
    mocks.logBackendError.mockImplementationOnce(() => { throw new Error('logger down'); });
    await expect(getInrFxRates('caller_failed')).rejects.toThrow('logger down');
    await expect(getInrFxRates('caller_failed')).resolves.toEqual(RATES);
    expect(mocks.fetchWithProviderTimeout).toHaveBeenCalledTimes(2);
  });

  it('refuses a USD/INR rate outside the safety band, and malformed answers', async () => {
    mocks.fetchWithProviderTimeout.mockImplementationOnce(() => answer({ result: 'success', base_code: 'INR', rates: { USD: 5 } }));
    await expect(getInrFxRates('caller_failed')).resolves.toBeNull();
    mocks.fetchWithProviderTimeout.mockImplementationOnce(() => answer({ result: 'success', base_code: 'USD', rates: RATES }));
    await expect(getInrFxRates('caller_failed')).resolves.toBeNull();
    mocks.fetchWithProviderTimeout.mockImplementationOnce(() => Promise.reject(new Error('socket hang up')));
    await expect(getInrFxRates('caller_failed')).resolves.toBeNull();
    expect(mocks.logBackendError).toHaveBeenCalledTimes(3);
  });
});
