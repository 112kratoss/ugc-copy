import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { useCreatorQuote } from '@/lib/use-creator-quote';
import { catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';

/**
 * useCreatorQuote over the real quote hook (useWebGenerationModelQuote), where the page tests
 * and the hook's own use a stand-in that answers in the render it is asked in. The real hook
 * waits 200 ms, then fetches, and holds no price while it asks: its answer is keyed on the
 * attempt as well as the request. That is all that makes the price read against a refusal
 * the price asked again, never the refused one: a hook that kept showing its last price while
 * it asked would have the page judge the refused price itself.
 */

type Asked = { body: GenerationModelQuoteInput; authorization: string | null; answer: (costCredits: number) => Promise<void> };
let asked: Asked[] = [];

const run: CatalogGenerationRequestPayload = {
  kind: 'image',
  modelId: 'nano-banana-2',
  catalogRevision: 'rev-1',
  settings: { aspectRatio: 'auto' },
  prompt: 'A lighthouse at dawn',
  inputs: [],
};
const request: GenerationModelQuoteInput = catalogRunQuoteInput({ ...run, inputs: [] });

beforeEach(() => {
  vi.useFakeTimers();
  asked = [];
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
    const body = JSON.parse(String(init?.body)) as GenerationModelQuoteInput;
    asked.push({
      body,
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
      answer: async (costCredits) => {
        await act(async () => {
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ modelId: body.modelId, catalogRevision: body.catalogRevision, normalizedSettings: {}, costCredits }),
          } as Response);
          // The hook reads the answer a few promise steps later.
          for (let step = 0; step < 5; step += 1) await Promise.resolve();
        });
      },
    });
  })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets the hook's 200 ms wait pass, so it sends what it waits to ask. */
async function letItAsk() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe('useCreatorQuote over the real quote hook', () => {
  it('holds no price while it asks again after a refusal, and reads the price that comes back', async () => {
    const { result } = renderHook(() => useCreatorQuote(request, 'token-1'));
    await letItAsk();
    await asked[0].answer(8);
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: false });

    act(() => result.current.costChanged({ ...run, expectedCostCredits: 8 }));

    // Asking again: no price is held, so nothing is read against the refusal yet.
    expect(result.current).toMatchObject({ status: 'pending', quote: null, pageOutOfDate: false });
    await letItAsk();
    expect(asked).toHaveLength(2);
    expect(result.current).toMatchObject({ status: 'pending', quote: null, pageOutOfDate: false });

    await asked[1].answer(8);
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: true });
  });

  it('forgets a refusal once the price asked again has moved, and a refreshed session back at the old price holds nothing', async () => {
    const { result, rerender } = renderHook(({ token }) => useCreatorQuote(request, token), { initialProps: { token: 'token-1' } });
    await letItAsk();
    await asked[0].answer(8);
    act(() => result.current.costChanged({ ...run, expectedCostCredits: 8 }));
    await letItAsk();
    await asked[1].answer(10);
    expect(result.current).toMatchObject({ quote: { costCredits: 10 }, pageOutOfDate: false });

    // The session refreshes, so the run is asked again, and its price is back where the
    // start refused it (a rollback): the start would take it.
    rerender({ token: 'token-2' });
    await letItAsk();
    expect(asked[2].authorization).toBe('Bearer token-2');
    await asked[2].answer(8);

    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: false });
  });
});
