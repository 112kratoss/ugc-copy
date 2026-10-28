import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { useQuotePrices } from '@/lib/use-quote-prices';
import { GENERATION_MODEL_QUOTE_BATCH_MAX } from '../../ugc-mobile/lib/model-catalog/protocol';

/**
 * The creators' price lists (`useQuotePrices`): many runs asked in one request to
 * `/api/generation-models/quotes`, each price kept for the page's life.
 */
const run = (duration: number, modelId = 'seedance-2-mini'): GenerationModelQuoteInput => ({
  schemaVersion: 2,
  kind: 'video',
  modelId,
  settings: { resolution: '480p', duration },
  catalogRevision: 'rev-1',
});

// A price per second of length: 4 credits a second, and a model called "refused" is refused.
function answer(body: { quotes: GenerationModelQuoteInput[] }) {
  return {
    quotes: body.quotes.map((quote) => (quote.modelId === 'refused'
      ? { ok: false, code: 'INVALID_MODEL_SETTINGS', error: 'No.', fieldErrors: {} }
      : { ok: true, quote: { modelId: quote.modelId, catalogRevision: 'rev-1', normalizedSettings: quote.settings, costCredits: 4 * Number(quote.settings?.duration) } })),
  };
}

const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
  ok: true,
  status: 200,
  json: async () => answer(JSON.parse(String(init?.body))),
}) as Response);

function askedLists() {
  return fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)).quotes as GenerationModelQuoteInput[])
    .map((quote) => `${quote.modelId}@${quote.settings?.duration}`));
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useQuotePrices', () => {
  it('asks for a list in one request, sending no token, and reads each run\'s price or refusal', async () => {
    const list = [run(4), run(5), run(5), run(6, 'refused')];
    const { result } = renderHook(() => useQuotePrices(list));
    expect(result.current(run(5))).toEqual({ status: 'pending' });

    await settle();

    expect(askedLists()).toEqual([['seedance-2-mini@4', 'seedance-2-mini@5', 'refused@6']]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generation-models/quotes');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    expect(result.current(run(5))).toEqual({ status: 'ready', costCredits: 20, normalizedSettings: { resolution: '480p', duration: 5 } });
    expect(result.current(run(6, 'refused'))).toEqual({ status: 'refused', code: 'INVALID_MODEL_SETTINGS', message: 'No.' });
    expect(result.current(null)).toEqual({ status: 'pending' });
  });

  it('asks only for what a new list adds, and gathers quick changes into one request', async () => {
    const { result, rerender } = renderHook(({ list }) => useQuotePrices(list), { initialProps: { list: [run(4), run(5)] } });
    await settle();

    rerender({ list: [run(5), run(6)] });
    rerender({ list: [run(5), run(6), run(7)] });
    await settle();

    expect(askedLists()).toEqual([
      ['seedance-2-mini@4', 'seedance-2-mini@5'],
      ['seedance-2-mini@6', 'seedance-2-mini@7'],
    ]);
    // An earlier list's price is still there for a later look.
    expect(result.current(run(4))).toMatchObject({ status: 'ready', costCredits: 16 });
  });

  it('splits a list longer than one request carries', async () => {
    const list = Array.from({ length: GENERATION_MODEL_QUOTE_BATCH_MAX + 2 }, (_, index) => run(index + 1));
    renderHook(() => useQuotePrices(list));
    await settle();

    expect(askedLists().map((asked) => asked.length)).toEqual([GENERATION_MODEL_QUOTE_BATCH_MAX, 2]);
  });

  it('shows no price for a list that failed, and asks again half a minute later', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 429, json: async () => ({ code: 'RATE_LIMITED' }) }) as Response);
    const { result } = renderHook(() => useQuotePrices([run(5)]));
    await settle();
    expect(result.current(run(5))).toEqual({ status: 'unavailable' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current(run(5))).toMatchObject({ status: 'ready', costCredits: 20 });
  });

  // A catalog that could not be read answers 200 with each run refused for now
  // (CATALOG_UNAVAILABLE), as a cache behind a new release refuses with CATALOG_CHANGED: those
  // runs are asked again, not kept as refused for the page's life.
  it.each(['CATALOG_UNAVAILABLE', 'CATALOG_CHANGED'])('asks again half a minute later for runs refused %s', async (code) => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ quotes: [{ ok: false, status: code === 'CATALOG_CHANGED' ? 409 : 503, code, error: 'Not now.', fieldErrors: {} }] }),
    }) as Response);
    const { result } = renderHook(() => useQuotePrices([run(5)]));
    await settle();
    expect(result.current(run(5))).toEqual({ status: 'unavailable' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current(run(5))).toMatchObject({ status: 'ready', costCredits: 20 });
  });

  it('prices a list under development\'s double mount', async () => {
    const { result } = renderHook(() => useQuotePrices([run(5)]), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    await settle();

    expect(result.current(run(5))).toMatchObject({ status: 'ready', costCredits: 20 });
  });
});
